import type { GraphRuntimeCatalog } from '../graph/runtime/GraphCatalog.js'
import { createDefaultGraphRuntimeCatalog } from '../graph/runtime/GraphCatalog.js'
import { GraphKernel } from '../graph/runtime/GraphKernel.js'
import { GraphStore } from '../graph/runtime/GraphStore.js'
import type {
  GraphExternalEventDeliveryResult,
  GraphExternalEventInput,
} from '../graph/spec/GraphTypes.js'
import { WakeStore } from '../wake/WakeStore.js'

export interface GraphEventWakeScheduler {
  schedule(input: {
    loopId: string
    kind: 'event'
    fireAt: number
    activationId: '__graph__'
  }): Promise<unknown>
}

export interface GraphEventDeliveryOptions {
  projectDir: string
  instanceId: string
  /** Supply the same catalog used to create/tick graphs with external capability packs. */
  catalog?: GraphRuntimeCatalog
  /** Injection point for tests or an alternative durable scheduler. */
  wakeScheduler?: GraphEventWakeScheduler
  now?: () => number
}

export interface GraphEventDeliveryOutcome extends GraphExternalEventDeliveryResult {
  /** A durable scheduler wake was written by this call. */
  wakeScheduled: boolean
  /** A duplicate delivery repaired a prior event-accepted/wake-not-written failure. */
  wakeRecovered: boolean
}

export type GraphEventDeliverer = (event: GraphExternalEventInput) => Promise<GraphEventDeliveryOutcome>

/** Bind one HTTP/webhook endpoint to one durable Graph instance. */
export function createGraphEventDelivery(options: GraphEventDeliveryOptions): GraphEventDeliverer {
  return event => deliverGraphEvent(event, options)
}

/**
 * Persist an external event and hand resumed work to the host scheduler.
 *
 * Event acceptance and WakeStore use separate durable logs, so the operation
 * cannot be one filesystem transaction. Instead, source-scoped redelivery is
 * repairable: if the event is already consumed but its Activation is still
 * ready, the retry writes the missing wake without consuming the event twice.
 */
export async function deliverGraphEvent(
  event: GraphExternalEventInput,
  options: GraphEventDeliveryOptions,
): Promise<GraphEventDeliveryOutcome> {
  const now = options.now?.() ?? Date.now()
  const store = new GraphStore(options.projectDir, options.instanceId)
  const graph = await store.loadSpec()
  const catalog = options.catalog ?? createDefaultGraphRuntimeCatalog()
  const kernel = await GraphKernel.open({ store, graph, ...catalog, now: () => now })
  const result = await kernel.deliverEvent(event)

  const repairReadyActivation = result.duplicate
    && result.resumed === 0
    && result.event.status === 'consumed'
    && await consumedActivationIsReady(store, result.event.consumedBy ?? [])
  const needsWake = result.resumed > 0 || repairReadyActivation
  if (needsWake) {
    const scheduler = options.wakeScheduler ?? new WakeStore(store.projectDir)
    // Do not suppress this behind an existing claimed wake: that tick may have
    // taken its snapshot before this event committed. Extra wakes are safe;
    // missing the handoff would leave a ready Activation stranded.
    await scheduler.schedule({
      loopId: options.instanceId,
      activationId: '__graph__',
      kind: 'event',
      fireAt: now,
    })
  }

  return {
    ...result,
    wakeScheduled: needsWake,
    wakeRecovered: repairReadyActivation,
  }
}

async function consumedActivationIsReady(store: GraphStore, activationIds: readonly string[]): Promise<boolean> {
  if (!activationIds.length) return false
  const snapshot = await store.snapshot()
  return activationIds.some(id => snapshot.activations.get(id)?.status === 'ready')
}
