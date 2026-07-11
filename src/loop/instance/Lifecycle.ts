/**
 * Lifecycle — manual pause / resume / stop as FIRST-CLASS state-machine moves
 * (v3 lifecycle extension). Design invariants:
 *
 *   • Reliability by reconstruction, not snapshots: pause simply cancels the
 *     wakes; resume derives every wake it needs from the durable truth
 *     (pending_round.json + effect ledger + events/) via the SAME
 *     ingestEvents/reconcileWaiting machinery that heals a kill -9. There is
 *     no snapshot file to lose or corrupt.
 *   • Crash-safe ordering: pause flips status BEFORE cancelling wakes — if we
 *     die in between, the runner sees paused_manual, refuses the leftover
 *     wake, and cancels it itself. The reverse order could leave an 'idle'
 *     loop with no wake: frozen forever with nothing to heal it.
 *   • Every intervention is audited in ledger/lifecycle.jsonl.
 *
 * Command semantics:
 *   pause  — idle|waiting → paused_manual (running is refused: never preempt a
 *            live seat; Ctrl+C or wait for the round boundary instead).
 *   resume — paused_manual → idle|waiting (wakes rebuilt);
 *            paused_attention → idle (LIGHT ACK: v3 re-arm — reset the meters
 *            behind the fired escalation, clear lastEscalation — without the
 *            charter version bump that `loop migrate` requires).
 *   stop   — graceful human termination from any non-running, non-terminal
 *            state: terminal RoundEntry {kind:'finalize', cause:'manual'},
 *            final_report.md, progress 'completed', instance 'done'. A parked
 *            round is abandoned but its cost/summaries are folded into the
 *            terminal entry (see stopLoopManually).
 */
import { WakeStore } from '../wake/WakeStore.js'
import { stopLoopManually, type ManualStopDeps } from '../kernel/LoopKernel.js'
import type { LoopInstance } from './InstanceStore.js'
import { setInstanceStatus } from './InstanceStore.js'
import { reArmResetTargets } from './Migrate.js'
import { clearPendingRound, ingestEvents, readPendingRound, reconcileWaiting } from '../effects/WaitOps.js'
import type { LoopInstanceStatus } from '../types.js'

export interface LifecycleDeps {
  wakeStore: WakeStore
  projectDir: string
}

/** One audited manual intervention (ledger/lifecycle.jsonl). */
export interface LifecycleEntry {
  at: number
  action: 'pause' | 'resume' | 'ack' | 'stop'
  reason?: string
  fromStatus: LoopInstanceStatus
  toStatus: LoopInstanceStatus
  /** Meters zeroed by an 'ack' (light re-arm of a paused escalation). */
  resetMeters?: string[]
  /** Reconcile actions taken while rebuilding wakes on resume. */
  healed?: string[]
}

async function audit(instance: LoopInstance, entry: LifecycleEntry): Promise<void> {
  await instance.ledger.appendJsonl(instance.paths.lifecycleJsonl, entry)
}

export interface LifecycleResult {
  status: LoopInstanceStatus
  message: string
}

// ── pause ─────────────────────────────────────────────────────────────────────

export async function pauseInstance(
  instance: LoopInstance,
  deps: LifecycleDeps,
  reason?: string,
): Promise<LifecycleResult> {
  const from = instance.record.status
  if (from === 'paused_manual') {
    return { status: from, message: 'already paused (no-op)' }
  }
  if (from !== 'idle' && from !== 'waiting') {
    throw new Error(
      `cannot pause while '${from}' — only idle|waiting instances pause ` +
      `(a running round is never preempted; interrupt it or wait for the boundary)`,
    )
  }
  // Status FIRST, wakes second (see header: the runner culls leftovers for a
  // paused instance, but nothing would heal an idle instance with no wake).
  // expectFrom re-validates ON DISK under the file lock: if the daemon flipped
  // the instance to 'running' after our check above, this throws instead of
  // silently clobbering a live round's status.
  await setInstanceStatus(instance, 'paused_manual', reason ?? `paused (was ${from})`, {
    expectFrom: ['idle', 'waiting'],
  })
  await deps.wakeStore.cancelForLoop(instance.record.instanceId)
  await audit(instance, {
    at: Date.now(), action: 'pause', reason, fromStatus: from, toStatus: 'paused_manual',
  })
  return { status: 'paused_manual', message: `paused (was ${from}); resume with: loop resume ${instance.record.instanceId}` }
}

// ── resume ────────────────────────────────────────────────────────────────────

