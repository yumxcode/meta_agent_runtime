import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  CommitCoordinator,
  createBuiltinFunctionRegistry,
  createBuiltinReducerRegistry,
  freezeLoopGraph,
  GraphStore,
  type EffectProvider,
  type FunctionProvider,
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

function retryGraph(twoEntries = false): LoopGraphSpec {
  return {
    schemaVersion: 'graph-1.0', id: 'durable-retry', version: 1, goal: 'Exercise durable routing',
    state: { count: { type: { type: 'integer', minimum: 0 }, initial: 7 } },
    lanes: { work: { context: 'persistent', workspace: 'lane_overlay' } },
    nodes: {
      work: { type: 'agent', lane: 'work', prompt: 'work' },
      done: { type: 'terminal', status: 'done', result: { ref: '$input.result' } },
      failed: { type: 'terminal', status: 'failed' },
    },
    transitions: [
      { id: 'finish', from: 'work', when: '$state.count >= 8', priority: 10, to: { node: 'done', inputs: { result: { ref: '$output' } } } },
      { id: 'retry', from: 'work', default: true, updates: [{ target: 'count', reducer: 'builtin/increment@1' }], to: 'work' },
      { id: 'work-failed', from: 'work', on: 'failure', to: 'failed' },
    ],
    entrypoints: twoEntries ? [{ id: 'a', node: 'work' }, { id: 'b', node: 'work' }] : [{ id: 'start', node: 'work' }],
    limits: { maxActivations: 20 },
    concurrency: { maxActivations: 2 },
  }
}

async function setup(twoEntries = false) {
  const root = await mkdtemp(join(tmpdir(), 'graph-store-'))
  roots.push(root)
  const caps = capabilities()
  const graph = freezeLoopGraph(retryGraph(twoEntries), caps, 1)
  const store = await GraphStore.create({ projectDir: root, instanceId: 'test-loop', graph, functions: caps.functions, now: 10 })
  return { root, caps, graph, store, coordinator: new CommitCoordinator(store, graph, caps.functions, caps.reducers) }
}

