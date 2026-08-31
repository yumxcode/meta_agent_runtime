/**
 * SchedulerRegistry — Auto workspace discovery and scheduler liveness.
 *
 * Wake records are per-workspace (`<ws>/.meta-agent/auto/wakes/`), so nothing in
 * the system could answer "show me every long-running task on this machine".
 * The session index cannot serve as that directory either: it is capped at 50
 * entries and evicts, and long-running tasks are exactly the ones that get
 * pushed out.
 *
 * This registry is the missing piece, and it answers two questions at once:
 *
 *   1. DISCOVERY — which workspaces have armed durable Auto work, so a global
 *      view and managed scheduler know where to look before any daemon starts.
 *   2. LIVENESS — is a scheduler actually servicing that workspace right now.
 *
 * (2) matters because of a failure mode that is otherwise invisible: a pending
 * wake in a workspace whose scheduler is gone just sits there until
 * `staleWakeMs` (7 days) retires it unexecuted. Nothing reports it.
 *
 * A stopped scheduler is MARKED, never deleted. Deleting on exit would make a
 * workspace vanish from the global view at precisely the moment something went
 * wrong there — the record is the workspace registration, not just a liveness
 * token. Records are pruned only after they have been untouched for
 * `PRUNE_AFTER_MS`, and only by a starting scheduler (a writer), never by a
 * read path.
 */
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { META_AGENT_HOME } from '../../infra/metaAgentHome.js'
import {
  atomicWriteJson,
  deleteJsonFile,
  listJsonIds,
  readJsonFile,
} from '../../infra/persist/index.js'

export interface SchedulerHeartbeat {
  schemaVersion: '1.0'
  workspace: string
  pid: number
  host: string
  startedAt: number
  /** Refreshed on the scheduler's own poll tick — no extra timer. */
  lastSeen: number
  pollIntervalMs: number
  maxConcurrent: number
  /** Exact wake handled by a transient `tasks --manage` worker. */
  managedWakeId?: string
  /**
   * Which provider profile this scheduler runs under (`$META_AGENT_CONFIG_FILE`).
   * A workspace can legitimately be serviced by a GLM-profile scheduler while
   * another workspace uses the default one; without this the UI cannot tell an
   * operator which binary a task actually belongs to.
   */
  configFile?: string
  /** Set on graceful exit. Present = "this one is done", not "never existed". */
  stoppedAt?: number
}

/** A workspace containing durable Auto work, independent of scheduler state. */
export interface AutoWorkspaceRegistration {
  schemaVersion: '1.0'
  workspace: string
  updatedAt: number
}

/** Registry records untouched for this long are dropped by the next writer. */
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60_000

/** Floor for the liveness window, for schedulers polling faster than this. */
const MIN_STALE_MS = 30_000

/**
 * Minimum gap between heartbeat writes. Comfortably inside MIN_STALE_MS, so a
 * scheduler is never mistaken for dead, while a 1s poll writes once per five
 * seconds instead of once per second.
 */
const BEAT_MIN_INTERVAL_MS = 5_000

function registryDir(): string {
  return join(META_AGENT_HOME, 'schedulers')
}

function workspaceRegistryDir(): string {
  return join(META_AGENT_HOME, 'auto-workspaces')
}

function workspaceRecordId(workspace: string): string {
  return createHash('sha1')
    .update(resolve(workspace))
    .digest('hex')
    .slice(0, 16)
}

/**
 * One record per (host, workspace, pid). Including the pid keeps two schedulers
 * legitimately servicing the same workspace (the claim protocol allows it) from
 * overwriting each other's heartbeat and each reporting the other as dead.
 */
function recordId(host: string, workspace: string, pid: number): string {
  return createHash('sha1')
    .update(`${host}\0${resolve(workspace)}\0${pid}`)
    .digest('hex')
    .slice(0, 16)
}

function pathFor(id: string): string {
  return join(registryDir(), `${id}.json`)
}

/**
 * Is this process still around?
 *
 * `lastSeen` alone cannot tell a hung scheduler from one that was `kill -9`ed a
 * second ago — both look alive until the window elapses. On the same host a
 * signal-0 probe answers immediately and exactly, so a killed scheduler shows
 * up as dead in the UI on the very next refresh instead of up to 3 polls later.
 * Cross-host we have no such probe and fall back to the window.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

export function isSchedulerAlive(
  record: SchedulerHeartbeat,
  now = Date.now(),
): boolean {
  if (record.stoppedAt) return false
  if (record.host === hostname() && !pidAlive(record.pid)) return false
  const staleMs = Math.max(MIN_STALE_MS, record.pollIntervalMs * 3)
  return now - record.lastSeen <= staleMs
}

/** Every registered scheduler, alive or not, newest heartbeat first. */
export async function listSchedulers(): Promise<SchedulerHeartbeat[]> {
  const ids = await listJsonIds(registryDir())
  const records: SchedulerHeartbeat[] = []
  for (const id of ids) {
    const record = await readJsonFile<SchedulerHeartbeat>(pathFor(id), { tolerateUnreadable: true })
    if (record?.workspace && typeof record.lastSeen === 'number') records.push(record)
  }
  return records.sort((a, b) => b.lastSeen - a.lastSeen)
}

