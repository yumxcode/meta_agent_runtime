/** Graph-only durable wake claim and execution runner. */
import {
  createDefaultGraphRuntimeCatalog,
  type GraphAgentExecutor,
  GraphKernel,
  GraphStore,
  listGraphInstanceRecords,
  type GraphRuntimeCatalog,
  type GraphTickResult,
} from './graph/index.js'
import { WakeStore, type WakeRecord } from './wake/WakeStore.js'
import type { HostAdmissionHandle, HostSchedulerCoordinator } from './host/HostSchedulerCoordinator.js'
import type { WorkspaceIdentity } from './workspace/WorkspaceIdentity.js'
import { ExprError } from './expr/Expr.js'

export interface TickDeps {
  graphAgent: GraphAgentExecutor
  projectDir: string
  signal?: AbortSignal
  graphCatalog?: GraphRuntimeCatalog
  hostCoordinator?: HostSchedulerCoordinator
  workspaceIdentity?: WorkspaceIdentity
}

export interface TickResult {
  claimed: number
  outcomes: TickOutcome[]
}

export interface TickOutcome {
  loopId: string
  graphOutcome?: GraphTickResult
  error?: string
}

const DEFAULT_TICK_MAX_CLAIMS = 4
const MAX_WAKE_ATTEMPTS = 5

export async function prepareAndClaim(
  deps: TickDeps,
  now = Date.now(),
  maxClaims = Number.POSITIVE_INFINITY,
): Promise<{ wakeStore: WakeStore; wakes: WakeRecord[] }> {
  const wakeStore = new WakeStore(deps.projectDir)
  await wakeStore.reconcileOrphans(now)
  const allWakes = await wakeStore.list()
  for (const record of await listGraphInstanceRecords(deps.projectDir)) {
    const liveForLoop = (): WakeRecord[] => allWakes.filter(wake =>
      wake.loopId === record.instanceId && (wake.status === 'pending' || wake.status === 'claimed'),
    )
    if (record.status === 'done' || record.status === 'failed' || record.status === 'paused') {
      if (liveForLoop().length) await wakeStore.cancelForLoop(record.instanceId)
      continue
    }
    const snapshot = await new GraphStore(deps.projectDir, record.instanceId).snapshot().catch(() => null)
    if (snapshot) {
      for (const activation of snapshot.activations.values()) {
        if (activation.status !== 'waiting' || activation.wakeAt === undefined) continue
        const exists = liveForLoop().some(wake => wake.activationId === activation.id && wake.kind === 'timer')
        if (exists) continue
        allWakes.push(await wakeStore.schedule({
          loopId: record.instanceId,
          activationId: activation.id,
          kind: 'timer',
          fireAt: activation.wakeAt,
        }))
      }
    }
    const graphWakeExists = liveForLoop().some(wake => wake.activationId === '__graph__')
    if (record.status === 'active' && !graphWakeExists) {
      allWakes.push(await wakeStore.schedule({
        loopId: record.instanceId,
        activationId: '__graph__',
        kind: 'timer',
        fireAt: now,
      }))
    }
  }
  return { wakeStore, wakes: await wakeStore.claimDue(now, undefined, maxClaims) }
}

