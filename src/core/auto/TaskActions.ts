/**
 * TaskActions — the only mutations a task frontend may perform.
 *
 * Shared by `meta-agent tasks <action>` and the TUI so both obey identical
 * guards; a rule enforced in one surface and not the other is not a rule.
 *
 * The governing constraint: **a frontend never starts a turn.** It edits the
 * durable queue and lets the running scheduler execute. That keeps exactly one
 * execution path (no second copy of the claim/lease protocol), keeps the UI
 * usable without an API key, and avoids the UI having to know which provider
 * profile a session belongs to.
 *
 * `cancel` and `kill` are deliberately separate verbs over the same store call.
 * `AutoContinuationStore.cancel()` with no claim token will happily cancel a
 * CLAIMED record, at which point the executing process's heartbeat notices it
 * lost the claim and aborts the model turn mid-flight. That is a genuinely
 * useful kill switch and a terrible thing to trigger by reaching for "cancel
 * this timer".
 */
import { AutoContinuationStore } from './AutoContinuationStore.js'
import { deleteAutoCheckpoint, updateAutoCheckpointWithStatus } from './AutoCheckpointStore.js'
import { clearSteer, enqueueSteer } from './SteerChannel.js'
import { SessionStore } from '../SessionStore.js'
import type { TaskView } from './TaskRegistry.js'

export type TaskActionKind = 'run-now' | 'cancel' | 'kill' | 'steer' | 'delete'

export interface TaskActionResult {
  ok: boolean
  message: string
}

export interface TaskActionAvailability {
  allowed: boolean
  /** Why not, phrased for a human, when `allowed` is false. */
  reason?: string
  /** True for actions that interrupt work in progress. */
  destructive?: boolean
}

/**
 * Can this action apply to this task right now? Pure, so the TUI can grey out
 * a key and the CLI can refuse with the same sentence.
 */
export function actionAvailability(
  task: TaskView,
  kind: TaskActionKind,
): TaskActionAvailability {
  switch (kind) {
    case 'run-now':
      if (task.status === 'running') return { allowed: false, reason: 'already running' }
      if (task.status === 'orphaned') {
        return {
          allowed: false,
          reason: 'no wake exists to bring forward — resume it manually instead',
        }
      }
      if (!task.wake || (task.status !== 'parked' && task.status !== 'overdue')) {
        return { allowed: false, reason: 'nothing is scheduled' }
      }
      if (!task.scheduler.alive) {
        return {
          allowed: false,
          reason: 'no scheduler is running for this workspace; it would come due and sit there',
        }
      }
      return { allowed: true }

    case 'cancel':
      if (task.status === 'running') {
        return { allowed: false, reason: 'a turn is running — use kill to interrupt it' }
      }
      if (!task.wake || (task.status !== 'parked' && task.status !== 'overdue')) {
        return { allowed: false, reason: 'no pending wake to cancel' }
      }
      return { allowed: true }

    case 'kill':
      if (task.status !== 'running' && task.status !== 'stale-claim') {
        return { allowed: false, reason: 'no turn is running' }
      }
      return { allowed: true, destructive: true }

    case 'steer':
      if (task.status === 'finished' || task.status === 'orphaned') {
        return {
          allowed: false,
          reason: 'this session will not run again, so a correction would never be delivered',
        }
      }
      return { allowed: true }

    case 'delete':
      // Deleting the checkpoint and history out from under an executing turn
      // would leave it writing to files that no longer exist, and the operator
      // almost certainly meant to stop it first.
      if (task.status === 'running') {
        return { allowed: false, reason: 'a turn is running — kill it first, then delete' }
      }
      return { allowed: true, destructive: true }
  }
}

/** Bring a parked wake forward. The scheduler runs it on its next poll. */
export async function runTaskNow(task: TaskView): Promise<TaskActionResult> {
  const gate = actionAvailability(task, 'run-now')
  if (!gate.allowed) return { ok: false, message: `run-now refused: ${gate.reason}` }

  const store = new AutoContinuationStore(task.workspace)
  const moved = await store.fireNow(task.wake!.wakeId)
  return moved
    ? { ok: true, message: `${task.wake!.wakeId} is now due; the scheduler will pick it up within one poll.` }
    : { ok: false, message: `${task.wake!.wakeId} is no longer pending — nothing to bring forward.` }
}

/**
 * Drop a pending wake. The session stops waking; its history is untouched.
 *
 * The checkpoint MUST be marked in the same breath. `orphaned` is derived from
 * "checkpoint says parked, but no wake exists" — which is exactly the state a
 * bare `store.cancel()` leaves behind. Without this the view would light up red
 * forever for a task the operator deliberately stopped, and a deliberate stop
 * would be indistinguishable from the accidental one this whole view exists to
 * catch. `runAttachedAuto` has always paired the two writes for the same
 * reason; this is the same pairing.
 */