/** Distinct workspaces known from armed work or scheduler history, newest first. */
export async function listKnownWorkspaces(): Promise<string[]> {
  const seen = new Set<string>()
  const ordered: string[] = []

  const workspaceRecords: AutoWorkspaceRegistration[] = []
  for (const id of await listJsonIds(workspaceRegistryDir())) {
    const record = await readJsonFile<AutoWorkspaceRegistration>(
      join(workspaceRegistryDir(), `${id}.json`),
      { tolerateUnreadable: true },
    )
    if (record?.workspace && typeof record.updatedAt === 'number') workspaceRecords.push(record)
  }
  workspaceRecords.sort((a, b) => b.updatedAt - a.updatedAt)
  for (const record of workspaceRecords) {
    const workspace = resolve(record.workspace)
    if (seen.has(workspace)) continue
    seen.add(workspace)
    ordered.push(workspace)
  }

  for (const record of await listSchedulers()) {
    const workspace = resolve(record.workspace)
    if (seen.has(workspace)) continue
    seen.add(workspace)
    ordered.push(workspace)
  }
  return ordered
}

/**
 * Register at park time so `tasks --manage` can discover a workspace before
 * any standalone scheduler has ever run there.
 */
export async function registerKnownWorkspace(
  workspace: string,
  now = Date.now(),
): Promise<void> {
  const resolved = resolve(workspace)
  const record: AutoWorkspaceRegistration = {
    schemaVersion: '1.0',
    workspace: resolved,
    updatedAt: now,
  }
  await atomicWriteJson(
    join(workspaceRegistryDir(), `${workspaceRecordId(resolved)}.json`),
    record,
  )
}

/**
 * Handle held by a running scheduler. `beat()` is called from the existing poll
 * loop rather than its own timer, so a wedged loop stops beating — which is
 * exactly the signal we want.
 */
export class SchedulerRegistration {
  private readonly id: string
  private record: SchedulerHeartbeat

  private constructor(record: SchedulerHeartbeat) {
    this.record = record
    this.id = recordId(record.host, record.workspace, record.pid)
  }

  static async register(input: {
    workspace: string
    pollIntervalMs: number
    maxConcurrent: number
    managedWakeId?: string
    now?: number
  }): Promise<SchedulerRegistration> {
    const now = input.now ?? Date.now()
    const record: SchedulerHeartbeat = {
      schemaVersion: '1.0',
      workspace: resolve(input.workspace),
      pid: process.pid,
      host: hostname(),
      startedAt: now,
      lastSeen: now,
      pollIntervalMs: input.pollIntervalMs,
      maxConcurrent: input.maxConcurrent,
      ...(input.managedWakeId ? { managedWakeId: input.managedWakeId } : {}),
      ...(process.env['META_AGENT_CONFIG_FILE']?.trim()
        ? { configFile: process.env['META_AGENT_CONFIG_FILE']!.trim() }
        : {}),
    }
    const registration = new SchedulerRegistration(record)
    await registration.write()
    // Housekeeping belongs to a writer, never to the read path a UI polls.
    await pruneAncient(now).catch(() => 0)
    return registration
  }

  /**
   * Refresh liveness. Called on every scheduler poll — once a second by default
   * — so it throttles: the liveness window is at least 30s wide, and writing
   * the same file 86,400 times a day to prove a fact that is checked against a
   * 30-second window is pure churn.
   */
  async beat(now = Date.now()): Promise<void> {
    if (now - this.record.lastSeen < BEAT_MIN_INTERVAL_MS) return
    this.record = { ...this.record, lastSeen: now }
    await this.write().catch(() => undefined)
  }

  /** Graceful exit: mark, do not delete — see the module header. */
  async markStopped(now = Date.now()): Promise<void> {
    this.record = { ...this.record, lastSeen: now, stoppedAt: now }
    await this.write().catch(() => undefined)
  }

  private async write(): Promise<void> {
    await atomicWriteJson(pathFor(this.id), this.record)
  }
}

/** Drop records nobody has touched for PRUNE_AFTER_MS. Returns how many. */
export async function pruneAncient(now = Date.now()): Promise<number> {
  let pruned = 0
  for (const id of await listJsonIds(registryDir())) {
    const record = await readJsonFile<SchedulerHeartbeat>(pathFor(id), { tolerateUnreadable: true })
    const touched = record?.lastSeen ?? 0
    if (now - touched < PRUNE_AFTER_MS) continue
    await deleteJsonFile(pathFor(id))
    pruned++
  }
  return pruned
}