describe('durable graph store and commit coordinator', () => {
  it('evaluates entrypoint Function bindings outside the graph transaction lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-create-lock-'))
    roots.push(root)
    const caps = capabilities()
    const instanceId = 'entrypoint-lock'
    const transactionSentinel = join(root, '.loop', instanceId, 'graph', '.transaction.lock')
    let observedLock = false
    caps.functions.register({
      manifest: {
        id: 'test/observe-lock', version: '1', integrity: 'test:observe-lock-v1', pure: true,
      },
      execute() {
        observedLock = existsSync(transactionSentinel)
        return { observedLock }
      },
    } satisfies FunctionProvider)
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-1.0', id: 'entrypoint-lock', version: 1, goal: 'Keep plugin code outside persistence locks',
      state: {}, lanes: {},
      nodes: {
        done: { type: 'terminal', status: 'done' },
      },
      transitions: [],
      entrypoints: [{
        id: 'start', node: 'done',
        inputs: { probe: { call: 'test/observe-lock@1' } },
      }],
      limits: { maxActivations: 1 },
    }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId, graph, functions: caps.functions })
    expect(observedLock).toBe(false)
    const activation = [...(await store.snapshot()).activations.values()][0]!
    expect(activation.input.probe).toEqual({ observedLock: false })
  })

  it('serializes a Lane even when activation concurrency permits parallel work', async () => {
    const { store } = await setup(true)
    const claimed = await store.claimReady({ owner: 'test', now: 20, limit: 2 })
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.laneId).toBe('work')
  })

  it('commits state and routing exactly once, then completes a terminal node', async () => {
    const { store, coordinator } = await setup()
    const first = (await store.claimReady({ owner: 'test', now: 20 }))[0]!
    const firstIntent = await store.prepareCommit({ activationId: first.id, leaseToken: first.lease!.token, outcome: 'success', output: { result: 'first' }, now: 21 })
    const retry = await coordinator.commit(firstIntent, 22)
    expect(retry.transitionId).toBe('retry')
    expect((await store.snapshot()).state.values.count).toBe(8)

    const second = (await store.claimReady({ owner: 'test', now: 30 }))[0]!
    const secondIntent = await store.prepareCommit({ activationId: second.id, leaseToken: second.lease!.token, outcome: 'success', output: { result: 'second' }, now: 31 })
    const finish = await coordinator.commit(secondIntent, 32)
    expect(finish.transitionId).toBe('finish')

    const terminal = (await store.claimReady({ owner: 'test', now: 40 }))[0]!
    const terminalIntent = await store.prepareCommit({ activationId: terminal.id, leaseToken: terminal.lease!.token, outcome: 'success', output: terminal.input.result!, now: 41 })
    const completed = await coordinator.commit(terminalIntent, 42)
    expect(completed.instance.status).toBe('done')
    expect(completed.instance.terminalResult).toEqual({ result: 'second' })
  })

  it('recovers a prepared result after the worker process dies and deduplicates replay', async () => {
    const { store, coordinator } = await setup()
    const activation = (await store.claimReady({ owner: 'dead-worker', now: 20, ttlMs: 1 }))[0]!
    const intent = await store.prepareCommit({ activationId: activation.id, leaseToken: activation.lease!.token, outcome: 'success', output: 'durable output', now: 20 })
    await store.releaseExpiredClaims(30)
    const recovered = await coordinator.recoverPrepared(31)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.transitionId).toBe('retry')
    expect((await store.readIntent(intent.commitKey))?.status).toBe('committed')
    expect((await coordinator.commit(intent, 32)).duplicate).toBe(true)
    expect((await store.snapshot()).state.values.count).toBe(8)
  })

  it('increments retry attempts after lease expiry but not continuation counters', async () => {
    const { store } = await setup()
    const first = (await store.claimReady({ owner: 'worker-1', now: 20, ttlMs: 1 }))[0]!
    expect(first.attempt).toBe(1)
    expect(first.segmentCount).toBe(1)

    expect(await store.releaseExpiredClaims(22)).toBe(1)
    const retry = (await store.claimReady({ owner: 'worker-2', now: 23 }))[0]!
    expect(retry.id).toBe(first.id)
    expect(retry.attempt).toBe(2)
    expect(retry.segmentCount).toBe(2)
    expect(retry.continuationVersion).toBe(0)
  })

  it('rebuilds corrupted projections from the append-only journal', async () => {
    const { store } = await setup()
    await writeFile(store.paths.stateJson, JSON.stringify({ schemaVersion: 'graph-state-1.0', version: 99, values: { count: 999 }, updatedAt: 0 }))
    const repaired = await store.snapshot()
    expect(repaired.state.version).toBe(0)
    expect(repaired.state.values.count).toBe(7)
    const disk = JSON.parse(await readFile(store.paths.stateJson, 'utf8')) as { values: { count: number } }
    expect(disk.values.count).toBe(7)
  })

  it('rejects an over-capacity publication without killing the graph commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-artifact-cap-'))
    roots.push(root)
    const caps = capabilities()
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-1.0', id: 'artifact-cap', version: 1, goal: 'Bound artifact growth',
      state: {}, lanes: {},
      nodes: {
        publish: {
          type: 'function', function: 'builtin/identity@1',
          publishes: [{ channel: 'items', value: { ref: '$output' } }],
        },
        done: { type: 'terminal', status: 'done' },
      },
      transitions: [
        { id: 'published', from: 'publish', to: 'done' },
        { id: 'publish-failed', from: 'publish', on: 'failure', to: 'done' },
      ],
      entrypoints: [{ id: 'one', node: 'publish' }, { id: 'two', node: 'publish' }],
      artifacts: { items: { maxItems: 1 } },
      limits: { maxActivations: 10 },
      concurrency: { maxActivations: 2, maxPerNode: 2 },
    }
    const graph = freezeLoopGraph(spec, caps, 1)
    const store = await GraphStore.create({ projectDir: root, instanceId: 'artifact-cap', graph, functions: caps.functions })
    const coordinator = new CommitCoordinator(store, graph, caps.functions, caps.reducers)
    const claims = await store.claimReady({ owner: 'test', limit: 2 })
    for (const [index, activation] of claims.entries()) {
      const intent = await store.prepareCommit({
        activationId: activation.id,
        leaseToken: activation.lease!.token,
        outcome: 'success',
        output: { index },
      })
      await coordinator.commit(intent)
    }
    const snapshot = await store.snapshot()
    expect(snapshot.instance.status).toBe('active')
    expect(snapshot.artifacts.size).toBe(1)
    const commits = (await store.readJournal()).filter(record => record.event.type === 'activation_committed')
    expect(commits.some(record => record.event.type === 'activation_committed' && record.event.publicationRejections?.length)).toBe(true)
  })
})
