/**
 * runner — claim-and-run glue between WakeStore and LoopKernel (spec C8, M1
 * subset: no daemon yet — `tickOnce` is what `meta-agent loop tick` and the
 * foreground waiter call; the M2 daemon wraps the same function in a poll
 * loop + child-process dispatch).
 */
import type { ISubAgentDispatcher } from '../subagent/ISubAgentDispatcher.js'
import { WakeStore } from './wake/WakeStore.js'
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

export interface TickDeps {
  dispatcher: ISubAgentDispatcher
  projectDir: string
  signal?: AbortSignal
  /** Live per-round/seat progress (CLI renders it). */
  observer?: (event: LoopEvent) => void
}

export interface TickResult {
  claimed: number
  outcomes: Array<{ loopId: string; outcome?: RoundOutcome; probe?: string; error?: string }>
}

/**
 * Claim every due wake for this workspace and handle it:
 *   probe wakes → pure-code probe (cheap, in-process, no LLM);
 *   timer/event/manual → a full kernel round (LLM seats).
 * Event files are ingested up front so a dropped completion event converts
 * into a harvest wake within the same tick.
 */
export async function tickOnce(deps: TickDeps, now = Date.now()): Promise<TickResult> {
  const wakeStore = new WakeStore(deps.projectDir)
  await wakeStore.reconcileOrphans(now)

  // Event ingestion + self-heal for every instance in the workspace. Instances
  // are enumerated from DISK, never from wake records: an event-waiting loop
  // legitimately has no wakes at all (its resume signal is an events/ file).
  // Halted (paused/terminal) instances must not consume events: a paused
  // loop's external results stay in events/ untouched until `loop resume`
  // re-ingests them — pause is a real freeze, not merely "no rounds".
  const waitDeps = { wakeStore, projectDir: deps.projectDir }
  const allWakes = await wakeStore.list()
  for (const record of await listInstanceRecords(deps.projectDir)) {
    if (HALTED_STATUSES.has(record.status)) continue
    const instance = await loadInstance(deps.projectDir, record.instanceId)
    if (!instance) continue
    await ingestEvents(instance, waitDeps).catch(() => 0)
    const hasLiveWake = allWakes.some(
      w => w.loopId === record.instanceId && (w.status === 'pending' || w.status === 'claimed'),
    )
    if (record.status === 'waiting' && !hasLiveWake) {
      // A parked round whose wake was lost to a crash — run the same healer a
      // round runs at RECONCILE (re-arms self-timer / harvest wakes).
      await reconcileWaiting(instance, waitDeps).catch(() => [])
    } else if (record.status === 'idle' && !hasLiveWake) {
      // createInstance/completeRound crashed between the state write and the
      // wake schedule — an idle loop with no wake would otherwise freeze
      // forever (nothing else re-arms it). schedule() coalesces: idempotent.
      await wakeStore.schedule({ loopId: record.instanceId, kind: 'timer', fireAt: now })
    }
  }

  const due = await wakeStore.claimDue(now)
  const outcomes: TickResult['outcomes'] = []
  for (const wake of due) {
    try {
      const instance = await loadInstance(deps.projectDir, wake.loopId)
      if (!instance) {
        await wakeStore.release(wake.wakeId, 'cancelled')
        outcomes.push({ loopId: wake.loopId, error: 'instance not found' })
        continue
      }
      if (HALTED_STATUSES.has(instance.record.status)) {
        // Refuse AND cull: leftover wakes for a paused/terminal instance are
        // cancelled here, which is what makes pause's status-first ordering
        // crash-safe (a wake surviving the pause gets swept on the next tick).
        await wakeStore.release(wake.wakeId, 'cancelled')
        outcomes.push({ loopId: wake.loopId, error: `instance is ${instance.record.status}` })
        continue
      }
      const outcome = await runRound(instance, wake, {
        dispatcher: deps.dispatcher,
        projectDir: deps.projectDir,
        signal: deps.signal ?? new AbortController().signal,
        wakeStore,
        observer: deps.observer,
      })
      await wakeStore.release(wake.wakeId, outcome.route === 'stale-wake' ? 'cancelled' : 'done')
      outcomes.push({ loopId: wake.loopId, outcome })
    } catch (err) {
      if (err instanceof LedgerCorruptionError) {
        const instance = await loadInstance(deps.projectDir, wake.loopId)
        if (instance) {
          await setInstanceStatus(instance, 'failed', `ledger recovery failed: ${err.message}`).catch(() => undefined)
          await wakeStore.cancelForLoop(wake.loopId).catch(() => 0)
        } else {
          await wakeStore.release(wake.wakeId, 'cancelled').catch(() => undefined)
        }
        outcomes.push({ loopId: wake.loopId, error: err.message })
        continue
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
        outcomes.push({ loopId: wake.loopId, error: err.message })
        continue
      }
      if (err instanceof RoundAbortedError) {
        await wakeStore.addAbortedCost(wake.wakeId, err.costUsd).catch(() => undefined)
        const instance = await loadInstance(deps.projectDir, wake.loopId)
        if (instance) await setInstanceStatus(instance, 'idle', 'round safely cancelled; pending replay').catch(() => undefined)
      }
      // A crashed round re-queues its wake (claim TTL would also recover it,
      // but an in-process failure can requeue immediately and cheaply).
      await wakeStore.release(wake.wakeId, 'pending').catch(() => undefined)
      outcomes.push({ loopId: wake.loopId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { claimed: due.length, outcomes }
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
