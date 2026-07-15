import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  createBuiltinFunctionRegistry,
  createBuiltinReducerRegistry,
  freezeLoopGraph,
  GraphKernel,
  GraphStore,
  ArtifactPlane,
  CommitCoordinator,
  type EffectProvider,
  type LoopGraphSpec,
} from '../index.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function capabilities() {
  return {
    functions: createBuiltinFunctionRegistry(),
    reducers: createBuiltinReducerRegistry(),
    effects: new CapabilityRegistry<EffectProvider>('effect'),
  }
}

function timerGraph(): LoopGraphSpec {
  return {
    schemaVersion: 'graph-1.0', id: 'timer-flow', version: 1, goal: 'Run, wait, resume, finish',
    state: {}, lanes: {},
    nodes: {
      prepare: {
        type: 'function', function: 'builtin/identity@1', inputs: { prepared: { literal: true } },
        publishes: [{ channel: 'proof', value: { ref: '$output' }, tags: ['prepared'] }],
      },
      wait: { type: 'wait', wait: { kind: 'timer', delayMs: { literal: 100 }, maxDelayMs: 1000 } },
      done: { type: 'terminal', status: 'done', result: { literal: { ok: true } } },
    },
    transitions: [
      { id: 'prepared', from: 'prepare', to: 'wait' },
      { id: 'prepare-failed', from: 'prepare', on: 'failure', to: 'done' },
      { id: 'elapsed', from: 'wait', on: 'timer', to: 'done' },
      { id: 'wait-failed', from: 'wait', on: 'failure', to: 'done' },
    ],
    entrypoints: [{ id: 'start', node: 'prepare' }],
    artifacts: { proof: { kind: 'evidence', admission: 'automatic', maxItems: 5 } },
    limits: { maxActivations: 10, maxPendingTimers: 2 },
  }
}

function joinGraph(): LoopGraphSpec {
  return {
    schemaVersion: 'graph-1.0', id: 'join-flow', version: 1, goal: 'Fan out and join',
    state: {}, lanes: {},
    nodes: {
      a: { type: 'function', function: 'builtin/identity@1', inputs: { value: { literal: 'a' } } },
      b: { type: 'function', function: 'builtin/identity@1', inputs: { value: { literal: 'b' } } },
      join: { type: 'join', mode: 'all', expects: ['a-join', 'b-join'] },
      done: { type: 'terminal', status: 'done' },
    },
    transitions: [
      { id: 'a-join', from: 'a', to: { node: 'join', inputs: { a: { ref: '$output' } } } },
      { id: 'a-failed', from: 'a', on: 'failure', to: 'done' },
      { id: 'b-join', from: 'b', to: { node: 'join', inputs: { b: { ref: '$output' } } } },
      { id: 'b-failed', from: 'b', on: 'failure', to: 'done' },
      { id: 'joined', from: 'join', to: 'done' },
    ],
    entrypoints: [{ id: 'a', node: 'a' }, { id: 'b', node: 'b' }],
    limits: { maxActivations: 10 },
    concurrency: { maxActivations: 2, maxPerNode: 2 },
  }
}

function longAgentGraph(maxParks = 10, lifetimeUsd = 10): LoopGraphSpec {
  return {
    schemaVersion: 'graph-1.0', id: 'long-agent', version: 1, goal: 'Keep one logical Agent Activation alive across timer parks',
    state: {},
    lanes: { research: { context: 'persistent', workspace: 'readonly', maxConcurrency: 1 } },
    nodes: {
      research: {
        type: 'agent', lane: 'research', prompt: 'Run a long external lifecycle.', maxAttempts: 1,
        budget: { turns: 5, usd: 1, wallTimeMs: 60_000 },
        lifetimeBudget: { turns: 100, usd: lifetimeUsd, elapsedMs: 60 * 60_000 },
        timerPolicy: { allowHardPark: true, maxDelayMs: 60_000, maxParks },
      },
      done: { type: 'terminal', status: 'done' },
      failed: { type: 'terminal', status: 'failed' },
    },
    transitions: [
      { id: 'research-done', from: 'research', on: 'success', to: 'done' },
      { id: 'research-failed', from: 'research', on: 'failure', to: 'failed' },
    ],
    entrypoints: [{ id: 'start', node: 'research' }],
    limits: { maxActivations: 10, maxCostUsd: 20, maxPendingTimers: 2 },
  }
}

