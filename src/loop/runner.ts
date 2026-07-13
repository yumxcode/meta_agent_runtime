/**
 * runner — claim-and-run glue between WakeStore and LoopKernel (spec C8, M1
 * subset: no daemon yet — `tickOnce` is what `meta-agent loop tick` and the
 * foreground waiter call; the M2 daemon wraps the same function in a poll
 * loop + child-process dispatch).
 */
import type { ISubAgentDispatcher } from '../subagent/ISubAgentDispatcher.js'
import { WakeStore } from './wake/WakeStore.js'
import type { WakeRecord } from './wake/WakeStore.js'
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

export interface TickDeps {
  dispatcher: ISubAgentDispatcher
  projectDir: string
  signal?: AbortSignal
  effectAdapters?: EffectAdapterRegistry
  /** Live per-round/seat progress (CLI renders it). */
  observer?: (event: LoopEvent) => void
}

export interface TickResult {
  claimed: number
  outcomes: TickOutcome[]
}

export type TickOutcome = { loopId: string; outcome?: RoundOutcome; error?: string }
const DEFAULT_TICK_MAX_CLAIMS = 4

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
  for (const record of await listInstanceRecords(deps.projectDir)) {
    if (HALTED_STATUSES.has(record.status)) continue
    const instance = await loadInstance(deps.projectDir, record.instanceId)
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
      if (!(error instanceof LedgerCorruptionError)) throw error
      await setInstanceStatus(instance, 'failed', `ledger recovery failed: ${error.message}`)
      await wakeStore.cancelForLoop(record.instanceId)
    }
  }
  return { wakeStore, wakes: await wakeStore.claimDue(now, undefined, maxClaims) }
}

/** Slow scheduler phase for one already-claimed wake. Owns the wake's one and
 * only terminal disposition. */
export async function runClaimedWake(
  deps: TickDeps,
  wakeStore: WakeStore,
  wake: WakeRecord,
): Promise<TickOutcome> {
  try {
    const instance = await loadInstance(deps.projectDir, wake.loopId)
    if (!instance) {
      await wakeStore.release(wake.wakeId, 'cancelled')
      return { loopId: wake.loopId, error: 'instance not found' }
    }
    if (HALTED_STATUSES.has(instance.record.status)) {
      await wakeStore.release(wake.wakeId, 'cancelled')
      return { loopId: wake.loopId, error: `instance is ${instance.record.status}` }
    }
    const outcome = await runRound(instance, wake, {
      dispatcher: deps.dispatcher,
      projectDir: deps.projectDir,
      signal: deps.signal ?? new AbortController().signal,
      wakeStore,
      effectAdapters: deps.effectAdapters,
      observer: deps.observer,
    })
    await wakeStore.release(wake.wakeId, outcome.route === 'stale-wake' ? 'cancelled' : 'done')
    return { loopId: wake.loopId, outcome }
  } catch (err) {
    if (err instanceof EffectConfigurationError) {
      const instance = await loadInstance(deps.projectDir, wake.loopId)
      if (instance) {
        await setInstanceStatus(instance, 'failed', `effect configuration failed: ${err.message}`).catch(() => undefined)
        await wakeStore.cancelForLoop(wake.loopId).catch(() => 0)
      } else {
        await wakeStore.release(wake.wakeId, 'cancelled').catch(() => undefined)
      }
      return { loopId: wake.loopId, error: err.message }
    }
    if (err instanceof LedgerCorruptionError) {
      const instance = await loadInstance(deps.projectDir, wake.loopId)
      if (instance) {
        await setInstanceStatus(instance, 'failed', `ledger recovery failed: ${err.message}`).catch(() => undefined)
        await wakeStore.cancelForLoop(wake.loopId).catch(() => 0)
      } else {
        await wakeStore.release(wake.wakeId, 'cancelled').catch(() => undefined)
      }
      return { loopId: wake.loopId, error: err.message }
    }
    if (err instanceof CharterEnforcementError) {
      // Charter/workspace mismatch (e.g. writeScope pointing at a missing
      // file): deterministic, retries can never fix it. Fail-stop instead of
      // requeueing the wake into a hot crash loop.
      const instance = await loadInstance(deps.projectDir, wake.loopId)
      if (instance) {
        await setInstanceStatus(instance, 'failed', `charter enforcement failed: ${err.message}`).catch(() => undefined)
        await wakeStore.cancelForLoop(wake.loopId).catch(() => 0)
      } else {
        await wakeStore.release(wake.wakeId, 'cancelled').catch(() => undefined)
      }
      return { loopId: wake.loopId, error: err.message }
    }
    if (err instanceof RoundExecutionUncertainError) {
      const instance = await loadInstance(deps.projectDir, wake.loopId)
      if (instance) {
        await setInstanceStatus(
          instance,
          'failed',
          `seat ${err.taskId} cancellation was not confirmed; operator reconciliation required`,
        ).catch(() => undefined)
        await wakeStore.cancelForLoop(wake.loopId).catch(() => 0)
      } else {
        await wakeStore.release(wake.wakeId, 'cancelled').catch(() => undefined)
      }
      return { loopId: wake.loopId, error: err.message }
    }
    if (err instanceof RoundAbortedError) {
      await wakeStore.addAbortedCost(wake.wakeId, err.costUsd).catch(() => undefined)
      const instance = await loadInstance(deps.projectDir, wake.loopId)
      if (instance) await setInstanceStatus(instance, 'idle', 'round safely cancelled; pending replay').catch(() => undefined)
    }
    await wakeStore.release(wake.wakeId, 'pending').catch(() => undefined)
    return { loopId: wake.loopId, error: err instanceof Error ? err.message : String(err) }
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