export async function runClaimedWake(
  deps: TickDeps,
  wakeStore: WakeStore,
  wake: WakeRecord,
): Promise<TickOutcome> {
  let graphAdmission: HostAdmissionHandle | undefined
  const heartbeat = setInterval(() => {
    void wakeStore.heartbeat(wake.wakeId, Date.now(), wake.claim?.token).catch(() => undefined)
  }, 60_000)
  heartbeat.unref?.()
  try {
    if (deps.hostCoordinator && deps.workspaceIdentity) {
      graphAdmission = await deps.hostCoordinator.acquireGraphTick({
        workspaceId: deps.workspaceIdentity.workspaceId,
        instanceId: wake.loopId,
        ...(wake.activationId && wake.activationId !== '__graph__' ? { activationId: wake.activationId } : {}),
        wakeId: wake.wakeId,
      }, deps.signal ?? new AbortController().signal)
    }
    const store = new GraphStore(deps.projectDir, wake.loopId)
    const snapshot = await store.snapshot().catch(() => null)
    if (!snapshot) {
      await wakeStore.release(wake.wakeId, 'cancelled', { claimToken: wake.claim?.token })
      return { loopId: wake.loopId, error: 'graph instance not found' }
    }
    if (snapshot.instance.status === 'done' || snapshot.instance.status === 'failed' || snapshot.instance.status === 'paused') {
      await wakeStore.release(wake.wakeId, 'cancelled', { claimToken: wake.claim?.token })
      return { loopId: wake.loopId, error: `instance is ${snapshot.instance.status}` }
    }
    const graph = await store.loadSpec()
    const catalog = deps.graphCatalog ?? createDefaultGraphRuntimeCatalog()
    const kernel = await GraphKernel.open({
      store,
      graph,
      ...catalog,
      graphAgent: deps.graphAgent,
      wakeStore,
      owner: wake.claim?.owner,
      hostCoordinatorRoot: deps.hostCoordinator?.rootDir,
      maxConcurrentModelCalls: deps.hostCoordinator?.maxConcurrentModelCalls,
      signal: deps.signal,
    })
    const graphOutcome = await kernel.tick()
    await wakeStore.release(wake.wakeId, 'done', { claimToken: wake.claim?.token })
    if (graphOutcome.instance.status === 'done' || graphOutcome.instance.status === 'failed') {
      await wakeStore.cancelForLoop(wake.loopId)
    }
    return { loopId: wake.loopId, graphOutcome }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (deps.signal?.aborted) {
      await wakeStore.release(wake.wakeId, 'pending', {
        claimToken: wake.claim?.token,
        fireAt: Date.now(),
      }).catch(() => undefined)
      return { loopId: wake.loopId, error: `graph tick interrupted: ${message}` }
    }
    if (!isDeterministicGraphError(error) && wake.attempts < MAX_WAKE_ATTEMPTS) {
      const backoffMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, wake.attempts - 1))
      await wakeStore.release(wake.wakeId, 'pending', {
        claimToken: wake.claim?.token,
        fireAt: Date.now() + backoffMs,
      }).catch(() => undefined)
      return { loopId: wake.loopId, error: `graph tick retry ${wake.attempts}/${MAX_WAKE_ATTEMPTS}: ${message}` }
    }
    const store = new GraphStore(deps.projectDir, wake.loopId)
    await store.setStatus('failed', `graph tick failed: ${message}`).catch(() => undefined)
    await wakeStore.release(wake.wakeId, 'cancelled', { claimToken: wake.claim?.token }).catch(() => undefined)
    await wakeStore.cancelForLoop(wake.loopId).catch(() => 0)
    return { loopId: wake.loopId, error: message }
  } finally {
    clearInterval(heartbeat)
    await graphAdmission?.release().catch(() => undefined)
  }
}

function isDeterministicGraphError(error: unknown): boolean {
  if (error instanceof ExprError) return true
  const value = error instanceof Error ? error.message : String(error)
  return [
    /capability .*mismatch/i,
    /graph spec is missing/i,
    /does not match instance graphHash/i,
    /journal sequence gap/i,
    /has no creation event/i,
    /merge conflict/i,
    /Lane '.*' is conflicted/i,
    /invalid LoopGraphSpec/i,
    /no transition for node/i,
    /routing for node .* is not total/i,
    /produced invalid state/i,
    /fan-out .* exceeds limit/i,
    /reference .* does not resolve to JSON/i,
    /schema mismatch/i,
  ].some(pattern => pattern.test(value))
}

export async function tickOnce(deps: TickDeps, now = Date.now()): Promise<TickResult> {
  const { wakeStore, wakes } = await prepareAndClaim(deps, now, DEFAULT_TICK_MAX_CLAIMS)
  const outcomes = await Promise.all(wakes.map(wake => runClaimedWake(deps, wakeStore, wake)))
  return { claimed: wakes.length, outcomes }
}

export async function runUntilQuiescent(deps: TickDeps, opts?: { maxTicks?: number }): Promise<TickResult[]> {
  const results: TickResult[] = []
  for (let index = 0; index < (opts?.maxTicks ?? 100); index++) {
    const result = await tickOnce(deps)
    results.push(result)
    if (result.claimed === 0) break
  }
  return results
}
