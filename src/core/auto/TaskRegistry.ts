/**
 * TaskRegistry — the read model behind `meta-agent tasks` and its TUI.
 *
 * The unit here is a SESSION, not a wake. A wake is a single-use scheduling
 * token; one long-running task burns dozens of them over its life. The identity
 * (goal, progress, cost) lives in the auto checkpoint; the wake records only say
 * what is scheduled right now.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * On 2026-08-17 a session was rejected by a resume fence, its wake went
 * `cancelled` (terminal), and the scheduler exited because the queue was empty.
 * Every log line looked like a clean finish — `done`, `cancelled`, "no wakes
 * left". The 40-minute GPU run it was supervising was simply dropped, and it
 * took a human noticing "this doesn't feel finished" half an hour later.
 *
 * The state that was true the whole time, and that nothing could report:
 *
 *     checkpoint says `stopReason: parked`, but no wake is scheduled
 *
 * That is `orphaned` below. It is derivable from files that already exist, and
 * it is the single most valuable thing this module produces. Everything else is
 * decoration around it.
 */
import { resolve } from 'node:path'
import {
  AutoContinuationStore,
  isTerminalWakeStatus,
  type AutoContinuationRecord,
} from './AutoContinuationStore.js'
import {
  listAutoCheckpointSessionIds,
  readAutoCheckpoint,
  type AutoCheckpoint,
} from './AutoCheckpointStore.js'
import { pendingSteerCount } from './SteerChannel.js'
import {
  isSchedulerAlive,
  listKnownWorkspaces,
  listSchedulers,
  type SchedulerHeartbeat,
} from './SchedulerRegistry.js'

export type TaskStatus =
  /** A turn is executing right now (claim held and unexpired). */
  | 'running'
  /** Waiting for its moment. Normal, healthy state for a long task. */
  | 'parked'
  /** Due, but nothing claimed it — the workspace scheduler is gone or wedged. */
  | 'overdue'
  /** A claim outlived its lease: the executing process died mid-turn. */
  | 'stale-claim'
  /** Parked according to its checkpoint, but NO wake exists. It will never wake. */
  | 'orphaned'
  /** Ran to an end. Nothing is pending and nothing is wrong. */
  | 'finished'

/** Statuses that mean "a human should look at this now". */
export const UNHEALTHY_TASK_STATUSES: readonly TaskStatus[] =
  ['orphaned', 'overdue', 'stale-claim'] as const

export function isUnhealthy(status: TaskStatus): boolean {
  return UNHEALTHY_TASK_STATUSES.includes(status)
}

export interface TaskWakeView {
  wakeId: string
  fireAt: number
  reason: string
  attempts: number
  checkpoint?: Record<string, unknown>
  claim?: { owner: string; claimedAt: number; expiresAt: number }
}

export interface TaskView {
  workspace: string
  sessionId: string
  status: TaskStatus
  goal?: string
  note?: string
  /** The wake that determines `status` — pending or claimed. */
  wake?: TaskWakeView
  /** How the most recent finished wake ended. */
  lastOutcome?: 'done' | 'cancelled' | 'expired'
  lastOutcomeAt?: number
  progress: {
    turnCount?: number
    estimatedCostUsd?: number
    completedSteps: string[]
    pendingTodos: string[]
  }
  health: {
    compactions?: number
    driftCorrections?: number
    verifyRejections?: number
  }
  /**
   * Liveness of the scheduler for this workspace. Deliberately NOT folded into
   * `status`: a task parked for three more hours in a workspace whose scheduler
   * died is still correctly `parked` — nothing has failed yet — but a UI must
   * be able to warn that it is heading for `overdue`.
   */
  scheduler: {
    alive: boolean
    pid?: number
    host?: string
    lastSeen?: number
    configFile?: string
  }
  pendingSteerCount: number
  /**
   * `$META_AGENT_CONFIG_FILE` recorded on the wake — the provider profile this
   * session was ARMED under, which is the one any manual resume must use.
   * Undefined for wakes armed before this was recorded, or for the default
   * profile.
   */
  profile?: string
  /**
   * Non-default session-store root (`--session-dir`), when this task used one.
   * Deletion must look for the conversation history where it actually lives,
   * not where it usually lives.
   */
  sessionRoot?: string
  /** Checkpoint mtime — when this task last made durable progress. */
  updatedAt?: number
}

