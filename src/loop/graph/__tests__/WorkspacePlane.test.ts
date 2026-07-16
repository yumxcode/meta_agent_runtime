import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  createDefaultGraphRuntimeCatalog,
  freezeLoopGraph,
  GraphKernel,
  GraphStore,
  validateLoopGraph,
  type GraphAgentExecutionRequest,
  type LoopGraphSpec,
} from '../index.js'

const roots: string[] = []
const exec = promisify(execFile)
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('generic Workspace Plane bindings', () => {
  it('injects an explicitly selected workspace binding and leaves unnamed files out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-workspace-input-'))
    roots.push(root)
    await writeFile(join(root, 'objective.md'), '# Goal\nWalk reliably.', 'utf8')
    await writeFile(join(root, 'secret.md'), 'must not be injected', 'utf8')
    const graph: LoopGraphSpec = {
      schemaVersion: 'graph-1.0', id: 'workspace-input', version: 1, goal: 'Read declared input only',
      state: {},
      lanes: { work: { context: 'persistent', workspace: 'readonly', maxConcurrency: 1 } },
      workspaceBindings: {
        objective: { plane: 'input', path: 'objective.md', format: 'markdown', direction: 'ingest', required: true },
      },
      nodes: {
        work: {
          type: 'agent', lane: 'work', prompt: 'Use the objective.',
          context: { sections: [{
            name: 'objective', provider: 'builtin/workspace-binding@1', refresh: 'activation_start',
            config: { binding: 'objective' }, maxBytes: 4096,
          }] },
        },
        done: { type: 'terminal', status: 'done' },
        failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'done', from: 'work', to: 'done' },
        { id: 'failed', from: 'work', on: 'failure', to: 'failed' },
      ],
      entrypoints: [{ id: 'start', node: 'work' }],
      limits: { maxActivations: 3 },
    }
    const catalog = createDefaultGraphRuntimeCatalog()
    const frozen = freezeLoopGraph(graph, catalog, 1)
    const store = await GraphStore.create({ projectDir: root, graph: frozen, functions: catalog.functions, now: 1 })
    let request: GraphAgentExecutionRequest | undefined
    const kernel = await GraphKernel.open({
      store, graph: frozen, ...catalog, now: () => 2,
      graphAgent: {
        id: 'test/workspace-agent@1',
        async execute(input) {
          request = input
          return { kind: 'completed', taskId: 'task', success: true, output: {}, summary: 'ok' }
        },
      },
    })
    await kernel.tick()
    expect(request?.prompt.user).toContain('Walk reliably.')
    expect(request?.prompt.user).toContain('"plane": "input"')
    expect(request?.prompt.user).toContain('"trust": "untrusted_data"')
    expect(request?.prompt.user).not.toContain('must not be injected')
  })

  it('hydrates State once and rebuilds State, Evidence, and Audit projections after file loss', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-workspace-projection-'))
    roots.push(root)
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'state/progress.json'), JSON.stringify({ count: 4 }), 'utf8')
    const graph: LoopGraphSpec = {
      schemaVersion: 'graph-1.0', id: 'workspace-projection', version: 1, goal: 'Project generic planes',
      state: { count: { type: { type: 'integer', minimum: 0 }, initial: 0 } },
      lanes: {},
      nodes: {
        work: {
          type: 'function', function: 'builtin/identity@1', inputs: { claim: { literal: 'finding-a' } },
          publishes: [{ channel: 'proof', value: { ref: '$output' } }],
        },
        done: { type: 'terminal', status: 'done' },
      },
      transitions: [
        { id: 'next', from: 'work', updates: [{ target: 'count', reducer: 'builtin/increment@1' }], to: 'done' },
        { id: 'failed', from: 'work', on: 'failure', to: 'done' },
      ],
      entrypoints: [{ id: 'start', node: 'work' }],
      artifacts: { proof: { kind: 'evidence', admission: 'automatic', maxItems: 10 } },
      evidenceViews: { accepted: { channels: ['proof'], statuses: ['admitted'], maxItems: 10 } },
      workspaceBindings: {
        progress: {
          plane: 'state_projection', path: 'state/progress.json', format: 'json', direction: 'materialize',
          projection: { kind: 'state', keys: ['count'] }, initializeState: 'workspace_if_present', required: true,
        },
        findings: {
          plane: 'evidence', path: 'state/findings.jsonl', format: 'jsonl', direction: 'materialize', appendOnly: true,
          projection: { kind: 'evidence_view', view: 'accepted', record: 'content' }, required: true,
        },
        audit: {
          plane: 'audit', path: 'state/audit.jsonl', format: 'jsonl', direction: 'materialize', appendOnly: true,
          projection: { kind: 'journal', eventTypes: ['activation_committed'], record: 'envelope' }, required: true,
        },
      },
      limits: { maxActivations: 3 },
    }
    const catalog = createDefaultGraphRuntimeCatalog()
    expect(validateLoopGraph(graph, catalog)).toEqual([])
    const frozen = freezeLoopGraph(graph, catalog, 1)
    const store = await GraphStore.create({ projectDir: root, graph: frozen, functions: catalog.functions, now: 1 })
    expect((await store.snapshot()).state.values.count).toBe(4)
    const kernel = await GraphKernel.open({ store, graph: frozen, ...catalog, now: () => 2 })
    expect((await kernel.tick()).committed).toBe(1)
    expect(JSON.parse(await readFile(join(root, 'state/progress.json'), 'utf8'))).toEqual({ count: 5 })
    expect((await readFile(join(root, 'state/findings.jsonl'), 'utf8')).trim()).toBe('{"claim":"finding-a"}')
    expect((await readFile(join(root, 'state/audit.jsonl'), 'utf8')).trim()).toContain('activation_committed')

    await unlink(join(root, 'state/progress.json'))
    await unlink(join(root, 'state/findings.jsonl'))
    await GraphKernel.open({ store, graph: frozen, ...catalog, now: () => 3 })
    expect(JSON.parse(await readFile(join(root, 'state/progress.json'), 'utf8'))).toEqual({ count: 5 })
    expect((await readFile(join(root, 'state/findings.jsonl'), 'utf8')).trim()).toBe('{"claim":"finding-a"}')
  })

  it('materializes into a declared Lane overlay and merges the projection at terminal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-workspace-lane-'))
    roots.push(root)
    await exec('git', ['init', '-q'], { cwd: root })
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
    await exec('git', ['config', 'user.name', 'Test'], { cwd: root })
    await writeFile(join(root, 'README.md'), 'seed\n', 'utf8')
    await exec('git', ['add', 'README.md'], { cwd: root })
    await exec('git', ['commit', '-qm', 'seed'], { cwd: root })
    const graph: LoopGraphSpec = {
      schemaVersion: 'graph-1.0', id: 'lane-projection', version: 1, goal: 'Project to one Lane',
      state: { count: { type: { type: 'integer' }, initial: 0 } },
      lanes: { work: { context: 'persistent', workspace: 'lane_overlay', maxConcurrency: 1 } },
      workspaceBindings: {
        progress: {
          plane: 'state_projection', path: 'state/progress.json', format: 'json', direction: 'materialize',
          lane: 'work', projection: { kind: 'state', keys: ['count'] }, required: true,
        },
      },
      nodes: {
        work: { type: 'agent', lane: 'work', prompt: 'Return success.', writes: ['scratch'] },
        done: { type: 'terminal', status: 'done' },
        failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'done', from: 'work', updates: [{ target: 'count', reducer: 'builtin/increment@1' }], to: 'done' },
        { id: 'failed', from: 'work', on: 'failure', to: 'failed' },
      ],
      entrypoints: [{ id: 'start', node: 'work' }], limits: { maxActivations: 3 },
    }
    const catalog = createDefaultGraphRuntimeCatalog()
    const frozen = freezeLoopGraph(graph, catalog, 1)
    const store = await GraphStore.create({ projectDir: root, graph: frozen, functions: catalog.functions, now: 1 })
    let request: GraphAgentExecutionRequest | undefined
    const kernel = await GraphKernel.open({
      store, graph: frozen, ...catalog, now: () => 2,
      graphAgent: {
        id: 'test/lane-agent@1',
        async execute(input) { request = input; return { kind: 'completed', taskId: 'task', success: true, output: {}, summary: 'ok' } },
      },
    })
    await kernel.tick()
    expect(request?.workspace.writeDenyPaths.some(path => path.endsWith('state/progress.json'))).toBe(true)
    await kernel.tick()
    expect(JSON.parse(await readFile(join(root, 'state/progress.json'), 'utf8'))).toEqual({ count: 1 })
  })

  it('rejects reserved paths and incompatible plane projections without affecting graphs that omit bindings', () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    const base: LoopGraphSpec = {
      schemaVersion: 'graph-1.0', id: 'optional-bindings', version: 1, goal: 'Remain optional', state: {}, lanes: {},
      nodes: { work: { type: 'function', function: 'builtin/identity@1' }, done: { type: 'terminal', status: 'done' } },
      transitions: [{ id: 'done', from: 'work', to: 'done' }, { id: 'failed', from: 'work', on: 'failure', to: 'done' }],
      entrypoints: [{ id: 'start', node: 'work' }], limits: { maxActivations: 2 },
    }
    expect(validateLoopGraph(base, catalog)).toEqual([])
    base.workspaceBindings = {
      bad: {
        plane: 'state_projection', path: '.loop/state.json', format: 'jsonl', direction: 'materialize',
        projection: { kind: 'evidence_view', view: 'missing' },
      },
    }
    const errors = validateLoopGraph(base, catalog).join('\n')
    expect(errors).toContain('non-reserved')
    expect(errors).toContain("state_projection must use format 'json'")
    expect(errors).toContain('requires a state projection')
  })
})
