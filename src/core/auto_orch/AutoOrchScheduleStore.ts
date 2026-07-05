import { randomUUID } from 'crypto'
import { hostname } from 'os'
import { mkdir, open, readFile, rm, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { atomicWriteJson, listJsonIds, readJsonFile } from '../persist/index.js'
import { META_AGENT_HOME } from '../metaAgentHome.js'
import type { OrchPlan } from './LoopIR.js'
import type { AutoOrchRunWorkspaceDescriptor } from './RunWorkspace.js'
import type { AutoOrchStoredPlanRef } from './PlanStore.js'

export type AutoOrchScheduleStatus =
  | 'scheduled'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AutoOrchScheduledResume {
  schemaVersion: '1.0'
  scheduleId: string
  orchestrationTaskId: string
  nodeId: string
  subTaskId: string
  agentSessionId: string
  /**
   * Workspace this schedule belongs to (absolute). The store is GLOBAL
   * (META_AGENT_HOME), so pickup MUST be scoped: a scheduler only claims
   * schedules for its own workspace. Filtering by (ephemeral) session id would
   * orphan paused runs when the creating process exits — the workspace is the
   * durable scope; `createdBySessionId` is recorded for observability only.
   */
  projectDir?: string
  /** Session that created the schedule (observability; NOT a pickup filter). */
  createdBySessionId?: string
  /**
   * Frozen goal of the paused run. Persisted so a resume executed by ANOTHER
   * process (daemon / later session) can hand role nodes the goal they judge
   * against — the creating session's in-memory goal dies with its process.
   */
  goal?: string
  externalRunId?: string
  resumeInstruction?: string
  runAt: number
  status: AutoOrchScheduleStatus
  attempts: number
  maxAttempts?: number
  plan: OrchPlan
  /** Approved/materialized plan version to append resumed run records to. */
  planRef?: AutoOrchStoredPlanRef
  /** Live run integration workspace to re-attach on resume (git runs only). */
  runWorkspace?: AutoOrchRunWorkspaceDescriptor
  createdAt: number
  updatedAt: number
  lastError?: string
  /** User-visible terminal notice surfaced on next CLI startup / orch-status. */
  terminalNotice?: string
  terminalAt?: number
  terminalNoticeAcknowledgedAt?: number
}

function dir(): string {
  return join(META_AGENT_HOME, 'auto_orch_schedules')
}

function pathFor(scheduleId: string): string {
  return join(dir(), `${scheduleId}.json`)
}

export function makeAutoOrchScheduleId(): string {
  return `auto-orch-schedule-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export async function writeAutoOrchSchedule(record: AutoOrchScheduledResume): Promise<void> {
  await atomicWriteJson(pathFor(record.scheduleId), record)
}

export async function readAutoOrchSchedule(scheduleId: string): Promise<AutoOrchScheduledResume | null> {
  return readJsonFile<AutoOrchScheduledResume>(pathFor(scheduleId))
}

export async function listAutoOrchSchedules(): Promise<AutoOrchScheduledResume[]> {
  const ids = await listJsonIds(dir())
  const records = await Promise.all(ids.map(id => readAutoOrchSchedule(id)))
  return records
    .filter((r): r is AutoOrchScheduledResume => r !== null)
    .sort((a, b) => a.runAt - b.runAt || a.createdAt - b.createdAt)
}

export interface AutoOrchScheduleScope {
  /** Only schedules whose projectDir matches (after resolve) are returned. */
  projectDir?: string
}

/**
 * Non-terminal schedules (scheduled/running) for a workspace — "pending".
 * Unlike due pickup, pending/quiescence is exact-scoped: a foreground waiter or
 * daemon must not stay alive forever because of an unrelated legacy record that
 * lacks projectDir. `listDueAutoOrchSchedules` still keeps such legacy records
 * claimable so old paused runs can self-heal.
 */
export async function listPendingAutoOrchSchedules(
  scope?: AutoOrchScheduleScope,
): Promise<AutoOrchScheduledResume[]> {
  const projectDir = scope?.projectDir ? resolve(scope.projectDir) : undefined
  return (await listAutoOrchSchedules())
    .filter(r =>
      (r.status === 'scheduled' || r.status === 'running') &&
      (!projectDir || (!!r.projectDir && resolve(r.projectDir) === projectDir)),
    )
}

export async function listDueAutoOrchSchedules(
  now = Date.now(),
  scope?: AutoOrchScheduleScope,
): Promise<AutoOrchScheduledResume[]> {
  const projectDir = scope?.projectDir ? resolve(scope.projectDir) : undefined
  return (await listAutoOrchSchedules())
    .filter(r =>
      r.status === 'scheduled' &&
      r.runAt <= now &&
      // Workspace scoping. Legacy records without projectDir stay claimable by
      // anyone (pre-scoping behaviour) so old paused runs are not orphaned.
      (!projectDir || !r.projectDir || resolve(r.projectDir) === projectDir),
    )
}

export async function listUnreportedAutoOrchTerminalNotices(
  scope?: AutoOrchScheduleScope,
): Promise<AutoOrchScheduledResume[]> {
  const projectDir = scope?.projectDir ? resolve(scope.projectDir) : undefined
  return (await listAutoOrchSchedules())
    .filter(r =>
      (r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled') &&
      !!r.terminalNotice &&
      !r.terminalNoticeAcknowledgedAt &&
      (!projectDir || !r.projectDir || resolve(r.projectDir) === projectDir),
    )
}

export async function acknowledgeAutoOrchTerminalNotice(scheduleId: string): Promise<boolean> {
  const record = await readAutoOrchSchedule(scheduleId)
  if (!record?.terminalNotice || record.terminalNoticeAcknowledgedAt) return false
  await writeAutoOrchSchedule({
    ...record,
    terminalNoticeAcknowledgedAt: Date.now(),
    updatedAt: Date.now(),
  })
  return true
}

// ── Atomic claim (cross-process double-resume guard) ────────────────────────────
//
// The schedule dir is shared by every meta-agent process on the machine, and
// "read status:'scheduled' → write status:'running'" is not atomic across
// processes. A claim file created with O_EXCL (flag 'wx') is: exactly one
// claimant wins the exclusive create. The claim guards the EXECUTION window
// only — it is released when the attempt finishes (including a re-pause, whose
// next fire re-claims). A crashed claimant leaves a stale claim; claims older
// than the TTL may be stolen (the rm+wx retry still serialises concurrent
// stealers: exactly one exclusive create wins).

const DEFAULT_CLAIM_TTL_MS = 6 * 60 * 60 * 1000

/** Stable identity for this process's claims. */
export function autoOrchClaimOwner(): string {
  return `${hostname()}#${process.pid}`
}

function claimPathFor(scheduleId: string): string {
  return join(dir(), `${scheduleId}.claim`)
}

export async function claimAutoOrchSchedule(
  scheduleId: string,
  owner: string = autoOrchClaimOwner(),
  ttlMs: number = DEFAULT_CLAIM_TTL_MS,
): Promise<boolean> {
  const path = claimPathFor(scheduleId)
  await mkdir(dir(), { recursive: true }).catch(() => undefined)
  const tryCreate = async (): Promise<boolean> => {
    try {
      const fh = await open(path, 'wx')
      try {
        await fh.writeFile(JSON.stringify({ owner, at: Date.now() }), 'utf-8')
      } finally {
        await fh.close()
      }
      return true
    } catch {
      return false
    }
  }
  if (await tryCreate()) return true
  // A claim exists — honour it unless stale.
  let claimedAt: number | undefined
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as { at?: unknown }
    if (typeof raw.at === 'number') claimedAt = raw.at
  } catch { /* unreadable → fall back to mtime */ }
  if (claimedAt === undefined) {
    try {
      claimedAt = (await stat(path)).mtimeMs
    } catch {
      return tryCreate() // claim vanished between checks — race once more
    }
  }
  if (Date.now() - claimedAt < ttlMs) return false
  await rm(path, { force: true }).catch(() => undefined)
  return tryCreate()
}