export async function cancelTaskWake(task: TaskView): Promise<TaskActionResult> {
  const gate = actionAvailability(task, 'cancel')
  if (!gate.allowed) return { ok: false, message: `cancel refused: ${gate.reason}` }

  const store = new AutoContinuationStore(task.workspace)
  const cancelled = await store.cancel(task.wake!.wakeId)
  if (!cancelled) {
    return { ok: false, message: `${task.wake!.wakeId} could not be cancelled (already terminal?).` }
  }
  await updateAutoCheckpointWithStatus(task.workspace, task.sessionId, {
    stopReason: 'cancelled_by_user',
    pendingWake: null,
  })
  return {
    ok: true,
    message:
      `${task.wake!.wakeId} cancelled. This session will NOT resume on its own; ` +
      `its history is intact and can be resumed manually.`,
  }
}

/**
 * Interrupt a turn that is executing right now.
 *
 * Cancelling the claimed record makes the executing process lose its claim; its
 * heartbeat sees that within 30s and aborts the model stream. Work already
 * written to the workspace is NOT rolled back — same semantics as Ctrl+C on an
 * attached run.
 */
export async function killTaskTurn(task: TaskView): Promise<TaskActionResult> {
  const gate = actionAvailability(task, 'kill')
  if (!gate.allowed) return { ok: false, message: `kill refused: ${gate.reason}` }

  const store = new AutoContinuationStore(task.workspace)
  const killed = await store.cancel(task.wake!.wakeId)
  return killed
    ? {
        ok: true,
        message:
          `${task.wake!.wakeId} cancelled; the running turn aborts at its next heartbeat (≤30s). ` +
          `Changes already made to the workspace are not rolled back.`,
      }
    : { ok: false, message: `${task.wake!.wakeId} could not be cancelled (already terminal?).` }
}

/** Queue a correction, delivered at the loop's next iteration boundary. */
export async function steerTask(task: TaskView, text: string): Promise<TaskActionResult> {
  const gate = actionAvailability(task, 'steer')
  if (!gate.allowed) return { ok: false, message: `steer refused: ${gate.reason}` }
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, message: 'steer needs some text.' }

  await enqueueSteer(task.workspace, task.sessionId, trimmed)
  return {
    ok: true,
    message: task.status === 'running'
      ? 'Correction queued; it lands as a user message at the next step boundary.'
      : 'Correction queued; it will be delivered when this session next resumes.',
  }
}

/**
 * Remove a task and everything behind it. IRREVERSIBLE.
 *
 * Deletes, in the order that keeps the view coherent if it fails halfway:
 *   1. wake records   — nothing can schedule it any more
 *   2. steer queue    — corrections for a session that will never read them
 *   3. checkpoint     — the task disappears from every view
 *   4. history        — the conversation itself
 *
 * Step 4 is the expensive one and it is why this is not a "hide" button: a
 * long-running task's history is hundreds of turns and tens of dollars of
 * accumulated context, and once it is gone `--resume` cannot bring the session
 * back. Callers must confirm before reaching this function; it does not ask.
 */
export async function deleteTask(task: TaskView): Promise<TaskActionResult> {
  const gate = actionAvailability(task, 'delete')
  if (!gate.allowed) return { ok: false, message: `delete refused: ${gate.reason}` }

  const wakes = await new AutoContinuationStore(task.workspace).purgeSession(task.sessionId)
  await clearSteer(task.workspace, task.sessionId).catch(() => undefined)
  await deleteAutoCheckpoint(task.workspace, task.sessionId).catch(() => undefined)
  await SessionStore.deleteSession(
    task.sessionId,
    task.sessionRoot ? { rootDir: task.sessionRoot } : {},
  )

  return {
    ok: true,
    message:
      `Deleted ${task.sessionId.slice(0, 8)}: ${wakes} wake record(s), its checkpoint, ` +
      `and its conversation history. This cannot be undone.`,
  }
}

/**
 * The command that revives a task no scheduler can revive for it.
 *
 * Names the binary that OWNS the session. A workspace served by a GLM-profile
 * scheduler must not be told to resume with plain `meta-agent`: the wake's
 * model/baseUrl are unset whenever the provider came from a config file, so the
 * session would silently continue on a different account and model.
 */
export function resumeCommandFor(task: TaskView): string {
  // The wake's own profile wins over the scheduler's: it is what the session
  // was actually armed under.
  const profile = task.profile ?? task.scheduler.configFile
  const bin = profile?.includes('glm') ? 'meta-agent-glm' : 'meta-agent'
  return `${bin} -w ${task.workspace} --mode auto --resume ${task.sessionId} "继续"`
}

export async function applyTaskAction(
  task: TaskView,
  kind: TaskActionKind,
  text?: string,
): Promise<TaskActionResult> {
  switch (kind) {
    case 'run-now': return runTaskNow(task)
    case 'cancel': return cancelTaskWake(task)
    case 'kill': return killTaskTurn(task)
    case 'steer': return steerTask(task, text ?? '')
    case 'delete': return deleteTask(task)
  }
}
