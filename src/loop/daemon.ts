/**
 * daemon — the loop-scheduler poll loop (spec C8/T2.4; SchedulerKeepAlive
 * layer B generalised).
 *
 * The daemon owns exactly three verbs: CLAIM (via tickOnce), PROBE (inline,
 * pure code), DISPATCH (rounds — in-process here; the child-process spawn is
 * an ops refinement that does not change this contract). It is stateless: all
 * truth lives in charter/ledger/effects/wakes, so killing the daemon at any
 * point loses nothing (D11).
 *
 * Lifecycle:
 *   • host lock — at most one daemon per workspace (stale locks from dead
 *     pids are reaped);
 *   • idle exit — when no pending wake exists and no instance is waiting for
 *     longer than `idleExitMs`, the daemon exits 0 (layer C self-heal or the
 *     next CLI invocation restarts it when needed).
 */
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { hostname } from 'os'
import { randomUUID } from 'crypto'
import { tickOnce, type TickDeps, type TickResult } from './runner.js'
import { listInstanceRecords } from './instance/InstanceStore.js'
import { WakeStore } from './wake/WakeStore.js'

export interface DaemonOptions extends TickDeps {
  pollMs?: number
  /** Exit after this long with nothing pending. Default 60 s. */
  idleExitMs?: number
  /** Observer for each non-empty tick (CLI renders progress). */
  onTick?: (result: TickResult) => void
  /** Test hook: clock source. */
  now?: () => number
  /** Cross-host lease freshness window. Default 5 min. Primarily a test hook. */
  lockFreshMs?: number
  /** Independent lease heartbeat interval. Default 60 s. Primarily a test hook. */
  lockHeartbeatMs?: number
}

export interface DaemonResult {
  ticks: number
  roundsRun: number
  probesRun: number
  exitReason: 'idle' | 'aborted' | 'lock_held'
}

const LOCK_FILE = 'daemon.lock'

export async function runLoopScheduler(opts: DaemonOptions): Promise<DaemonResult> {
  const pollMs = Math.max(10, opts.pollMs ?? 2_000)
  const idleExitMs = opts.idleExitMs ?? 60_000
  const now = opts.now ?? Date.now
  const lockDir = join(resolve(opts.projectDir), '.loop')
  const lockPath = join(lockDir, LOCK_FILE)

  const lockFreshMs = Math.max(100, opts.lockFreshMs ?? LOCK_FRESH_MS)
  const lockHeartbeatMs = Math.max(10, Math.min(
    opts.lockHeartbeatMs ?? LOCK_HEARTBEAT_MS,
    Math.max(10, Math.floor(lockFreshMs / 3)),
  ))
  const lockToken = await acquireLock(lockPath, lockFreshMs)
  if (!lockToken) {
    return { ticks: 0, roundsRun: 0, probesRun: 0, exitReason: 'lock_held' }
  }
  // This timer is independent of tickOnce(): a model seat can legally run for
  // hours, so refreshing only between ticks lets a cross-host observer reap a
  // live daemon's 5-minute lease mid-round.
  const lockHeartbeat = setInterval(() => {
    void refreshLock(lockPath, lockToken).catch(() => undefined)
  }, lockHeartbeatMs)
  lockHeartbeat.unref?.()
  const wakeStore = new WakeStore(opts.projectDir)
  let ticks = 0
  let roundsRun = 0
  let probesRun = 0
  let idleSince: number | null = null
  try {
    for (;;) {
      if (opts.signal?.aborted) return { ticks, roundsRun, probesRun, exitReason: 'aborted' }

      await refreshLock(lockPath, lockToken)
      const result = await tickOnce(
        { dispatcher: opts.dispatcher, projectDir: opts.projectDir, signal: opts.signal, observer: opts.observer },
        now(),
      )
      ticks++
      if (result.claimed > 0) {
        roundsRun += result.outcomes.filter(o => o.outcome).length
        probesRun += result.outcomes.filter(o => o.probe).length
        opts.onTick?.(result)
        idleSince = null
        continue // drain immediately while there is work
      }

      // Idle detection: pending OR claimed wakes (even future ones) keep us
      // alive — and so does any WAITING instance: an event wait has no wake by
      // design (its resume signal is an external events/ file), and only a
      // live process can ingest that file when it arrives.
      const live = (await wakeStore.list()).filter(
        w => w.status === 'pending' || w.status === 'claimed',
      )
      const hasWaiting = live.length === 0 &&
        (await listInstanceRecords(opts.projectDir)).some(r => r.status === 'waiting')
      if (live.length === 0 && !hasWaiting) {
        idleSince ??= now()
        if (now() - idleSince >= idleExitMs) {
          return { ticks, roundsRun, probesRun, exitReason: 'idle' }
        }
      } else {
        idleSince = null
      }
      await sleep(pollMs, opts.signal)
    }
  } finally {
    clearInterval(lockHeartbeat)
    await releaseLock(lockPath, lockToken)
  }
}

/** A lock older than this (mtime) is presumed orphaned. The holder refreshes
 * its lock every poll iteration, so a live daemon's lock stays far fresher. */
const LOCK_FRESH_MS = 5 * 60_000
const LOCK_HEARTBEAT_MS = 60_000

interface DaemonLockRecord {
  pid: number
  host: string
  token: string
  at: number
}

async function acquireLock(lockPath: string, freshMs: number): Promise<string | null> {
  await mkdir(join(lockPath, '..'), { recursive: true }).catch(() => undefined)
  try {
    const raw = await readFile(lockPath, 'utf-8')
    const held = JSON.parse(raw) as DaemonLockRecord
    if (held.host === hostname()) {
      if (isAlive(held.pid)) return null
    } else {
      // Cross-host (shared dir): pid liveness is unknowable here — judge by
      // lock freshness instead of reaping unconditionally, which would let two
      // hosts run duelling daemons over the same workspace.
      const st = await stat(lockPath).catch(() => null)
      if (st && Date.now() - st.mtimeMs < freshMs) return null
    }
    // Claim the stale inode with an atomic rename. Direct rm() has a race where
    // two contenders can delete each other's freshly-created lock.
    const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`
    try {
      await rename(lockPath, stalePath)
      await rm(stalePath, { force: true })
    } catch {
      return null
    }
  } catch {
    // no lock file — free to take it
  }
  const token = randomUUID()
  try {
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid, host: hostname(), token, at: Date.now(),
    } satisfies DaemonLockRecord), {
      flag: 'wx', // exclusive create — loser of a race backs off
    })
    return token
  } catch {
    return null
  }
}

/** Touch the lock's mtime so cross-host observers see the holder is alive. */
async function refreshLock(lockPath: string, token: string): Promise<void> {
  try {
    const held = JSON.parse(await readFile(lockPath, 'utf-8')) as DaemonLockRecord
    if (held.pid === process.pid && held.host === hostname() && held.token === token) {
      const t = new Date()
      await utimes(lockPath, t, t)
    }
  } catch {
    // Lock vanished or is not ours — the next acquire/tick decides.
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const held = JSON.parse(await readFile(lockPath, 'utf-8')) as DaemonLockRecord
    if (held.pid === process.pid && held.host === hostname() && held.token === token) {
      await rm(lockPath, { force: true })
    }
  } catch { /* already gone */ }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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