function pausedResumeGraph(): LoopGraphSpec {
  return {
    schemaVersion: 'graph-1.0', id: 'paused-resume', version: 1, goal: 'Pause and resume through a declared edge',
    state: { resumes: { type: { type: 'integer', minimum: 0 }, initial: 0 } }, lanes: {},
    nodes: {
      prepare: { type: 'function', function: 'builtin/identity@1' },
      approval: { type: 'terminal', status: 'paused', result: { literal: { checkpoint: 'ready' } } },
      continue: { type: 'function', function: 'builtin/identity@1' },
      done: { type: 'terminal', status: 'done' },
      failed: { type: 'terminal', status: 'failed' },
    },
    transitions: [
      { id: 'prepared', from: 'prepare', to: 'approval' },
      { id: 'prepare-failed', from: 'prepare', on: 'failure', to: 'failed' },
      { id: 'resume', from: 'approval', on: 'resume', updates: [{ target: 'resumes', reducer: 'builtin/increment@1' }], to: 'continue' },
      { id: 'continued', from: 'continue', to: 'done' },
      { id: 'continue-failed', from: 'continue', on: 'failure', to: 'failed' },
    ],
    entrypoints: [{ id: 'start', node: 'prepare' }],
    limits: { maxActivations: 8 },
  }
}

function lateAnyJoinGraph(): LoopGraphSpec {
  return {
    schemaVersion: 'graph-1.0', id: 'late-any-join', version: 1, goal: 'Join once for one fork epoch',
    state: {}, lanes: {},
    nodes: {
      fork: { type: 'function', function: 'builtin/identity@1' },
      fast: { type: 'function', function: 'builtin/identity@1' },
      slow: { type: 'wait', wait: { kind: 'timer', delayMs: { literal: 100 }, maxDelayMs: 1_000 } },
      join: { type: 'join', mode: 'any', expects: ['fast-join', 'slow-join'] },
      finish: { type: 'function', function: 'builtin/identity@1' },
      done: { type: 'terminal', status: 'done' },
      failed: { type: 'terminal', status: 'failed' },
    },
    transitions: [
      { id: 'forked', from: 'fork', to: ['fast', 'slow'] },
      { id: 'fork-failed', from: 'fork', on: 'failure', to: 'failed' },
      { id: 'fast-join', from: 'fast', to: 'join' },
      { id: 'fast-failed', from: 'fast', on: 'failure', to: 'failed' },
      { id: 'slow-join', from: 'slow', on: 'timer', to: 'join' },
      { id: 'slow-failed', from: 'slow', on: 'failure', to: 'failed' },
      { id: 'joined', from: 'join', to: 'finish' },
      { id: 'finished', from: 'finish', to: 'done' },
      { id: 'finish-failed', from: 'finish', on: 'failure', to: 'failed' },
    ],
    entrypoints: [{ id: 'start', node: 'fork' }],
    limits: { maxActivations: 20, maxPendingTimers: 2 },
    concurrency: { maxActivations: 2, maxPerNode: 2 },
  }
}

