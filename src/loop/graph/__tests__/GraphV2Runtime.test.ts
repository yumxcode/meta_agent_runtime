import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CapabilityRegistry, CommitCoordinator, createBuiltinFunctionRegistry, createBuiltinReducerRegistry, createDefaultGraphRuntimeCatalog,
  freezeLoopGraph, GraphKernel, GraphStore,
  type EffectProvider, type GraphAgentExecutionRequest, type LoopGraphSpec,
} from '../index.js'
import { prepareAndClaim, runClaimedWake } from '../../runner.js'

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
    expect(request?.limits).toEqual({ turns: 30, usd: 10 })
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

  it('checks serializable State version inside the commit transaction', async () => {
    const projectDir = await root(); const caps = capabilities()
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'serializable_race', version: 1, goal: 'Serialize concurrent updates.',
      state: { count: { type: { type: 'integer', minimum: 0 }, initial: 0 } }, lanes: {},
      nodes: {
        left: { type: 'function', function: 'builtin/identity@1' },
        right: { type: 'function', function: 'builtin/identity@1' },
        sink: { type: 'wait', wait: { kind: 'event', event: 'release' } },
        done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'left_ok', from: 'left', updates: [{ target: 'count', reducer: 'builtin/increment@1' }], to: 'sink' },
        { id: 'left_fail', from: 'left', on: 'failure', to: 'failed' },
        { id: 'right_ok', from: 'right', updates: [{ target: 'count', reducer: 'builtin/increment@1' }], to: 'sink' },
        { id: 'right_fail', from: 'right', on: 'failure', to: 'failed' },
        { id: 'sink_event', from: 'sink', on: 'event', to: 'done' },
        { id: 'sink_fail', from: 'sink', on: 'failure', to: 'failed' },
      ],
      entrypoints: [{ id: 'left', node: 'left' }, { id: 'right', node: 'right' }],
      limits: { maxActivations: 10 }, concurrency: { maxActivations: 2, stateConsistency: 'serializable' },
    }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir, instanceId: 'serializable-race', graph, functions: caps.functions, now: 1 })
    const coordinator = new CommitCoordinator(store, graph, caps.functions, caps.reducers)
    const activations = await store.claimReady({ owner: 'test', now: 2, limit: 2 })
    const intents = await Promise.all(activations.map(activation => store.prepareCommit({
      activationId: activation.id,
      leaseToken: activation.lease!.token,
      expectedStateVersion: activation.executionStateVersion,
      outcome: 'success', output: {}, now: 3,
    })))
    const results = await Promise.all(intents.map(intent => coordinator.commit(intent, 4)))
    expect(results.filter(result => result.replayed)).toHaveLength(1)
    const snapshot = await store.snapshot()
    expect(snapshot.state.values.count).toBe(1)
    expect([...snapshot.activations.values()].filter(activation => activation.readyReason === 'replay')).toHaveLength(1)
  })

  it('arbitrates simultaneous Terminals deterministically with failure first', async () => {
    const projectDir = await root(); const caps = capabilities()
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'terminal_order', version: 1, goal: 'Choose a stable terminal.',
      state: {}, lanes: {},
      nodes: { done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' } },
      transitions: [], entrypoints: [{ id: 'done', node: 'done' }, { id: 'failed', node: 'failed' }],
      limits: { maxActivations: 2 }, concurrency: { maxActivations: 2 },
    }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir, instanceId: 'terminal-order', graph, functions: caps.functions, now: 1 })
    const claimed = await store.claimReady({ owner: 'test', now: 2, limit: 2 })
    expect(claimed.map(activation => activation.nodeId)).toEqual(['failed'])
  })

  it('does not let an in-flight Terminal overwrite an operator stop', async () => {
    const projectDir = await root(); const caps = capabilities()
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'stopped_terminal', version: 1, goal: 'Keep stop final.', state: {}, lanes: {},
      nodes: { done: { type: 'terminal', status: 'done' } }, transitions: [],
      entrypoints: [{ id: 'done', node: 'done' }], limits: { maxActivations: 1 },
    }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir, instanceId: 'stopped-terminal', graph, functions: caps.functions, now: 1 })
    const coordinator = new CommitCoordinator(store, graph, caps.functions, caps.reducers)
    const activation = (await store.claimReady({ owner: 'test', now: 2 }))[0]!
    const intent = await store.prepareCommit({ activationId: activation.id, leaseToken: activation.lease!.token, outcome: 'success', output: {}, now: 3 })
    await store.setStatus('failed', 'stopped by operator', 4)
    await expect(coordinator.commit(intent, 5)).rejects.toThrow(/cannot commit|stale activation/)
    expect((await store.snapshot()).instance).toMatchObject({ status: 'failed', statusReason: 'stopped by operator' })
    expect((await store.snapshot()).activations.get(activation.id)?.status).toBe('cancelled')
  })

  it('aborts a running Agent segment after operator stop fencing', async () => {
    const projectDir = await root(); const caps = capabilities(); const graph = freezeLoopGraph(agentGraph(), caps, 1)
    const store = await GraphStore.create({ projectDir, instanceId: 'stop-running-agent', graph, functions: caps.functions, now: 1 })
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    let aborted = false
    const kernel = await GraphKernel.open({
      store, graph, ...caps, owner: 'test', activationHeartbeatMs: 5,
      graphAgent: {
        id: 'test',
        async execute(request) {
          started()
          return new Promise(resolve => request.signal.addEventListener('abort', () => {
            aborted = true
            resolve({ kind: 'aborted', taskId: 'stopped', usage: { turns: 0, costUsd: 0, durationMs: 1 } })
          }, { once: true }))
        },
      },
    })
    const tick = kernel.tick()
    await running
    await store.setStatus('failed', 'stopped by operator', 2)
    const result = await tick
    expect(result.instance.status).toBe('failed')
    expect(aborted).toBe(true)
  })

  it('persists a graph wall deadline wake for an event-only wait', async () => {
    const projectDir = await root(); const caps = capabilities(); let now = 10
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'wall_event', version: 1, goal: 'Bound an event wait.', state: {}, lanes: {},
      nodes: {
        wait: { type: 'wait', wait: { kind: 'event', event: 'release' } },
        done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'released', from: 'wait', on: 'event', to: 'done' },
        { id: 'wait_fail', from: 'wait', on: 'failure', to: 'failed' },
      ], entrypoints: [{ id: 'start', node: 'wait' }], limits: { maxActivations: 3, maxWallTimeMs: 100 },
    }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir, instanceId: 'wall-event', graph, functions: caps.functions, now })
    const kernel = await GraphKernel.open({ store, graph, ...caps, owner: 'test', now: () => now })
    expect((await kernel.tick()).parked).toBe(1)
    const graphAgent = { id: 'unused', async execute() { throw new Error('unused') } }
    const prepared = await prepareAndClaim({ projectDir, graphAgent }, 50)
    expect((await prepared.wakeStore.list()).filter(wake => wake.activationId === '__graph_deadline__'))
      .toEqual([expect.objectContaining({ fireAt: 110, status: 'pending' })])
    now = 110
    const due = await prepareAndClaim({ projectDir, graphAgent }, now)
    expect(due.wakes.map(wake => wake.activationId)).toContain('__graph_deadline__')
  })

  it('applies NodeBase timeoutMs to Function nodes', async () => {
    const projectDir = await root(); const caps = capabilities()
    caps.functions.register({
      manifest: { id: 'test/slow', version: '1', integrity: 'test:slow-v1', pure: true },
      async execute() { await new Promise(resolve => setTimeout(resolve, 40)); return {} },
    })
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'function_timeout', version: 1, goal: 'Bound a function.', state: {}, lanes: {},
      nodes: {
        slow: { type: 'function', function: 'test/slow@1', timeoutMs: 5 },
        done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [{ id: 'done', from: 'slow', to: 'done' }, { id: 'failed', from: 'slow', on: 'failure', to: 'failed' }],
      entrypoints: [{ id: 'start', node: 'slow' }], limits: { maxActivations: 3 },
    }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir, instanceId: 'function-timeout', graph, functions: caps.functions, now: 1 })
    const kernel = await GraphKernel.open({ store, graph, ...caps, owner: 'test' })
    expect((await kernel.tick()).committed).toBe(1)
    expect((await kernel.tick()).instance.status).toBe('failed')
  })

  it('heartbeats the host graph-tick admission during a long tick', async () => {
    const projectDir = await root(); const catalog = createDefaultGraphRuntimeCatalog()
    catalog.functions.register({
      manifest: { id: 'test/host_slow', version: '1', integrity: 'test:host-slow-v1', pure: true },
      async execute() { await new Promise(resolve => setTimeout(resolve, 35)); return {} },
    })
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'host_heartbeat', version: 1, goal: 'Keep host admission alive.', state: {}, lanes: {},
      nodes: {
        slow: { type: 'function', function: 'test/host_slow@1' },
        done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [{ id: 'done', from: 'slow', to: 'done' }, { id: 'failed', from: 'slow', on: 'failure', to: 'failed' }],
      entrypoints: [{ id: 'start', node: 'slow' }], limits: { maxActivations: 3 },
    }
    const graph = freezeLoopGraph(spec, catalog, 1)
    const store = await GraphStore.create({ projectDir, instanceId: 'host-heartbeat', graph, functions: catalog.functions, now: 1 })
    const prepared = await prepareAndClaim({ projectDir, graphAgent: { id: 'unused', async execute() { throw new Error('unused') } } }, Date.now())
    let heartbeats = 0; let releases = 0
    const hostCoordinator = {
      rootDir: join(projectDir, '.host-test'), maxConcurrentModelCalls: 1, heartbeatIntervalMs: 5,
      async acquireGraphTick() {
        return {
          lease: {},
          async heartbeat() { heartbeats++; return true },
          async release() { releases++ },
        }
      },
    }
    const outcome = await runClaimedWake({
      projectDir,
      graphAgent: { id: 'unused', async execute() { throw new Error('unused') } },
      graphCatalog: catalog,
      hostCoordinator: hostCoordinator as never,
      workspaceIdentity: { schemaVersion: '1.0', workspaceId: (await store.snapshot()).instance.workspaceId, createdAt: 1 },
    }, prepared.wakeStore, prepared.wakes[0]!)
    expect(outcome.error).toBeUndefined()
    expect(heartbeats).toBeGreaterThan(0)
    expect(releases).toBe(1)
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

  it('lets an Agent autonomously park and receive a compact resume context', async () => {
    const projectDir = await root(); const caps = capabilities(); let now = 10; const prompts: string[] = []
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'agent_timer', version: 1, goal: 'Continue Agent work later.', state: {},
      lanes: { work: { context: 'persistent', workspace: { read: [], write: [] } } },
      nodes: {
        work: {
          type: 'agent', lane: 'work', prompt: 'Plan and perform the work.', tools: ['read_file'], maxAttempts: 2,
          budget: { turns: 2, usd: 1, wallTimeMs: 1000 },
          lifetimeBudget: { turns: 4, usd: 2, elapsedMs: 10_000 },
          timerPolicy: { allowHardPark: true, maxDelayMs: 100, maxParks: 2 },
        },
        done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [{ id: 'done', from: 'work', to: 'done' }, { id: 'failed', from: 'work', on: 'failure', to: 'failed' }],
      entrypoints: [{ id: 'start', node: 'work' }], limits: { maxActivations: 3, maxPendingTimers: 1 },
    }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir, instanceId: 'agent-timer', graph, functions: caps.functions, now })
    let calls = 0
    const kernel = await GraphKernel.open({
      store, graph, ...caps, owner: 'test', now: () => now,
      graphAgent: {
        id: 'test',
        async execute(request) {
          prompts.push(request.prompt.user)
          calls++
          if (calls === 1) return {
            kind: 'completed', taskId: 't1', success: true, summary: 'waiting for a durable condition',
            usage: { turns: 1, costUsd: 0, durationMs: 1 },
            park: { afterMs: 10, reason: 'Wait for the next autonomous planning window.', checkpoint: { next: 'inspect progress' } },
          }
          return { kind: 'completed', taskId: 't2', success: true, output: { complete: true }, summary: 'completed', usage: { turns: 1, costUsd: 0, durationMs: 1 } }
        },
      },
    })
    expect((await kernel.tick()).parked).toBe(1)
    now = 20
    expect((await kernel.tick()).committed).toBe(1)
    expect(prompts[1]).toContain('__resume_context')
    expect(prompts[1]).toContain('inspect progress')
    expect(prompts[1]).toContain('Wait for the next autonomous planning window.')
  })

  it('can bound an incomplete Join with the existing Node timeoutMs', async () => {
    const projectDir = await root(); const caps = capabilities(); let now = 10
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'join_timeout', version: 1, goal: 'Bound an incomplete Join.', state: {}, lanes: {},
      nodes: {
        start: { type: 'function', function: 'builtin/identity@1' },
        join: { type: 'join', mode: 'all', expects: ['arrived', 'missing'], timeoutMs: 10 },
        done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'arrived', from: 'start', to: 'join' },
        { id: 'missing', from: 'start', on: 'missing', to: 'join' },
        { id: 'start_fail', from: 'start', on: 'failure', to: 'failed' },
        { id: 'joined', from: 'join', on: 'success', to: 'done' },
        { id: 'join_timeout', from: 'join', on: 'timeout', to: 'failed' },
      ],
      entrypoints: [{ id: 'start', node: 'start' }], limits: { maxActivations: 5, maxPendingTimers: 1 },
    }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir, instanceId: 'join-timeout', graph, functions: caps.functions, now })
    const kernel = await GraphKernel.open({ store, graph, ...caps, owner: 'test', now: () => now })
    expect((await kernel.tick()).committed).toBe(1)
    expect((await kernel.tick()).parked).toBe(1)
    now = 20
    expect((await kernel.tick()).committed).toBe(1)
    expect((await kernel.tick()).instance.status).toBe('failed')
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

  it('rejects oversized external event data before writing the inbox', async () => {
    const projectDir = await root(); const caps = capabilities(); let now = 10
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'event_limit', version: 1, goal: 'Bound event input.', state: {}, lanes: {},
      nodes: {
        wait: { type: 'wait', wait: { kind: 'event', event: 'payload' } },
        done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [{ id: 'event', from: 'wait', on: 'event', to: 'done' }, { id: 'failed', from: 'wait', on: 'failure', to: 'failed' }],
      entrypoints: [{ id: 'start', node: 'wait' }], limits: { maxActivations: 3 },
    }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir, instanceId: 'event-limit', graph, functions: caps.functions, now })
    const kernel = await GraphKernel.open({ store, graph, ...caps, owner: 'test', now: () => now })
    await kernel.tick()
    await expect(kernel.deliverEvent({ name: 'payload', payload: 'x'.repeat(1024 * 1024 + 1) }))
      .rejects.toThrow(/exceeds/)
    expect((await store.snapshot()).externalEvents.size).toBe(0)
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
