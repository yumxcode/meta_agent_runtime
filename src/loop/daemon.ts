/** Durable Graph scheduler: claim wakes and dispatch graph ticks concurrently. */
import { link, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { CLI_VERSION } from '../cli/version.js'
import {
  HostSchedulerCoordinator,
  WorkspaceIdentityConflictError,
  type HostAdmissionHandle,
  type HostCoordinatorOptions,
} from './host/HostSchedulerCoordinator.js'
import { listGraphInstanceRecords } from './graph/index.js'
import { prepareAndClaim, runClaimedWake, type TickDeps, type TickOutcome, type TickResult } from './runner.js'
import { WakeStore } from './wake/WakeStore.js'
import { ensureWorkspaceIdentity } from './workspace/WorkspaceIdentity.js'

export interface DaemonOptions extends TickDeps {
  pollMs?: number
  idleExitMs?: number
  onTick?: (result: TickResult) => void
  now?: () => number
  lockFreshMs?: number
  lockHeartbeatMs?: number
  maxConcurrentGraphs?: number
  hostCoordinatorOptions?: HostCoordinatorOptions
  hostCoordinator?: HostSchedulerCoordinator
}

export interface DaemonResult {
  ticks: number
  graphTicksRun: number
  exitReason: 'idle' | 'aborted' | 'lock_held' | 'workspace_identity_conflict'
}

const LOCK_FRESH_MS = 5 * 60_000
const LOCK_HEARTBEAT_MS = 60_000
const WAKE_RETENTION_MS = 7 * 24 * 60 * 60_000

export async function runLoopScheduler(options: DaemonOptions): Promise<DaemonResult> {
  const now = options.now ?? Date.now
  const pollMs = Math.max(10, options.pollMs ?? 2_000)
  const idleExitMs = options.idleExitMs ?? 60_000
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrentGraphs ?? 4))
  const lockPath = join(resolve(options.projectDir), '.loop', 'daemon.lock')
  const lockFreshMs = Math.max(100, options.lockFreshMs ?? LOCK_FRESH_MS)
  const lockHeartbeatMs = Math.max(10, Math.min(options.lockHeartbeatMs ?? LOCK_HEARTBEAT_MS, Math.floor(lockFreshMs / 3)))
  const token = await acquireDaemonLock(lockPath, lockFreshMs)
  if (!token) return { ticks: 0, graphTicksRun: 0, exitReason: 'lock_held' }

  const identity = await ensureWorkspaceIdentity(options.projectDir)
  const host = options.hostCoordinator ?? new HostSchedulerCoordinator(options.hostCoordinatorOptions)
  let workspaceLease: HostAdmissionHandle
  try {
    workspaceLease = await host.acquireWorkspaceLease(identity, options.projectDir, CLI_VERSION)
  } catch (error) {
    await releaseDaemonLock(lockPath, token)
    if (error instanceof WorkspaceIdentityConflictError) {
      return { ticks: 0, graphTicksRun: 0, exitReason: 'workspace_identity_conflict' }
    }
    throw error
  }

  const abort = new AbortController()
  const forwardAbort = (): void => abort.abort(options.signal?.reason)
  if (options.signal?.aborted) forwardAbort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })
  const lockHeartbeat = setInterval(() => void refreshLock(lockPath, token).catch(() => undefined), lockHeartbeatMs)
  const workspaceHeartbeat = setInterval(() => {
    void workspaceLease.heartbeat().then(ok => {
      if (!ok) abort.abort(new Error('workspace scheduler lease lost'))
    }).catch(() => abort.abort(new Error('workspace scheduler heartbeat failed')))
  }, host.heartbeatIntervalMs)
  lockHeartbeat.unref?.()
  workspaceHeartbeat.unref?.()

  const deps: TickDeps = {
    graphAgent: options.graphAgent,
    projectDir: options.projectDir,
    signal: abort.signal,
    graphCatalog: options.graphCatalog,
    hostCoordinator: host,
    workspaceIdentity: identity,
    onGraphProgress: options.onGraphProgress,
  }
  const wakeStore = new WakeStore(options.projectDir)
  const inFlight = new Map<string, Promise<void>>()
  const completed: TickOutcome[] = []
  let ticks = 0
  let graphTicksRun = 0
  let idleSince: number | null = null
  let nextPruneAt = 0
  try {
    for (;;) {
      if (completed.length) {
        const outcomes = completed.splice(0)
        graphTicksRun += outcomes.filter(outcome => outcome.graphOutcome).length
        options.onTick?.({ claimed: outcomes.length, outcomes })
      }
      if (abort.signal.aborted) {
        await Promise.allSettled(inFlight.values())
        return { ticks, graphTicksRun, exitReason: 'aborted' }
      }
      await refreshLock(lockPath, token)
      const tickNow = now()
      if (tickNow >= nextPruneAt) {
        await wakeStore.prune(WAKE_RETENTION_MS, tickNow).catch(() => 0)
        nextPruneAt = tickNow + 60 * 60_000
      }
      const available = maxConcurrent - inFlight.size
      const claimed = available > 0
        ? await prepareAndClaim(deps, tickNow, available)
        : { wakeStore, wakes: [] }
      ticks++
      for (const wake of claimed.wakes) {
        const task = runClaimedWake(deps, claimed.wakeStore, wake)
          .then(outcome => { completed.push(outcome) })
          .catch(error => { completed.push({ loopId: wake.loopId, error: error instanceof Error ? error.message : String(error) }) })
          .finally(() => { inFlight.delete(wake.wakeId) })
        inFlight.set(wake.wakeId, task)
      }

      const liveWakes = (await wakeStore.list()).some(wake => wake.status === 'pending' || wake.status === 'claimed')
      const waiting = (await listGraphInstanceRecords(options.projectDir)).some(record => record.status === 'waiting')
      if (!liveWakes && !waiting && inFlight.size === 0) {
        idleSince ??= now()
        if (now() - idleSince >= idleExitMs) return { ticks, graphTicksRun, exitReason: 'idle' }
      } else idleSince = null
      await sleep(pollMs, abort.signal)
    }
  } finally {
    clearInterval(lockHeartbeat)
    clearInterval(workspaceHeartbeat)
    options.signal?.removeEventListener('abort', forwardAbort)
    await workspaceLease.release().catch(() => undefined)
    await releaseDaemonLock(lockPath, token)
  }
}