/**
 * How long past `fireAt` a pending wake may sit before it counts as `overdue`.
 *
 * Must exceed a normal claim latency: the scheduler polls every second by
 * default, and a busy one at `--max-concurrent 1` legitimately leaves a due
 * wake queued while another turn runs. A minute is far beyond either.
 */
export const DEFAULT_OVERDUE_GRACE_MS = 60_000

export interface DeriveTaskStatusInput {
  now: number
  pending?: AutoContinuationRecord
  claimed?: AutoContinuationRecord
  checkpointStopReason?: string
  overdueGraceMs?: number
}

/**
 * Pure status derivation — the whole judgement in one testable function.
 *
 * Order matters: an in-flight claim outranks anything else, and the
 * `orphaned` / `finished` split is decided ONLY when no wake is live.
 */
export function deriveTaskStatus(input: DeriveTaskStatusInput): TaskStatus {
  const grace = input.overdueGraceMs ?? DEFAULT_OVERDUE_GRACE_MS

  if (input.claimed) {
    return (input.claimed.claim?.expiresAt ?? 0) > input.now ? 'running' : 'stale-claim'
  }
  if (input.pending) {
    const lateBy = input.now - input.pending.fireAt
    return lateBy > grace ? 'overdue' : 'parked'
  }
  // No live wake. The checkpoint decides whether that is normal or fatal.
  return input.checkpointStopReason === 'parked' ? 'orphaned' : 'finished'
}

export interface CollectTasksOptions {
  /** Defaults to every workspace in the scheduler registry. */
  workspaces?: readonly string[]
  now?: number
  overdueGraceMs?: number
}

/** Build the task view for every session in the given (or known) workspaces. */
export async function collectTasks(options: CollectTasksOptions = {}): Promise<TaskView[]> {
  const now = options.now ?? Date.now()
  const workspaces = (options.workspaces ?? await listKnownWorkspaces()).map(w => resolve(w))
  const schedulers = await listSchedulers()

  const tasks: TaskView[] = []
  for (const workspace of workspaces) {
    tasks.push(...await collectWorkspaceTasks(workspace, schedulers, now, options.overdueGraceMs))
  }
  return sortTasks(tasks)
}

/**
 * Unhealthy first, then soonest-to-fire, then most recently active. A view that
 * has to be scrolled to find the broken row has failed at its one job.
 */
