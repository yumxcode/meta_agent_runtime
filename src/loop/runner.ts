/**
 * runner — claim-and-run glue between WakeStore and LoopKernel (spec C8, M1
 * subset: no daemon yet — `tickOnce` is what `meta-agent loop tick` and the
 * foreground waiter call; the M2 daemon wraps the same function in a poll
 * loop + child-process dispatch).
 */
import type { ISubAgentDispatcher } from '../subagent/ISubAgentDispatcher.js'
import { WakeStore } from './wake/WakeStore.js'
import type { WakeRecord } from './wake/WakeStore.js'
import { WakeClaimLostError } from './wake/WakeStore.js'
import { listInstanceRecords, loadInstance } from './instance/InstanceStore.js'
import {
  RoundAbortedError,
  RoundExecutionUncertainError,
  runRound,
  type RoundOutcome,
  type LoopEvent,
} from './kernel/LoopKernel.js'
import { setInstanceStatus } from './instance/InstanceStore.js'
import { ingestEvents, reconcileWaiting } from './effects/WaitOps.js'
import { HALTED_STATUSES } from './types.js'
import { LedgerCorruptionError } from './ledger/LedgerApi.js'
import { CharterEnforcementError } from './security/PathSafety.js'
import {
  defaultEffectAdapterRegistry,
  EffectConfigurationError,
  type EffectAdapterRegistry,
} from './effects/EffectAdapter.js'
import type { HostAdmissionHandle } from './host/HostSchedulerCoordinator.js'
import { HostSchedulerCoordinator } from './host/HostSchedulerCoordinator.js'
import type { WorkspaceIdentity } from './workspace/WorkspaceIdentity.js'
import type { ScenarioRegistry } from './scenarios/ScenarioRegistry.js'
import { ScenarioPluginError } from './scenarios/ScenarioRegistry.js'

export interface TickDeps {
  dispatcher: ISubAgentDispatcher
  projectDir: string
  signal?: AbortSignal
  effectAdapters?: EffectAdapterRegistry
  /** Live per-round/seat progress (CLI renders it). */
  observer?: (event: LoopEvent) => void
  /** Host-wide coordination is injected by loop-scheduler and the host CLI tick path. */
  hostCoordinator?: HostSchedulerCoordinator
  workspaceIdentity?: WorkspaceIdentity
  scenarios?: ScenarioRegistry
}

export interface TickResult {
  claimed: number
  outcomes: TickOutcome[]
}

export type TickOutcome = { loopId: string; outcome?: RoundOutcome; error?: string }
const DEFAULT_TICK_MAX_CLAIMS = 4

/** Unclassified round errors stop retrying after this many claim attempts. */
const MAX_WAKE_ATTEMPTS = 5
const RETRY_BACKOFF_BASE_MS = 5_000
const RETRY_BACKOFF_MAX_MS = 5 * 60_000