export async function resumeInstance(
  instance: LoopInstance,
  deps: LifecycleDeps,
  reason?: string,
): Promise<LifecycleResult> {
  const from = instance.record.status
  if (from === 'paused_manual') return resumeManual(instance, deps, reason, from)
  if (from === 'paused_attention') return resumeAttention(instance, deps, reason, from)
  throw new Error(`cannot resume while '${from}' — only paused_manual|paused_attention instances resume`)
}

/** paused_manual → idle|waiting: rebuild wakes from durable state (no snapshot). */
async function resumeManual(
  instance: LoopInstance,
  deps: LifecycleDeps,
  reason: string | undefined,
  from: LoopInstanceStatus,
): Promise<LifecycleResult> {
  const pending = await readPendingRound(instance)
  const toStatus: LoopInstanceStatus = pending ? 'waiting' : 'idle'
  await setInstanceStatus(instance, toStatus, reason ?? 'resumed', { expectFrom: ['paused_manual'] })
  let healed: string[] = []
  if (pending) {
    // Events dropped while paused sat unconsumed in events/ — ingest them now
    // (concluded effect → harvest wake), then let RECONCILE re-arm whatever
    // else the parked round needs (self-timer wake, missing harvest wake, …).
    await ingestEvents(instance, deps)
    healed = await reconcileWaiting(instance, deps)
  } else {
    await deps.wakeStore.schedule({
      loopId: instance.record.instanceId, kind: 'timer', fireAt: Date.now(),
    })
  }
  await audit(instance, {
    at: Date.now(), action: 'resume', reason, fromStatus: from, toStatus,
    ...(healed.length ? { healed } : {}),
  })
  return { status: toStatus, message: `resumed to ${toStatus}${healed.length ? ` (healed: ${healed.join('; ')})` : ''}` }
}

/**
 * paused_attention → idle: the LIGHT ACK. Same v3 re-arm semantics as a
 * migration re-arm (reset the meters behind the fired tripwire so it cannot
 * re-fire instantly), but without amending the charter.
 */
async function resumeAttention(
  instance: LoopInstance,
  deps: LifecycleDeps,
  reason: string | undefined,
  from: LoopInstanceStatus,
): Promise<LifecycleResult> {
  const meterNames = new Set(instance.charter.meters.map(m => m.name))
  const resetMeters = reArmResetTargets(
    instance.charter, meterNames, instance.record.lastEscalation?.tripwireIndex,
  )
  const progress = await instance.ledger.readProgress()
  const meters = { ...progress.meters }
  for (const name of resetMeters) if (name in meters) meters[name] = 0
  await instance.ledger.writeProgress({
    ...progress, meters, status: 'healthy', updatedAt: Date.now(),
  })
  // lastEscalation is cleared atomically WITH the status write (the locked
  // write adopts disk state first, so an in-memory delete could resurrect).
  await setInstanceStatus(instance, 'idle', reason ?? 'human ack (loop resume)', {
    expectFrom: ['paused_attention'],
    lastEscalation: null,
  })
  await deps.wakeStore.schedule({
    loopId: instance.record.instanceId, kind: 'timer', fireAt: Date.now(),
  })
  await audit(instance, {
    at: Date.now(), action: 'ack', reason, fromStatus: from, toStatus: 'idle', resetMeters,
  })
  return {
    status: 'idle',
    message: `acknowledged escalation; meters reset: ${resetMeters.join(', ') || '(none)'}; next round scheduled`,
  }
}

// ── stop ──────────────────────────────────────────────────────────────────────

export async function stopInstance(
  instance: LoopInstance,
  deps: LifecycleDeps & Pick<ManualStopDeps, 'observer' | 'seatDeps'>,
  reason?: string,
): Promise<LifecycleResult> {
  const from = instance.record.status
  if (from === 'done') return { status: from, message: 'already done (no-op)' }
  if (from === 'running') {
    throw new Error("cannot stop while 'running' — interrupt the round first or wait for the boundary")
  }
  if (from === 'failed') {
    throw new Error("instance is 'failed' (already terminal) — inspect it or create a new loop")
  }
  const stopReason = reason ?? 'manual-stop'
  // Abandon a parked round explicitly, folding its cost/summaries into the
  // terminal entry so the ledger accounts for what the segment spent.
  const pending = await readPendingRound(instance)
  if (pending) await clearPendingRound(instance)
  const outcome = await stopLoopManually(
    instance,
    { wakeStore: deps.wakeStore, observer: deps.observer, seatDeps: deps.seatDeps },
    stopReason,
    pending ?? undefined,
  )
  await audit(instance, {
    at: Date.now(), action: 'stop', reason: stopReason, fromStatus: from, toStatus: 'done',
  })
  return {
    status: 'done',
    message: `stopped at round ${outcome.round} (${outcome.route}); final_report.md written`,
  }
}