export function sortTasks(tasks: readonly TaskView[]): TaskView[] {
  const rank = (t: TaskView): number => {
    if (t.status === 'orphaned') return 0
    if (t.status === 'stale-claim') return 1
    if (t.status === 'overdue') return 2
    if (t.status === 'running') return 3
    if (t.status === 'parked') return 4
    return 5
  }
  return [...tasks].sort((a, b) =>
    rank(a) - rank(b) ||
    (a.wake?.fireAt ?? Infinity) - (b.wake?.fireAt ?? Infinity) ||
    (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  )
}

async function collectWorkspaceTasks(
  workspace: string,
  schedulers: readonly SchedulerHeartbeat[],
  now: number,
  overdueGraceMs?: number,
): Promise<TaskView[]> {
  const store = new AutoContinuationStore(workspace)
  // Deliberately the unlocked read: `list()` does not take the store lock, so a
  // UI can poll it once a second without ever contending with the scheduler.
  const wakes = await store.list().catch(() => [] as AutoContinuationRecord[])
  const checkpointIds = await listAutoCheckpointSessionIds(workspace)

  const sessionIds = new Set<string>([...checkpointIds, ...wakes.map(w => w.sessionId)])
  const scheduler = schedulerFor(workspace, schedulers, now)

  const views: TaskView[] = []
  for (const sessionId of sessionIds) {
    const own = wakes.filter(w => w.sessionId === sessionId)
    const pending = own.find(w => w.status === 'pending')
    const claimed = own.find(w => w.status === 'claimed')
    const checkpoint = readAutoCheckpoint(workspace, sessionId)
    const status = deriveTaskStatus({
      now,
      ...(pending ? { pending } : {}),
      ...(claimed ? { claimed } : {}),
      ...(checkpoint?.stopReason ? { checkpointStopReason: checkpoint.stopReason } : {}),
      ...(overdueGraceMs !== undefined ? { overdueGraceMs } : {}),
    })
    const live = claimed ?? pending
    const lastTerminal = own
      .filter(w => isTerminalWakeStatus(w.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]

    views.push({
      workspace,
      sessionId,
      status,
      ...(checkpoint?.goal ? { goal: checkpoint.goal } : {}),
      ...(checkpoint?.note ? { note: checkpoint.note } : {}),
      ...(live ? { wake: toWakeView(live) } : {}),
      ...(lastTerminal
        ? {
            lastOutcome: lastTerminal.status as 'done' | 'cancelled' | 'expired',
            lastOutcomeAt: lastTerminal.updatedAt,
          }
        : {}),
      progress: toProgress(checkpoint),
      health: toHealth(checkpoint),
      scheduler,
      // Prefer the live wake, but fall back to any wake this session ever
      // armed: an ORPHANED task has no live wake and is exactly the one whose
      // profile a human needs in order to resume it by hand.
      ...(profileOf(live, own) ? { profile: profileOf(live, own)! } : {}),
      ...(runtimeFieldOf(live, own, 'sessionDir')
        ? { sessionRoot: runtimeFieldOf(live, own, 'sessionDir')! }
        : {}),
      pendingSteerCount: await pendingSteerCount(workspace, sessionId).catch(() => 0),
      ...(checkpoint?.updatedAt ? { updatedAt: checkpoint.updatedAt } : {}),
    })
  }
  return views
}

/**
 * The scheduler serving this workspace. A workspace may hold several records
 * (restarts, or two schedulers by design), so prefer a live one and fall back
 * to the most recent corpse — which is what tells the operator "it WAS running,
 * and it is not any more".
 */
function schedulerFor(
  workspace: string,
  schedulers: readonly SchedulerHeartbeat[],
  now: number,
): TaskView['scheduler'] {
  const own = schedulers.filter(s => resolve(s.workspace) === workspace)
  const alive = own.find(s => isSchedulerAlive(s, now))
  const chosen = alive ?? own[0]
  if (!chosen) return { alive: false }
  return {
    alive: alive !== undefined,
    pid: chosen.pid,
    host: chosen.host,
    lastSeen: chosen.lastSeen,
    ...(chosen.configFile ? { configFile: chosen.configFile } : {}),
  }
}

/**
 * Read a runtime field from the live wake, falling back to the most recent wake
 * this session ever armed. The fallback is what makes an ORPHANED task usable:
 * it has no live wake, and it is precisely the one whose profile and session
 * root a human needs.
 */
function runtimeFieldOf(
  live: AutoContinuationRecord | undefined,
  all: readonly AutoContinuationRecord[],
  field: 'configFile' | 'sessionDir',
): string | undefined {
  if (live?.runtime?.[field]) return live.runtime[field]
  return [...all]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .find(r => r.runtime?.[field])?.runtime?.[field]
}

function profileOf(
  live: AutoContinuationRecord | undefined,
  all: readonly AutoContinuationRecord[],
): string | undefined {
  return runtimeFieldOf(live, all, 'configFile')
}

function toWakeView(record: AutoContinuationRecord): TaskWakeView {
  return {
    wakeId: record.wakeId,
    fireAt: record.fireAt,
    reason: record.reason,
    attempts: record.attempts,
    ...(record.checkpoint ? { checkpoint: record.checkpoint } : {}),
    ...(record.claim
      ? {
          claim: {
            owner: record.claim.owner,
            claimedAt: record.claim.claimedAt,
            expiresAt: record.claim.expiresAt,
          },
        }
      : {}),
  }
}

function toProgress(cp: AutoCheckpoint | null): TaskView['progress'] {
  return {
    ...(cp?.turnCount !== undefined ? { turnCount: cp.turnCount } : {}),
    ...(cp?.estimatedCostUsd !== undefined ? { estimatedCostUsd: cp.estimatedCostUsd } : {}),
    completedSteps: cp?.completedSteps ?? [],
    pendingTodos: cp?.pendingTodos ?? [],
  }
}

function toHealth(cp: AutoCheckpoint | null): TaskView['health'] {
  return {
    ...(cp?.compactions !== undefined ? { compactions: cp.compactions } : {}),
    ...(cp?.driftCorrections !== undefined ? { driftCorrections: cp.driftCorrections } : {}),
    ...(cp?.verifyRejections !== undefined ? { verifyRejections: cp.verifyRejections } : {}),
  }
}

/** Counts for a header line: `3 running · 2 parked · 1 ORPHANED`. */
export function summarize(tasks: readonly TaskView[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    running: 0, parked: 0, overdue: 0, 'stale-claim': 0, orphaned: 0, finished: 0,
  }
  for (const task of tasks) counts[task.status]++
  return counts
}
