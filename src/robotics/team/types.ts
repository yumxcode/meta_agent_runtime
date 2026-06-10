/**
 * Public type definitions for team mode (v2.0).
 *
 * Three entities, no modules / no paths / no decisions:
 *   - TeamUnit:    a participant
 *   - TeamTask:    something someone is doing
 *   - TeamAttempt: an append-only entry: direction + outcome + ref
 *
 * Re-exported from TeamStore.ts so the existing
 *   import { ... } from './team/TeamStore.js'
 * imports continue to resolve.
 */

export type TeamTaskStatus = 'open' | 'paused' | 'done'

/**
 * Optional task lane for robotics collaboration:
 *   algo   — 算法（模型/控制/规划开发）
 *   exp    — 试验（仿真/实机实验与验证）
 *   deploy — 场景落地（集成/部署/现场调试）
 * Absent = uncategorised (fully backward compatible with existing boards).
 */
export type TeamTaskKind = 'algo' | 'exp' | 'deploy'

export const VALID_TASK_KINDS: TeamTaskKind[] = ['algo', 'exp', 'deploy']

export const TASK_KIND_LABELS: Record<TeamTaskKind, string> = {
  algo: '算法',
  exp: '试验',
  deploy: '落地',
}

/** ms threshold for "claim has gone stale" board warnings (7 days). */
export const STALE_CLAIM_MS = 7 * 24 * 60 * 60 * 1000

export interface TeamAttempt {
  at: string
  unit: string
  direction: string
  outcome: string
  ref?: string
}

export interface TeamTask {
  id: string
  title: string
  status: TeamTaskStatus
  /** Optional lane tag (algo|exp|deploy). Absent on legacy tasks. */
  kind?: TeamTaskKind
  /** Non-empty = locked; only owner can note/drop/done. */
  ownerUnit?: string
  /** ISO of claim time — drives stale-claim visual warnings on the board. */
  claimedAt?: string
  /** Append-only attempts log: directions tried + outcomes. */
  attempts: TeamAttempt[]
  updatedAt: string
}

export interface TeamUnit {
  id: string
  human?: string
  machine: string
  status: 'active' | 'away'
  currentTask?: string
  lastSeen: string
}

export interface TeamState {
  schemaVersion: '2.0'
  project: string
  github?: string
  goals: string[]
  tasks: TeamTask[]
  units: TeamUnit[]
  updatedAt: string
}

export const VALID_TASK_STATUSES: TeamTaskStatus[] = ['open', 'paused', 'done']

/** A task is active when someone owns it AND it's not done. */
export function isActiveTask(task: Pick<TeamTask, 'status' | 'ownerUnit'>): boolean {
  return Boolean(task.ownerUnit) && task.status !== 'done'
}

/** Returns true when the claim is older than STALE_CLAIM_MS. */
export function isStaleClaim(task: Pick<TeamTask, 'claimedAt' | 'status'>): boolean {
  if (task.status === 'done') return false
  if (!task.claimedAt) return false
  const claimed = Date.parse(task.claimedAt)
  if (Number.isNaN(claimed)) return false
  return Date.now() - claimed > STALE_CLAIM_MS
}