interface DaemonLockRecord { pid: number; host: string; token: string; at: number }

export async function acquireDaemonLock(lockPath: string, freshMs = LOCK_FRESH_MS): Promise<string | null> {
  await mkdir(join(lockPath, '..'), { recursive: true }).catch(() => undefined)
  const raw = await readFile(lockPath, 'utf8').catch(() => null)
  if (raw !== null) {
    // A lock whose content cannot be parsed was left by a crashed/interrupted
    // writer. It must never be treated as held forever: once its mtime goes
    // stale it is reclaimed exactly like an orphaned healthy lock. While it is
    // still fresh we conservatively back off (a writer may be mid-crash).
    let held: DaemonLockRecord | null = null
    try { held = JSON.parse(raw) as DaemonLockRecord } catch { held = null }
    const info = await stat(lockPath).catch(() => null)
    const fresh = !!info && Date.now() - info.mtimeMs < freshMs
    const heldByLive = !!held &&
      ((held.host !== hostname() && fresh) || (held.host === hostname() && isAlive(held.pid) && fresh))
    if (heldByLive || (!held && fresh)) return null
    const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`
    try {
      await rename(lockPath, stalePath)
      await rm(stalePath, { force: true })
    } catch { return null }
  }
  const token = randomUUID()
  // Atomic create-if-absent WITH atomic content: write the record to a private
  // temp file first, then link() it into place. link() fails with EEXIST when
  // the lock exists (exclusivity) and never exposes a half-written lock file
  // (a crash mid-writeFile('wx') previously could — and a corrupt lock used to
  // wedge this function permanently).
  const tmpPath = `${lockPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(tmpPath, JSON.stringify({ pid: process.pid, host: hostname(), token, at: Date.now() } satisfies DaemonLockRecord))
    await link(tmpPath, lockPath)
    return token
  } catch {
    return null
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined)
  }
}

async function refreshLock(lockPath: string, token: string): Promise<void> {
  try {
    const held = JSON.parse(await readFile(lockPath, 'utf8')) as DaemonLockRecord
    if (held.pid === process.pid && held.host === hostname() && held.token === token) {
      const time = new Date()
      await utimes(lockPath, time, time)
    }
  } catch { /* the next scheduler iteration observes loss */ }
}

export async function releaseDaemonLock(lockPath: string, token: string): Promise<void> {
  try {
    const held = JSON.parse(await readFile(lockPath, 'utf8')) as DaemonLockRecord
    if (held.pid === process.pid && held.host === hostname() && held.token === token) await rm(lockPath, { force: true })
  } catch { /* already gone */ }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolvePromise => {
    const timer = setTimeout(done, ms)
    function done(): void {
      signal?.removeEventListener('abort', done)
      clearTimeout(timer)
      resolvePromise()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
