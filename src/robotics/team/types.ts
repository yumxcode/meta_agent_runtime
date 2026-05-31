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