export async function releaseAutoOrchScheduleClaim(scheduleId: string): Promise<void> {
  await rm(claimPathFor(scheduleId), { force: true }).catch(() => undefined)
}

export async function cancelAutoOrchSchedule(scheduleId: string, reason?: string): Promise<boolean> {
  const record = await readAutoOrchSchedule(scheduleId)
  if (!record || !isCancellable(record.status)) return false
  await writeAutoOrchSchedule({
    ...record,
    status: 'cancelled',
    updatedAt: Date.now(),
    lastError: reason,
  })
  return true
}

export async function cancelAutoOrchSchedulesForAgentSession(
  agentSessionId: string,
  reason?: string,
): Promise<number> {
  return cancelMatching(r => r.agentSessionId === agentSessionId, reason)
}

export async function cancelAutoOrchSchedulesForOrchestration(
  orchestrationTaskId: string,
  reason?: string,
): Promise<number> {
  return cancelMatching(r => r.orchestrationTaskId === orchestrationTaskId, reason)
}

async function cancelMatching(
  pred: (record: AutoOrchScheduledResume) => boolean,
  reason?: string,
): Promise<number> {
  const records = await listAutoOrchSchedules()
  let n = 0
  const now = Date.now()
  await Promise.all(records.map(async record => {
    if (!pred(record) || !isCancellable(record.status)) return
    await writeAutoOrchSchedule({
      ...record,
      status: 'cancelled',
      updatedAt: now,
      lastError: reason,
    })
    n++
  }))
  return n
}

function isCancellable(status: AutoOrchScheduleStatus): boolean {
  return status === 'scheduled' || status === 'running'
}
