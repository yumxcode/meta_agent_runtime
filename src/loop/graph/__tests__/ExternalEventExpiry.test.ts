/**
 * Pending external events must not accumulate forever.
 *
 * A delivery only resumes a waiting Activation when `createdAt < wakeAt`, so an
 * event that arrives after its Wait timed out can never match — as with one whose
 * correlation nobody listens for, or whose target was cancelled. Those records
 * used to stay `pending`, and `pending` was the one status checkpoint retention
 * kept unconditionally. Every tick then rescanned them twice
 * (resumePendingExternalEvents runs before and after the wave) and structurally
 * compared each against every waiting Activation, canonicalising up to 1 MB of
 * JSON per comparison. A long-lived instance got permanently, silently slower for
 * events that could never do anything.
 *
 * Expiry is journaled rather than swept quietly: "the webhook arrived and nothing
 * was listening" is a diagnosis, not noise.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDefaultGraphRuntimeCatalog,
  freezeLoopGraph,
  GraphKernel,
  GraphStore,
  type LoopGraphSpec,
} from '../../index.js'

const roots: string[] = []
const DAY = 24 * 60 * 60_000

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function waitingGraph(instanceId: string, now: number) {
  const projectDir = await mkdtemp(join(tmpdir(), 'graph-event-expiry-'))
  roots.push(projectDir)
  const catalog = createDefaultGraphRuntimeCatalog()
  const source: LoopGraphSpec = {
    schemaVersion: 'graph-2.0', id: 'event_expiry', version: 1,
    goal: 'Wait for a durable callback.', state: {}, lanes: {},
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
  const store = await GraphStore.create({ projectDir, instanceId, graph, functions: catalog.functions, now })
  return { projectDir, catalog, store, graph }
}

describe('external event expiry', () => {
  it('retires a pending delivery that has aged past the retention horizon', async () => {
    const start = Date.now()
    const fixture = await waitingGraph('expiry-basic', start)
    let clock = start
    const kernel = await GraphKernel.open({
      store: fixture.store, graph: fixture.graph, ...fixture.catalog, now: () => clock,
    })
    await kernel.tick()

    // A delivery nobody is waiting for: correct shape, wrong name.
    await kernel.deliverEvent({ name: 'nobody.listens', source: 'ci', deliveryId: 'd-1' })
    expect([...(await fixture.store.snapshot()).externalEvents.values()][0]?.status).toBe('pending')

    // Still pending inside the horizon — a redelivery window is real.
    clock = start + 6 * DAY
    await kernel.tick()
    expect([...(await fixture.store.snapshot()).externalEvents.values()][0]?.status).toBe('pending')

    // Past it, the tick retires it.
    clock = start + 8 * DAY
    await kernel.tick()
    const expired = [...(await fixture.store.snapshot()).externalEvents.values()][0]
    expect(expired?.status).toBe('expired')
    expect(expired?.expiredAt).toBe(clock)
  })

  it('journals the expiry so the delivery is auditable, not silently dropped', async () => {
    const start = Date.now()
    const fixture = await waitingGraph('expiry-journal', start)
    let clock = start
    const kernel = await GraphKernel.open({
      store: fixture.store, graph: fixture.graph, ...fixture.catalog, now: () => clock,
    })
    await kernel.tick()
    await kernel.deliverEvent({ name: 'nobody.listens', source: 'ci', deliveryId: 'd-1' })

    clock = start + 8 * DAY
    await kernel.tick()

    const journal = await fixture.store.readJournal()
    const expiry = journal.find(entry => entry.event.type === 'external_event_expired')
    expect(expiry).toBeDefined()
  })

  it('never expires a delivery that is still matchable', async () => {
    const start = Date.now()
    const fixture = await waitingGraph('expiry-matchable', start)
    let clock = start
    const kernel = await GraphKernel.open({
      store: fixture.store, graph: fixture.graph, ...fixture.catalog, now: () => clock,
    })
    await kernel.tick()

    // Delivered well inside the horizon and matching the Wait: it must resume
    // the Activation, not be swept.
    clock = start + 1_000
    const delivery = await kernel.deliverEvent({ name: 'job.completed', source: 'ci', deliveryId: 'd-ok' })
    expect(delivery.resumed).toBe(1)
    expect(delivery.event.status).toBe('consumed')

    clock = start + 8 * DAY
    await kernel.tick()
    const events = [...(await fixture.store.snapshot()).externalEvents.values()]
    // Consumed stays consumed; expiry only ever applies to pending.
    expect(events.every(event => event.status !== 'expired')).toBe(true)
  })
})
