import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDefaultGraphRuntimeCatalog,
  createGraphEventDelivery,
  deliverGraphEvent,
  freezeLoopGraph,
  GraphKernel,
  GraphStore,
  type LoopGraphSpec,
} from '../../index.js'
import { WakeStore } from '../../wake/WakeStore.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Graph event delivery bridge', () => {
  it('persists an event and schedules resumed work without exposing Kernel/WakeStore to the HTTP host', async () => {
    const fixture = await waitingGraph('normal-delivery')
    const deliver = createGraphEventDelivery({
      projectDir: fixture.projectDir,
      instanceId: fixture.instanceId,
      catalog: fixture.catalog,
      now: () => 20,
    })

    const result = await deliver({
      name: 'job.completed', source: 'training', deliveryId: 'delivery-1', payload: { jobId: 'job-1' },
    })

    expect(result).toMatchObject({ duplicate: false, resumed: 1, wakeScheduled: true, wakeRecovered: false })
    expect(await new WakeStore(fixture.projectDir).list()).toContainEqual(expect.objectContaining({
      loopId: fixture.instanceId, activationId: '__graph__', kind: 'event', status: 'pending', fireAt: 20,
    }))
  })

  it('repairs a crash after event consumption but before wake persistence on source redelivery', async () => {
    const fixture = await waitingGraph('delivery-repair')
    const event = { name: 'job.completed', source: 'training', deliveryId: 'delivery-1' }

    await expect(deliverGraphEvent(event, {
      projectDir: fixture.projectDir,
      instanceId: fixture.instanceId,
      catalog: fixture.catalog,
      now: () => 20,
      wakeScheduler: {
        async schedule() { throw new Error('simulated wake disk failure') },
      },
    })).rejects.toThrow('simulated wake disk failure')

    const repaired = await deliverGraphEvent(event, {
      projectDir: fixture.projectDir,
      instanceId: fixture.instanceId,
      catalog: fixture.catalog,
      now: () => 30,
    })

    expect(repaired).toMatchObject({ duplicate: true, resumed: 0, wakeScheduled: true, wakeRecovered: true })
    const snapshot = await fixture.store.snapshot()
    expect(snapshot.externalEvents.size).toBe(1)
    expect([...snapshot.activations.values()]).toContainEqual(expect.objectContaining({ status: 'ready' }))
    expect(await new WakeStore(fixture.projectDir).list()).toContainEqual(expect.objectContaining({
      loopId: fixture.instanceId, kind: 'event', status: 'pending', fireAt: 30,
    }))
  })

  it('keeps an unmatched event pending without scheduling an unnecessary tick', async () => {
    const fixture = await waitingGraph('pending-delivery')
    const result = await deliverGraphEvent({
      name: 'another.event', source: 'test', deliveryId: 'unmatched',
    }, {
      projectDir: fixture.projectDir,
      instanceId: fixture.instanceId,
      catalog: fixture.catalog,
      now: () => 20,
    })

    expect(result).toMatchObject({ resumed: 0, wakeScheduled: false, wakeRecovered: false })
    expect(result.event.status).toBe('pending')
    expect(await new WakeStore(fixture.projectDir).list()).toEqual([])
  })
})

async function waitingGraph(instanceId: string) {
  const projectDir = await mkdtemp(join(tmpdir(), 'graph-event-delivery-'))
  roots.push(projectDir)
  const catalog = createDefaultGraphRuntimeCatalog()
  const source: LoopGraphSpec = {
    schemaVersion: 'graph-2.0', id: 'event_delivery', version: 1, goal: 'Wait for a durable callback.', state: {}, lanes: {},
    nodes: {
      wait: { type: 'wait', wait: { kind: 'event', event: 'job.completed' } },
      done: { type: 'terminal', status: 'done' },
      failed: { type: 'terminal', status: 'failed' },
    },
    transitions: [
      { id: 'received', from: 'wait', on: 'event', to: 'done' },
      { id: 'failed', from: 'wait', on: 'failure', to: 'failed' },
    ],
    entrypoints: [{ id: 'start', node: 'wait' }],
    limits: { maxActivations: 3 },
  }
  const graph = freezeLoopGraph(source, catalog, 1)
  const store = await GraphStore.create({ projectDir, instanceId, graph, functions: catalog.functions, now: 10 })
  const kernel = await GraphKernel.open({ store, graph, ...catalog, now: () => 10 })
  expect((await kernel.tick()).parked).toBe(1)
  return { projectDir, instanceId, catalog, store }
}
