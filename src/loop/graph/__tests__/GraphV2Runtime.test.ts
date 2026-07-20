import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CapabilityRegistry, CommitCoordinator, createBuiltinFunctionRegistry, createBuiltinReducerRegistry,
  freezeLoopGraph, GraphKernel, GraphStore,
  type EffectProvider, type GraphAgentExecutionRequest, type LoopGraphSpec,
} from '../index.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function capabilities() {
  return {
    functions: createBuiltinFunctionRegistry(), reducers: createBuiltinReducerRegistry(), effects: new CapabilityRegistry<EffectProvider>('effect'),
    agentTools: new Set(['read_file', 'write_file', 'append_file', 'edit_file', 'grep', 'glob', 'bash']),
  }
}
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'graph-v2-')); roots.push(value); return value }

function agentGraph(): LoopGraphSpec {
  return {
    schemaVersion: 'graph-2.0', id: 'direct_workspace', version: 1, goal: 'Run one workspace Agent.', state: {},
    lanes: { work: { context: 'persistent', workspace: { read: ['requirements.md'], write: [{ path: 'state', mode: 'owned' }], deny: ['.git'] } } },
    nodes: { work: { type: 'agent', lane: 'work', prompt: 'Do the work.', tools: ['read_file', 'write_file'] }, done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' } },
    transitions: [{ id: 'done', from: 'work', to: 'done' }, { id: 'failed', from: 'work', on: 'failure', to: 'failed' }],
    entrypoints: [{ id: 'start', node: 'work' }], limits: { maxActivations: 3 },
  }
}

describe('durable-graph-v2 runtime', () => {
  it('runs every Lane on the project root and passes its direct write scope to graph_agent', async () => {
    const projectDir = await root(); const caps = capabilities(); const graph = freezeLoopGraph(agentGraph(), caps, 1)
    const store = await GraphStore.create({ projectDir, instanceId: 'direct', graph, functions: caps.functions, now: 1 })
    let request: GraphAgentExecutionRequest | undefined
    const kernel = await GraphKernel.open({
      store, graph, ...caps, owner: 'test',
      graphAgent: { id: 'test', async execute(value) { request = value; return { kind: 'completed', taskId: 't', success: true, output: {}, summary: 'workspace work completed', usage: { turns: 1, costUsd: 0, durationMs: 1 } } } },
    })
    await kernel.tick()
    expect(request?.workspace.projectDir).toBe(projectDir)
    expect(request?.workspace.mode).toBe('shared_write')
    expect(request?.workspace.writeAllowPaths).toEqual([join(projectDir, 'state')])
    expect(request?.workspace.writeDenyPaths).toContain(join(projectDir, '.git'))
    expect(request?.prompt.user).toContain('append_only')
    expect(store.paths).not.toHaveProperty('artifactsDir')
    expect((await kernel.tick()).instance.status).toBe('done')
  })

  it('opens .git for a scm lane while keeping hooks and config protected', async () => {
    const projectDir = await root(); const caps = capabilities()
    const spec = agentGraph()
    spec.lanes.work!.scm = 'git'
    spec.lanes.work!.workspace.deny = []
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir, instanceId: 'scm-git', graph, functions: caps.functions, now: 1 })
    let request: GraphAgentExecutionRequest | undefined
    const kernel = await GraphKernel.open({
      store, graph, ...caps, owner: 'test',
      graphAgent: { id: 'test', async execute(value) { request = value; return { kind: 'completed', taskId: 't', success: true, output: {}, summary: 'committed', usage: { turns: 1, costUsd: 0, durationMs: 1 } } } },
    })
    await kernel.tick()
    expect(request?.workspace.writeAllowPaths).toContain(join(projectDir, '.git'))
    expect(request?.workspace.writeDenyPaths).toContain(join(projectDir, '.git', 'hooks'))
    expect(request?.workspace.writeDenyPaths).toContain(join(projectDir, '.git', 'config'))
    expect(request?.workspace.writeDenyPaths).not.toContain(join(projectDir, '.git'))
    expect(request?.workspace.writeDenyPaths).toContain(join(projectDir, '.loop'))
    expect(request?.workspace.writeDenyPaths).toContain(join(projectDir, '.meta-agent'))
  })

  it('fails before execution when a frozen graph_agent tool is missing at Runtime', async () => {
    const projectDir = await root(); const caps = capabilities(); const graph = freezeLoopGraph(agentGraph(), caps, 1)
    const store = await GraphStore.create({ projectDir, instanceId: 'missing-tool', graph, functions: caps.functions, now: 1 })
    await expect(GraphKernel.open({
      store, graph, ...caps, agentTools: new Set(['read_file']),
      graphAgent: { id: 'never', async execute() { throw new Error('must not execute') } },
    })).rejects.toThrow("graph_agent tool capability mismatch or missing for 'write_file'")
  })

  it('commits deterministic routing exactly once and recovers a prepared commit', async () => {
    const projectDir = await root(); const caps = capabilities()
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'recover', version: 1, goal: 'Recover.',
      state: { count: { type: { type: 'integer', minimum: 0 }, initial: 0 } }, lanes: {},
      nodes: { step: { type: 'function', function: 'builtin/identity@1' }, done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' } },
      transitions: [
        { id: 'again', from: 'step', when: '$state.count < 1', priority: 10, updates: [{ target: 'count', reducer: 'builtin/increment@1' }], to: 'step' },
        { id: 'finish', from: 'step', default: true, to: 'done' },
        { id: 'fail', from: 'step', on: 'failure', to: 'failed' },
      ], entrypoints: [{ id: 'start', node: 'step' }], limits: { maxActivations: 5 },
    }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir, instanceId: 'recover', graph, functions: caps.functions, now: 1 })
    const coordinator = new CommitCoordinator(store, graph, caps.functions, caps.reducers)
    const activation = (await store.claimReady({ owner: 'dead', now: 2, ttlMs: 1 }))[0]!
    await store.prepareCommit({ activationId: activation.id, leaseToken: activation.lease!.token, outcome: 'success', output: {}, now: 2 })
    await store.releaseExpiredClaims(5)
    expect(await coordinator.recoverPrepared(6)).toHaveLength(1)
    expect((await store.snapshot()).state.values.count).toBe(1)
    expect(await coordinator.recoverPrepared(7)).toHaveLength(0)
  })

  it('parks on a Kernel timer and resumes after its deadline', async () => {
    const projectDir = await root(); const caps = capabilities(); let now = 10
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'timer', version: 1, goal: 'Wait.', state: {}, lanes: {},
      nodes: { wait: { type: 'wait', wait: { kind: 'timer', delayMs: { literal: 100 }, maxDelayMs: 1000 } }, done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' } },
      transitions: [{ id: 'elapsed', from: 'wait', on: 'timer', to: 'done' }, { id: 'failed', from: 'wait', on: 'failure', to: 'failed' }],
      entrypoints: [{ id: 'start', node: 'wait' }], limits: { maxActivations: 3, maxPendingTimers: 1 },
    }
    const graph = freezeLoopGraph(spec, caps, 1); const store = await GraphStore.create({ projectDir, instanceId: 'timer', graph, functions: caps.functions, now })
    const kernel = await GraphKernel.open({ store, graph, ...caps, owner: 'test', now: () => now })
    expect((await kernel.tick()).parked).toBe(1)
    now = 111
    expect((await kernel.tick()).committed).toBe(1)
    expect((await kernel.tick()).instance.status).toBe('done')
  })

  it('waits for and consumes a named external event', async () => {
    const projectDir = await root(); const caps = capabilities(); let now = 10
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'event', version: 1, goal: 'Wait for approval.', state: {}, lanes: {},
      nodes: { wait: { type: 'wait', wait: { kind: 'event', event: 'approved', timeoutMs: 1000 } }, done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' } },
      transitions: [{ id: 'approved', from: 'wait', on: 'event', to: 'done' }, { id: 'timeout', from: 'wait', on: 'timeout', to: 'failed' }, { id: 'wait-failed', from: 'wait', on: 'failure', to: 'failed' }],
      entrypoints: [{ id: 'start', node: 'wait' }], limits: { maxActivations: 3, maxPendingTimers: 1 },
    }
    const graph = freezeLoopGraph(spec, caps, 1); const store = await GraphStore.create({ projectDir, instanceId: 'event', graph, functions: caps.functions, now })
    const kernel = await GraphKernel.open({ store, graph, ...caps, owner: 'test', now: () => now })
    expect((await kernel.tick()).parked).toBe(1)
    now = 20
    expect((await kernel.deliverEvent({ name: 'approved', payload: { ok: true } })).resumed).toBe(1)
    expect((await kernel.tick()).committed).toBe(1)
    expect((await kernel.tick()).instance.status).toBe('done')
  })

  it('fans out independent branches and joins them once', async () => {
    const projectDir = await root(); const caps = capabilities()
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'join', version: 1, goal: 'Join parallel work.', state: {}, lanes: {},
      nodes: {
        start: { type: 'function', function: 'builtin/identity@1' },
        left: { type: 'function', function: 'builtin/identity@1', inputs: { value: { literal: 'left' } } },
        right: { type: 'function', function: 'builtin/identity@1', inputs: { value: { literal: 'right' } } },
        join: { type: 'join', mode: 'all', expects: ['left_join', 'right_join'] },
        done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'fanout', from: 'start', to: ['left', 'right'] }, { id: 'start_failed', from: 'start', on: 'failure', to: 'failed' },
        { id: 'left_join', from: 'left', to: { node: 'join', inputs: { left: { ref: '$output' } } } }, { id: 'left_failed', from: 'left', on: 'failure', to: 'failed' },
        { id: 'right_join', from: 'right', to: { node: 'join', inputs: { right: { ref: '$output' } } } }, { id: 'right_failed', from: 'right', on: 'failure', to: 'failed' },
        { id: 'joined', from: 'join', to: 'done' },
      ],
      entrypoints: [{ id: 'start', node: 'start' }], limits: { maxActivations: 10, maxFanOut: 2 },
      concurrency: { maxActivations: 2, maxPerNode: 2 },
    }
    const graph = freezeLoopGraph(spec, caps, 1); const store = await GraphStore.create({ projectDir, instanceId: 'join', graph, functions: caps.functions })
    const kernel = await GraphKernel.open({ store, graph, ...caps, owner: 'test' })
    for (let index = 0; index < 5 && (await store.snapshot()).instance.status === 'active'; index++) await kernel.tick()
    const snapshot = await store.snapshot()
    expect(snapshot.instance.status).toBe('done')
    expect([...snapshot.activations.values()].filter(item => item.nodeId === 'join' && item.status === 'succeeded')).toHaveLength(1)
  })

  it('bounds a pending idempotent Effect by its Activation deadline', async () => {
    const projectDir = await root(); const caps = capabilities(); let now = 1000; let submits = 0
    caps.effects.register({
      manifest: { id: 'test/pending', version: '1', integrity: 'test:pending-v1', pure: false },
      async submit() { submits++; return { receipt: 'one' } },
      async inspect() { return { status: 'pending' as const } },
    })
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'effect', version: 1, goal: 'Bound an Effect.', state: {}, lanes: {},
      nodes: { effect: { type: 'effect', effect: 'test/pending@1', timeoutMs: 100 }, done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' } },
      transitions: [{ id: 'done', from: 'effect', to: 'done' }, { id: 'failed', from: 'effect', on: 'failure', to: 'failed' }],
      entrypoints: [{ id: 'start', node: 'effect' }], limits: { maxActivations: 3, maxPendingTimers: 1 },
    }
    const graph = freezeLoopGraph(spec, caps, 1); const store = await GraphStore.create({ projectDir, instanceId: 'effect', graph, functions: caps.functions, now })
    const kernel = await GraphKernel.open({ store, graph, ...caps, owner: 'test', now: () => now })
    expect((await kernel.tick()).parked).toBe(1)
    now = 1100
    expect((await kernel.tick()).committed).toBe(1)
    expect(submits).toBe(1)
    expect((await kernel.tick()).instance.status).toBe('failed')
  })
})
