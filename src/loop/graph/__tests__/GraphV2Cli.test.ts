import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { runLoopCli } from '../../cli.js'
import { createDefaultGraphRuntimeCatalog, type LoopGraphSpec } from '../index.js'
import { createStandardTools } from '../../../tools/index.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('graph-v2 CLI', () => {
  it('creates, lists, inspects, and displays direct Lane files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-v2-cli-')); roots.push(root)
    const graph: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'cli_v2', version: 1, goal: 'CLI smoke test.', state: {},
      lanes: { work: { context: 'persistent', workspace: { read: ['requirements.md'], write: [{ path: 'state/status.json', mode: 'atomic_replace' }] } } },
      nodes: { work: { type: 'agent', lane: 'work', prompt: 'Work.' }, done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' } },
      transitions: [{ id: 'done', from: 'work', to: 'done' }, { id: 'failed', from: 'work', on: 'failure', to: 'failed' }],
      entrypoints: [{ id: 'start', node: 'work' }], limits: { maxActivations: 3 },
    }
    await writeFile(join(root, 'loop.json'), JSON.stringify(graph), 'utf8')
    expect(await runLoopCli(['create', 'loop.json', '--id', 'cli-v2'], { projectDir: root })).toContain('durable-graph-v2')
    expect(await runLoopCli(['list'], { projectDir: root })).toContain('engine=durable-graph-v2')
    expect(await runLoopCli(['inspect', 'cli-v2'], { projectDir: root })).toContain('graph: cli_v2@v1')
    const files = await runLoopCli(['files', 'cli-v2'], { projectDir: root })
    expect(files).toContain('direct Lane workspace contracts')
    expect(files).toContain('state/status.json  mode=atomic_replace')
  })

  it('rejects a non-v2 source graph before Freeze', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-v2-cli-')); roots.push(root)
    await writeFile(join(root, 'loop.json'), JSON.stringify({ schemaVersion: 'legacy' }), 'utf8')
    await expect(runLoopCli(['create', 'loop.json'], { projectDir: root })).rejects.toThrow("only accepts schemaVersion 'graph-2.0'")
  })

  it('rejects session-only tools with the canonical graph_agent catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-v2-capabilities-')); roots.push(root)
    const graph: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'tool_parity', version: 1, goal: 'Use runtime tools.', state: {},
      lanes: { work: { context: 'persistent', workspace: { read: ['**'], write: [] } } },
      nodes: {
        work: { type: 'agent', lane: 'work', prompt: 'Track progress, then wait briefly.', tools: ['read_file', 'sleep'] },
        done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [{ id: 'done', from: 'work', to: 'done' }, { id: 'failed', from: 'work', on: 'failure', to: 'failed' }],
      entrypoints: [{ id: 'start', node: 'work' }], limits: { maxActivations: 3 },
    }
    await writeFile(join(root, 'loop.json'), JSON.stringify(graph), 'utf8')
    await expect(runLoopCli(['create', 'loop.json'], { projectDir: root }))
      .rejects.toThrow("references unavailable Agent tool 'sleep'")
  })

  it('every canonical graph_agent tool exists in the unattended runtime toolset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-v2-parity-')); roots.push(root)
    const runtimeTools = await createStandardTools({
      system: { cwd: root, mode: 'agentic', planModeRef: { active: false } },
      mode: 'auto',
    })
    const runtimeNames = new Set(runtimeTools.map(tool => tool.name))
    // web_search requires the Anthropic API and is registered separately when
    // available; the CLI narrows the catalog (with a warning) when it is not.
    const configGated = new Set(['web_search'])
    const missing = [...createDefaultGraphRuntimeCatalog().agentTools]
      .filter(name => !runtimeNames.has(name) && !configGated.has(name))
    expect(missing).toEqual([])
  })

  it('verifies launch preconditions before creating an instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-v2-preconditions-')); roots.push(root)
    const graph: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'pre_v2', version: 1, goal: 'Gate on preconditions.', state: {},
      lanes: { work: { context: 'persistent', workspace: { read: ['spec.md'], write: [] } } },
      nodes: { work: { type: 'agent', lane: 'work', prompt: 'Work.', tools: ['read_file'] }, done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' } },
      transitions: [{ id: 'done', from: 'work', to: 'done' }, { id: 'failed', from: 'work', on: 'failure', to: 'failed' }],
      entrypoints: [{ id: 'start', node: 'work' }], limits: { maxActivations: 3 },
    }
    await writeFile(join(root, 'loop.json'), JSON.stringify(graph), 'utf8')
    await writeFile(join(root, 'loop.preconditions.json'), JSON.stringify({
      schemaVersion: 'loop-preconditions-1.0',
      items: [
        { kind: 'file', target: 'spec.md', reason: 'the loop reads it every round and never creates it' },
        { kind: 'command', target: 'node', reason: 'runtime interpreter used by the loop' },
        { kind: 'command', target: 'no-such-cli-xyz-123', reason: 'external CLI the loop shells out to' },
        { kind: 'decision', target: 'U1-max-iterations', reason: '未决决策（需人工确认）：max iterations defaulted to 20' },
      ],
    }), 'utf8')
    // Missing file + missing command + decision all block; the resolvable
    // command 'node' is verified mechanically and never blocks.
    await expect(runLoopCli(['create', 'loop.json', '--id', 'pre-v2'], { projectDir: root }))
      .rejects.toThrow(/launch preconditions are not satisfied[\s\S]*spec\.md[\s\S]*no-such-cli-xyz-123[\s\S]*U1-max-iterations/)
    await writeFile(join(root, 'spec.md'), '# spec', 'utf8')
    await writeFile(join(root, 'loop.preconditions.json'), JSON.stringify({
      schemaVersion: 'loop-preconditions-1.0',
      items: [
        { kind: 'file', target: 'spec.md', reason: 'the loop reads it every round and never creates it' },
        { kind: 'command', target: 'node', reason: 'runtime interpreter used by the loop' },
        { kind: 'decision', target: 'U1-max-iterations', reason: '未决决策（需人工确认）：max iterations defaulted to 20' },
      ],
    }), 'utf8')
    // Only the decision still blocks; --force acknowledges it explicitly.
    await expect(runLoopCli(['create', 'loop.json', '--id', 'pre-v2'], { projectDir: root }))
      .rejects.toThrow(/decision 'U1-max-iterations' requires manual confirmation/)
    const forced = await runLoopCli(['create', 'loop.json', '--id', 'pre-v2', '--force'], { projectDir: root })
    expect(forced).toContain("precondition ok: command 'node'")
    expect(forced).toContain('forced past precondition')
    expect(forced).toContain('instance pre-v2 created')
  })
})