describe('GraphKernel', () => {
  it('durably resumes a paused Terminal exactly once through its declared resume edge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-paused-resume-'))
    roots.push(root)
    const caps = capabilities()
    const graph = freezeLoopGraph(pausedResumeGraph(), caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'paused-resume', graph, functions: caps.functions, now: 1 })
    const kernel = await GraphKernel.open({ store, graph, ...caps, now: () => 10, owner: 'test' })
    await kernel.tick()
    expect((await kernel.tick()).instance.status).toBe('paused')

    const coordinator = new CommitCoordinator(store, graph, caps.functions, caps.reducers)
    const resumed = await coordinator.resumePausedTerminal(20)
    expect(resumed.instance.status).toBe('active')
    expect(resumed.spawned).toHaveLength(1)
    expect((await store.snapshot()).state.values.resumes).toBe(1)
    await expect(coordinator.resumePausedTerminal(21)).rejects.toThrow(/not paused/)

    await kernel.tick()
    expect((await kernel.tick()).instance.status).toBe('done')
    const reopened = await GraphStore.create({ projectDir: root, instanceId: 'paused-resume', graph, functions: caps.functions })
    expect((await reopened.snapshot()).instance.status).toBe('done')
  })

  it('bounds a pending Effect by one total Activation deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-effect-deadline-'))
    roots.push(root)
    let now = 1_000
    let submits = 0
    const caps = capabilities()
    caps.effects.register({
      manifest: { id: 'test/pending-effect', version: '1', integrity: 'test:pending-effect-v1', pure: false },
      async submit() { submits++; return { receiptId: 'receipt-1' } },
      async inspect() { return { status: 'pending' as const } },
    })
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-1.0', id: 'effect-deadline', version: 1, goal: 'Bound effect polling',
      state: {}, lanes: {},
      nodes: {
        effect: { type: 'effect', effect: 'test/pending-effect@1', timeoutMs: 100 },
        done: { type: 'terminal', status: 'done' },
        failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'effect-done', from: 'effect', to: 'done' },
        { id: 'effect-failed', from: 'effect', on: 'failure', to: 'failed' },
      ],
      entrypoints: [{ id: 'start', node: 'effect' }],
      limits: { maxActivations: 3, maxPendingTimers: 1 },
    }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'effect-deadline', graph, functions: caps.functions, now })
    const kernel = await GraphKernel.open({ store, graph, ...caps, now: () => now, owner: 'test' })

    const first = await kernel.tick()
    expect(first.parked).toBe(1)
    expect(first.nextWakeAt).toBe(1_100)
    now = 1_100
    expect((await kernel.tick()).committed).toBe(1)
    const effect = [...(await store.snapshot()).activations.values()].find(item => item.nodeId === 'effect')!
    expect(effect.outcome).toBe('failure')
    expect(effect.output).toEqual({ error: 'effect deadline 100ms exceeded' })
    expect(submits).toBe(1)
    const ledger = await store.readEffectIntent(effect.id)
    expect(ledger).toMatchObject({ status: 'submitted', idempotencyKey: `effect-deadline:${effect.id}` })
    expect((await kernel.tick()).instance.status).toBe('failed')
  })

  it('runs deterministic nodes, hard-parks without a process, resumes, and terminates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-kernel-'))
    roots.push(root)
    let now = 1000
    const caps = capabilities()
    const graph = freezeLoopGraph(timerGraph(), caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'timer', graph, functions: caps.functions, now })
    const kernel = await GraphKernel.open({ store, graph, ...caps, now: () => now, owner: 'test' })

    expect((await kernel.tick()).committed).toBe(1)
    const evidence = await new ArtifactPlane(store).list({ kind: 'evidence' })
    expect(evidence[0]?.content).toEqual({ prepared: true })
    expect(evidence[0]?.provenance.nodeId).toBe('prepare')
    const parked = await kernel.tick()
    expect(parked.parked).toBe(1)
    expect(parked.instance.status).toBe('waiting')
    expect(parked.nextWakeAt).toBe(1100)

    now = 1050
    expect((await kernel.tick()).claimed).toBe(0)
    now = 1100
    expect((await kernel.tick()).committed).toBe(1)
    const terminal = await kernel.tick()
    expect(terminal.instance.status).toBe('done')
    expect(terminal.instance.terminalResult).toEqual({ ok: true })

    const snapshot = await store.snapshot()
    const waitActivation = [...snapshot.activations.values()].find(a => a.nodeId === 'wait')!
    expect(waitActivation.continuationVersion).toBe(1)
    expect(waitActivation.outcome).toBe('timer')
  })

  it('routes an event wait timeout separately from a delivered event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-event-timeout-'))
    roots.push(root)
    let now = 1_000
    const caps = capabilities()
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-1.0', id: 'event-timeout', version: 1, goal: 'Bound an external event wait',
      state: {}, lanes: {},
      nodes: {
        approval: { type: 'wait', wait: { kind: 'event', event: 'approval', timeoutMs: 100 } },
        done: { type: 'terminal', status: 'done' },
        failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'approved', from: 'approval', on: 'event', to: 'failed' },
        { id: 'approval-timeout', from: 'approval', on: 'timeout', to: 'done' },
        { id: 'approval-failed', from: 'approval', on: 'failure', to: 'failed' },
      ],
      entrypoints: [{ id: 'start', node: 'approval' }],
      limits: { maxActivations: 4, maxPendingTimers: 1 },
    }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'event-timeout', graph, functions: caps.functions, now })
    const kernel = await GraphKernel.open({ store, graph, ...caps, now: () => now, owner: 'test' })

    expect((await kernel.tick()).parked).toBe(1)
    now = 1_100
    expect((await kernel.tick()).committed).toBe(1)
    const approval = [...(await store.snapshot()).activations.values()].find(item => item.nodeId === 'approval')!
    expect(approval.outcome).toBe('timeout')
    expect((await kernel.tick()).instance.status).toBe('done')
  })

  it('persists an early external event and consumes it after the Wait Activation parks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-event-inbox-'))
    roots.push(root)
    let now = 1_000
    const caps = capabilities()
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-1.0', id: 'event-inbox', version: 1, goal: 'Do not lose early events',
      state: {}, lanes: {},
      nodes: {
        approval: { type: 'wait', wait: { kind: 'event', event: 'approval', correlation: { literal: 'change-1' }, timeoutMs: 1_000 } },
        done: { type: 'terminal', status: 'done' },
        failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'approved', from: 'approval', on: 'event', to: 'done' },
        { id: 'approval-timeout', from: 'approval', on: 'timeout', to: 'failed' },
        { id: 'approval-failed', from: 'approval', on: 'failure', to: 'failed' },
      ],
      entrypoints: [{ id: 'start', node: 'approval' }],
      limits: { maxActivations: 4, maxPendingTimers: 1 },
    }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'event-inbox', graph, functions: caps.functions, now })
    const kernel = await GraphKernel.open({ store, graph, ...caps, now: () => now, owner: 'test' })

    expect(await kernel.signalEvent({ name: 'approval', correlation: 'change-1', payload: { approved: true } })).toBe(0)
    expect((await store.snapshot()).externalEvents.size).toBe(1)
    expect((await kernel.tick()).parked).toBe(1)
    const afterPark = await store.snapshot()
    expect([...afterPark.activations.values()].find(item => item.nodeId === 'approval')?.status).toBe('ready')
    expect(afterPark.externalEvents.values().next().value?.status).toBe('consumed')
    expect((await kernel.tick()).committed).toBe(1)
    const approval = [...(await store.snapshot()).activations.values()].find(item => item.nodeId === 'approval')!
    expect(approval.outcome).toBe('event')
    expect((await store.snapshot()).externalEvents.values().next().value?.status).toBe('consumed')
    expect((await kernel.tick()).instance.status).toBe('done')
  })

  it('fails closed when a frozen capability implementation drifts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-kernel-'))
    roots.push(root)
    const caps = capabilities()
    const graph = freezeLoopGraph(timerGraph(), caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'drift', graph, functions: caps.functions })
    caps.functions.get('builtin/identity@1').manifest.integrity = 'changed'
    await expect(GraphKernel.open({ store, graph, ...caps })).rejects.toThrow(/integrity mismatch/)
  })

  it('coalesces concurrent Join activations without a losing branch failing the graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-kernel-'))
    roots.push(root)
    const caps = capabilities()
    const graph = freezeLoopGraph(joinGraph(), caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'join', graph, functions: caps.functions })
    const kernel = await GraphKernel.open({ store, graph, ...caps, owner: 'test' })
    expect((await kernel.tick()).committed).toBe(2)
    const joined = await kernel.tick()
    expect(joined.failed).toBe(0)
    expect(joined.committed).toBeGreaterThanOrEqual(1)
    const terminal = await kernel.tick()
    expect(terminal.instance.status).toBe('done')
    const snapshot = await store.snapshot()
    expect([...snapshot.activations.values()].filter(a => a.nodeId === 'join' && a.status === 'cancelled')).toHaveLength(1)
  })

  it('optionally replays stale parallel computation under serializable State policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-serializable-'))
    roots.push(root)
    const caps = capabilities()
    const spec = joinGraph()
    spec.concurrency = { ...spec.concurrency, stateConsistency: 'serializable' }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'serializable', graph, functions: caps.functions })
    const kernel = await GraphKernel.open({ store, graph, ...caps, owner: 'test' })
    const first = await kernel.tick()
    expect(first.committed).toBe(1)
    expect(first.retried).toBe(1)
    const replay = [...(await store.snapshot()).activations.values()].find(item => item.status === 'ready')!
    expect(replay.readyReason).toBe('replay')
    expect(replay.attempt).toBe(1)
  })

  it("does not trigger Join(any) again when a branch arrives after the fork epoch already joined", async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-late-any-join-'))
    roots.push(root)
    let now = 1_000
    const caps = capabilities()
    const graph = freezeLoopGraph(lateAnyJoinGraph(), caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'late-any-join', graph, functions: caps.functions, now })
    const kernel = await GraphKernel.open({ store, graph, ...caps, now: () => now, owner: 'test' })

    await kernel.tick() // fork
    await kernel.tick() // fast reaches join; slow parks
    await kernel.tick() // Join(any) fires once
    now = 1_100
    await kernel.tick() // finish and late slow branch both run
    const joins = [...(await store.snapshot()).activations.values()].filter(item => item.nodeId === 'join')
    expect(joins.filter(item => item.status === 'succeeded')).toHaveLength(1)
    expect(joins).toHaveLength(1)
    expect((await kernel.tick()).instance.status).toBe('done')
  })

  it('replays an interrupted Agent segment without consuming a retry attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-agent-replay-'))
    roots.push(root)
    const caps = capabilities()
    const graph = freezeLoopGraph(longAgentGraph(), caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'agent-replay', graph, functions: caps.functions })
    let calls = 0
    const executor = {
      async execute() {
        calls++
        if (calls === 1) return {
          kind: 'retry' as const,
          reason: 'daemon shutdown',
          consumeAttempt: false,
          usage: { turns: 1, costUsd: 0.1, durationMs: 10 },
        }
        return { kind: 'completed' as const, outcome: 'success', output: {}, usage: { turns: 1, costUsd: 0.1, durationMs: 10 } }
      },
    }
    const kernel = await GraphKernel.open({ store, graph, ...caps, executor, owner: 'test' })
    expect((await kernel.tick()).retried).toBe(1)
    expect((await kernel.tick()).committed).toBe(1)
    const activation = [...(await store.snapshot()).activations.values()].find(item => item.nodeId === 'research')!
    expect(activation.attempt).toBe(1)
    expect(activation.segmentCount).toBe(2)
    expect(activation.usage?.costUsd).toBeCloseTo(0.2)
  })

  it('fail-stops an Agent whose cancellation is unconfirmed and charges reserved segment cost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-agent-fatal-cancel-'))
    roots.push(root)
    const caps = capabilities()
    const graph = freezeLoopGraph(longAgentGraph(), caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'agent-fatal-cancel', graph, functions: caps.functions })
    const executor = {
      async execute() {
        return { kind: 'fatal' as const, reason: 'cancellation unconfirmed', usage: { turns: 1, costUsd: 1, durationMs: 10 } }
      },
    }
    const kernel = await GraphKernel.open({ store, graph, ...caps, executor, owner: 'test' })
    const result = await kernel.tick()
    expect(result.failed).toBe(1)
    expect(result.instance.status).toBe('failed')
    expect(result.instance.totalCostUsd).toBe(1)
  })

  it('keeps one Agent Activation and one retry attempt across repeated timer continuations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-long-agent-'))
    roots.push(root)
    let now = 1_000
    let segment = 0
    const caps = capabilities()
    const graph = freezeLoopGraph(longAgentGraph(), caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'long-agent', graph, functions: caps.functions, now })
    const executor = {
      async execute() {
        segment++
        const usage = { turns: 2, costUsd: 0.1, durationMs: 1_000 }
        if (segment <= 5) return {
          kind: 'parked' as const,
          wakeAt: now + 10,
          reason: `poll ${segment}`,
          inputPatch: { __continuationCheckpoint: { taskId: 'TASK-1', check: segment } },
          usage,
        }
        return { kind: 'completed' as const, outcome: 'success', output: { complete: true }, usage }
      },
    }
    const kernel = await GraphKernel.open({ store, graph, ...caps, executor, now: () => now, owner: 'test' })

    expect((await kernel.tick()).parked).toBe(1)
    for (let check = 2; check <= 5; check++) {
      now += 10
      expect((await kernel.tick()).parked).toBe(1)
    }
    let snapshot = await store.snapshot()
    const parked = [...snapshot.activations.values()].find(item => item.nodeId === 'research')!
    expect(parked.attempt).toBe(1)
    expect(parked.segmentCount).toBe(5)
    expect(parked.parkCount).toBe(5)
    expect(parked.continuationVersion).toBe(4)
    expect(parked.usage).toEqual({ turns: 10, costUsd: 0.5, durationMs: 5_000 })
    expect(parked.input.__continuationCheckpoint).toEqual({ taskId: 'TASK-1', check: 5 })
    expect(snapshot.instance.totalCostUsd).toBeCloseTo(0.5)

    now += 10
    expect((await kernel.tick()).committed).toBe(1)
    snapshot = await store.snapshot()
    const completed = [...snapshot.activations.values()].find(item => item.nodeId === 'research')!
    expect(completed.id).toBe(parked.id)
    expect(completed.attempt).toBe(1)
    expect(completed.segmentCount).toBe(6)
    expect(completed.parkCount).toBe(5)
    expect(completed.continuationVersion).toBe(5)
    expect(completed.usage).toEqual({ turns: 12, costUsd: 0.6, durationMs: 6_000 })
    expect(snapshot.instance.totalCostUsd).toBeCloseTo(0.6)
    expect((await kernel.tick()).instance.status).toBe('done')
  })

  it('turns a park beyond maxParks into a budgeted failure without consuming a retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-long-agent-limit-'))
    roots.push(root)
    let now = 1_000
    const caps = capabilities()
    const graph = freezeLoopGraph(longAgentGraph(2), caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'long-agent-limit', graph, functions: caps.functions, now })
    const executor = {
      async execute(activation: { nodeId: string }) {
        if (activation.nodeId !== 'research') {
          return { kind: 'completed' as const, outcome: 'success', output: { terminal: true } }
        }
        return { kind: 'parked' as const, wakeAt: now + 10, reason: 'poll', usage: { turns: 1, costUsd: 0.1, durationMs: 100 } }
      },
    }
    const kernel = await GraphKernel.open({ store, graph, ...caps, executor, now: () => now, owner: 'test' })
    expect((await kernel.tick()).parked).toBe(1)
    now += 10
    expect((await kernel.tick()).parked).toBe(1)
    now += 10
    expect((await kernel.tick()).committed).toBe(1)
    let snapshot = await store.snapshot()
    const research = [...snapshot.activations.values()].find(item => item.nodeId === 'research')!
    expect(research.outcome).toBe('failure')
    expect(research.output).toEqual({ error: 'Agent Activation maxParks 2 exceeded' })
    expect(research.attempt).toBe(1)
    expect(research.parkCount).toBe(2)
    expect(research.usage?.turns).toBe(3)
    expect(research.usage?.costUsd).toBeCloseTo(0.3)
    expect(research.usage?.durationMs).toBe(300)
    expect(snapshot.instance.totalCostUsd).toBeCloseTo(0.3)
    expect((await kernel.tick()).instance.status).toBe('failed')
    snapshot = await store.snapshot()
    expect(snapshot.instance.totalCostUsd).toBeCloseTo(0.3)
  })

  it('heartbeats the Activation lease while a long execution segment is running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-agent-heartbeat-'))
    roots.push(root)
    const caps = capabilities()
    const graph = freezeLoopGraph(longAgentGraph(), caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'agent-heartbeat', graph, functions: caps.functions })
    let observedHeartbeat = false
    const executor = {
      async execute() {
        await new Promise(resolve => setTimeout(resolve, 20))
        const running = [...(await store.snapshot()).activations.values()].find(item => item.nodeId === 'research')!
        const initialClaim = (await store.readJournal()).find(record => record.event.type === 'activation_claimed')
        if (initialClaim?.event.type === 'activation_claimed') {
          observedHeartbeat = (running.lease?.expiresAt ?? 0) > (initialClaim.event.activation.lease?.expiresAt ?? 0)
        }
        await new Promise(resolve => setTimeout(resolve, 15))
        return { kind: 'completed' as const, outcome: 'success', output: { complete: true }, usage: { turns: 1, costUsd: 0.01, durationMs: 35 } }
      },
    }
    const kernel = await GraphKernel.open({
      store, graph, ...caps, executor, owner: 'test', activationLeaseTtlMs: 15, activationHeartbeatMs: 5,
    })
    expect((await kernel.tick()).committed).toBe(1)
    const claims = (await store.readJournal()).filter(record => record.event.type === 'activation_claimed')
    expect(claims).toHaveLength(1)
    expect(observedHeartbeat).toBe(true)
    expect((await kernel.tick()).instance.status).toBe('done')
  })

  it('accounts parked segments against the whole-Activation USD budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-agent-lifetime-budget-'))
    roots.push(root)
    let now = 1_000
    const caps = capabilities()
    const graph = freezeLoopGraph(longAgentGraph(10, 0.25), caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'agent-lifetime-budget', graph, functions: caps.functions, now })
    const executor = {
      async execute(activation: { nodeId: string }) {
        if (activation.nodeId !== 'research') return { kind: 'completed' as const, outcome: 'success', output: {} }
        return { kind: 'parked' as const, wakeAt: now + 10, reason: 'poll', usage: { turns: 1, costUsd: 0.1, durationMs: 100 } }
      },
    }
    const kernel = await GraphKernel.open({ store, graph, ...caps, executor, now: () => now, owner: 'test' })
    expect((await kernel.tick()).parked).toBe(1)
    now += 10
    expect((await kernel.tick()).parked).toBe(1)
    now += 10
    expect((await kernel.tick()).committed).toBe(1)
    const research = [...(await store.snapshot()).activations.values()].find(item => item.nodeId === 'research')!
    expect(research.outcome).toBe('failure')
    expect(research.output).toEqual({ error: 'Agent Activation lifetime USD 0.25 exceeded' })
    expect(research.usage?.costUsd).toBeCloseTo(0.3)
    expect(research.attempt).toBe(1)
  })
})