function retryBackoffMs(attempts: number): number {
  return Math.min(RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

/**
 * Deterministic fail-stop shared by every classified error arm: park the
 * instance as 'failed' with the reason, cancel its wakes; if the instance is
 * gone, just cancel the wake.
 */
async function failStopLoop(
  deps: TickDeps,
  wakeStore: WakeStore,
  wake: WakeRecord,
  reason: string,
  errorMessage?: string,
): Promise<TickOutcome> {
  const instance = await loadInstance(deps.projectDir, wake.loopId, deps.scenarios)
  if (instance) {
    await setInstanceStatus(instance, 'failed', reason).catch(() => undefined)
    await wakeStore.cancelForLoop(wake.loopId).catch(() => 0)
  } else {
    await wakeStore.release(wake.wakeId, 'cancelled', { claimToken: wake.claim?.token }).catch(() => undefined)
  }
  return { loopId: wake.loopId, error: errorMessage ?? reason }
}

/** Fast scheduler phase: reconcile durable state and atomically claim a bounded
 * set of wakes. It never runs an LLM seat. */
export async function prepareAndClaim(
  deps: TickDeps,
  now = Date.now(),
  maxClaims = Number.POSITIVE_INFINITY,
): Promise<{ wakeStore: WakeStore; wakes: WakeRecord[] }> {
  const wakeStore = new WakeStore(deps.projectDir)
  await wakeStore.reconcileOrphans(now)

  const waitDeps = {
    wakeStore, projectDir: deps.projectDir,
    effectAdapters: deps.effectAdapters ?? defaultEffectAdapterRegistry(),
  }
  const allWakes = await wakeStore.list()
  const blockedPluginLoops = new Set<string>()
  for (const record of await listInstanceRecords(deps.projectDir)) {
    if (HALTED_STATUSES.has(record.status)) continue
    const instance = await loadInstance(deps.projectDir, record.instanceId, deps.scenarios).catch(error => {
      if (error instanceof ScenarioPluginError) blockedPluginLoops.add(record.instanceId)
      console.error(`[loop] scheduler skipped instance ${record.instanceId} (load failed):`,
        error instanceof Error ? error.message : String(error))
      return null
    })
    if (!instance) continue
    try {
      await ingestEvents(instance, waitDeps)
      const hasLiveWake = allWakes.some(
        w => w.loopId === record.instanceId && (w.status === 'pending' || w.status === 'claimed'),
      )
      if (record.status === 'waiting' && !hasLiveWake) {
        await reconcileWaiting(instance, waitDeps)
      } else if (record.status === 'idle' && !hasLiveWake) {
        await wakeStore.schedule({ loopId: record.instanceId, kind: 'timer', fireAt: now })
      }
    } catch (error) {
      if (error instanceof LedgerCorruptionError) {
        await setInstanceStatus(instance, 'failed', `ledger recovery failed: ${error.message}`)
        await wakeStore.cancelForLoop(record.instanceId)
        continue
      }
      // Per-instance fault isolation: one instance's I/O or reconcile failure
      // must not stop scheduling for every other loop in the workspace (and
      // must never crash the daemon poll loop). Log loudly and move on; the
      // next tick retries.
      console.error(`[loop] scheduler skipped instance ${record.instanceId}:`,
        error instanceof Error ? error.message : String(error))
    }
  }
  return {
    wakeStore,
    wakes: await wakeStore.claimDue(now, undefined, maxClaims, blockedPluginLoops),
  }
}

/** Slow scheduler phase for one already-claimed wake. Owns the wake's one and
 * only terminal disposition. */
export async function runClaimedWake(
  deps: TickDeps,
  wakeStore: WakeStore,
  wake: WakeRecord,
): Promise<TickOutcome> {
  const coordinationAbort = new AbortController()
  const forwardAbort = (): void => coordinationAbort.abort(deps.signal?.reason)
  if (deps.signal?.aborted) forwardAbort()
  else deps.signal?.addEventListener('abort', forwardAbort, { once: true })
  const wakeHeartbeat = setInterval(() => {
    void wakeStore.heartbeat(wake.wakeId, Date.now(), wake.claim?.token).catch(() => undefined)
  }, 60_000)
  wakeHeartbeat.unref?.()
  let roundLease: HostAdmissionHandle | null = null
  let resourceLease: HostAdmissionHandle | null = null
  let leaseHeartbeat: ReturnType<typeof setInterval> | null = null
  try {
    const instance = await loadInstance(deps.projectDir, wake.loopId, deps.scenarios)
    if (!instance) {
      await wakeStore.release(wake.wakeId, 'cancelled', { claimToken: wake.claim?.token })
      return { loopId: wake.loopId, error: 'instance not found' }
    }
    if (HALTED_STATUSES.has(instance.record.status)) {
      await wakeStore.release(wake.wakeId, 'cancelled', { claimToken: wake.claim?.token })
      return { loopId: wake.loopId, error: `instance is ${instance.record.status}` }
    }
    if (deps.hostCoordinator && deps.workspaceIdentity) {
      const scope = {
        workspaceId: deps.workspaceIdentity.workspaceId,
        instanceId: instance.record.instanceId,
        wakeId: wake.wakeId,
      }
      roundLease = await deps.hostCoordinator.acquireRound(scope, coordinationAbort.signal)
      leaseHeartbeat = setInterval(() => {
        void Promise.all([
          roundLease?.heartbeat() ?? Promise.resolve(true),
          resourceLease?.heartbeat() ?? Promise.resolve(true),
        ]).then(results => {
          if (results.some(ok => !ok)) coordinationAbort.abort(new Error('host coordination lease lost'))
        }).catch(() => coordinationAbort.abort(new Error('host coordination heartbeat failed')))
      }, deps.hostCoordinator.heartbeatIntervalMs)
      leaseHeartbeat.unref?.()
      const resources = instance.charter.seats.worker.hostRequirements?.resources ?? []
      resourceLease = await deps.hostCoordinator.acquireResources(scope, resources, coordinationAbort.signal)
    }
    const outcome = await runRound(instance, wake, {
      dispatcher: deps.dispatcher,
      projectDir: deps.projectDir,
      signal: coordinationAbort.signal,
      wakeStore,
      effectAdapters: deps.effectAdapters,
      observer: deps.observer,
      hostCoordinator: deps.hostCoordinator,
      workspaceIdentity: deps.workspaceIdentity,
      loopInstanceId: instance.record.instanceId,
      scenarios: deps.scenarios,
    })
    await wakeStore.release(
      wake.wakeId,
      outcome.route === 'stale-wake' ? 'cancelled' : 'done',
      { claimToken: wake.claim?.token },
    )
    // A cancelled stale wake may carry aborted-attempt cost; move it onto the
    // loop's live wake so the lifetime USD ledger cannot silently lose it.
    if (outcome.route === 'stale-wake' && (wake.abortedCostUsd ?? 0) > 0) {
      const carried = await wakeStore
        .transferAbortedCost(wake.loopId, wake.abortedCostUsd!)
        .catch(() => false)
      if (!carried) {
        console.error(
          `[loop] dropped ${wake.abortedCostUsd} USD aborted cost for ${wake.loopId}: no live wake to carry it`,
        )
      }
    }
    return { loopId: wake.loopId, outcome }
  } catch (err) {
    if (err instanceof WakeClaimLostError) {
      // A replacement execution owns the recovered wake. The stale worker may
      // neither alter status nor release/requeue that newer claim.
      return { loopId: wake.loopId, error: err.message }
    }
    if (err instanceof EffectConfigurationError) {
      return failStopLoop(deps, wakeStore, wake, `effect configuration failed: ${err.message}`, err.message)
    }
    if (err instanceof LedgerCorruptionError) {
      return failStopLoop(deps, wakeStore, wake, `ledger recovery failed: ${err.message}`, err.message)
    }
    if (err instanceof CharterEnforcementError) {
      // Charter/workspace mismatch (e.g. writeScope pointing at a missing
      // file): deterministic, retries can never fix it. Fail-stop instead of
      // requeueing the wake into a hot crash loop.
      return failStopLoop(deps, wakeStore, wake, `charter enforcement failed: ${err.message}`, err.message)
    }
    if (err instanceof RoundExecutionUncertainError) {
      return failStopLoop(
        deps, wakeStore, wake,
        `seat ${err.taskId} cancellation was not confirmed; operator reconciliation required`,
        err.message,
      )
    }
    if (err instanceof RoundAbortedError) {
      // Graceful cancellation (daemon restart) — replay immediately, no cap:
      // aborts are normal operations, not failures.
      await wakeStore.addAbortedCost(wake.wakeId, err.costUsd, wake.claim?.token).catch(() => undefined)
      const instance = await loadInstance(deps.projectDir, wake.loopId, deps.scenarios)
      if (instance) await setInstanceStatus(instance, 'idle', 'round safely cancelled; pending replay').catch(() => undefined)
      await wakeStore.release(wake.wakeId, 'pending', { claimToken: wake.claim?.token }).catch(() => undefined)
      return { loopId: wake.loopId, error: err.message }
    }
    // Unclassified error: retry with exponential backoff, and fail-stop after
    // MAX_WAKE_ATTEMPTS so a deterministic bug can neither hot-loop the wake
    // nor re-spend LLM budget every poll interval forever.
    const message = err instanceof Error ? err.message : String(err)
    if (wake.attempts >= MAX_WAKE_ATTEMPTS) {
      return failStopLoop(
        deps, wakeStore, wake,
        `round failed after ${wake.attempts} attempts: ${message}`, message,
      )
    }
    await wakeStore
      .release(wake.wakeId, 'pending', {
        fireAt: Date.now() + retryBackoffMs(wake.attempts),
        claimToken: wake.claim?.token,
      })
      .catch(() => undefined)
    return { loopId: wake.loopId, error: message }
  } finally {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat)
    await resourceLease?.release().catch(() => undefined)
    await roundLease?.release().catch(() => undefined)
    clearInterval(wakeHeartbeat)
    deps.signal?.removeEventListener('abort', forwardAbort)
  }
}

/**
 * Claim every due wake for this workspace and handle it (timer/event/manual —
 * each is a full kernel round; there are no code probes). Event files are
 * ingested up front so a dropped completion event converts into a harvest wake
 * within the same tick.
 */
export async function tickOnce(deps: TickDeps, now = Date.now()): Promise<TickResult> {
  const { wakeStore, wakes } = await prepareAndClaim(deps, now, DEFAULT_TICK_MAX_CLAIMS)
  const outcomes = await Promise.all(wakes.map(wake => runClaimedWake(deps, wakeStore, wake)))
  return { claimed: wakes.length, outcomes }
}

/** Run ticks until no wake is due right now (M1 "无人值守" driver for tests/CLI). */
export async function runUntilQuiescent(
  deps: TickDeps,
  opts?: { maxTicks?: number },
): Promise<TickResult[]> {
  const results: TickResult[] = []
  const maxTicks = opts?.maxTicks ?? 100
  for (let i = 0; i < maxTicks; i++) {
    const result = await tickOnce(deps)
    results.push(result)
    if (result.claimed === 0) break
  }
  return results
}
