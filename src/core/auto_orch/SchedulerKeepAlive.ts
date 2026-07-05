/**
 * SchedulerKeepAlive — the M5 operational layer: WHO keeps ticking after a run
 * pauses. Three cooperating layers (any process that ticks first claims first —
 * the store's atomic claims make co-existence safe):
 *
 *   A. Foreground wait — an interactive/one-shot auto_orch session stays alive
 *      (waitForAutoOrchQuiescence) until every schedule for its workspace is
 *      terminal.
 *   B. Detached scheduler daemon — `meta-agent orch-scheduler`: a standalone
 *      process that ticks the workspace's schedules and EXITS when none remain
 *      (idle-exit, host-level lock so at most one per workspace).
 *   C. Startup self-heal — any session start can surface pending/overdue
 *      schedules (listPendingAutoOrchSchedules) and point at layer B.
 *
 * This module owns the primitives (pending queries, quiescence wait, daemon
 * lock, detached spawn); the CLI owns the UX around them.
 */
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { hostname } from 'os'
import { mkdirSync, openSync } from 'fs'
import { mkdir, open, readFile, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { META_AGENT_HOME } from '../metaAgentHome.js'
import {
  listPendingAutoOrchSchedules,
  type AutoOrchScheduledResume,
} from './AutoOrchScheduleStore.js'

export interface AutoOrchQuiescenceStatus {
  /** Non-terminal schedules right now. */
  pending: AutoOrchScheduledResume[]
  /** Epoch ms of the earliest future fire, if any. */
  nextRunAt?: number
}

export interface WaitForQuiescenceOptions {
  projectDir: string
  /** Poll cadence. Default 10 s. */
  pollMs?: number
  /** Abort the wait (e.g. user pressed Ctrl-C); resolves with the current state. */
  signal?: AbortSignal
  /** Called on every poll with the current state (CLI renders it). */
  onStatus?: (status: AutoOrchQuiescenceStatus) => void
}

/**
 * Block until every schedule for the workspace is terminal (layer A). The
 * caller must keep a live auto_orch backend around — ITS scheduler does the
 * actual claiming/resuming; this loop merely keeps the process (and therefore
 * that scheduler's unref'd timer) alive and reports progress.
 * Resolves with the number of schedules still pending (0 = quiescent).
 */
export async function waitForAutoOrchQuiescence(
  opts: WaitForQuiescenceOptions,
): Promise<{ pendingAtExit: number }> {
  const pollMs = Math.max(500, opts.pollMs ?? 10_000)
  for (;;) {
    if (opts.signal?.aborted) {
      const pending = await listPendingAutoOrchSchedules({ projectDir: opts.projectDir }).catch(() => [])
      return { pendingAtExit: pending.length }
    }
    const pending = await listPendingAutoOrchSchedules({ projectDir: opts.projectDir }).catch(() => [])
    if (pending.length === 0) return { pendingAtExit: 0 }
    opts.onStatus?.({
      pending,
      nextRunAt: pending
        .filter(p => p.status === 'scheduled')
        .reduce<number | undefined>((min, p) => (min === undefined || p.runAt < min ? p.runAt : min), undefined),
    })
    await sleep(pollMs, opts.signal)
  }
}

// ── Daemon lock (at most one orch-scheduler per workspace per host) ─────────────

function daemonLockDir(): string {
  return join(META_AGENT_HOME, 'auto_orch_schedules', 'daemons')
}

function daemonLockPath(projectDir: string): string {
  const key = createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 16)
  return join(daemonLockDir(), `${key}.lock`)
}

/**
 * Acquire the per-workspace daemon lock (O_EXCL create, same pattern as the
 * schedule claims). A lock held by a DEAD pid is stolen. Returns a release
 * function, or null when another live daemon already holds it.
 */
export async function acquireAutoOrchDaemonLock(
  projectDir: string,
): Promise<(() => Promise<void>) | null> {
  const path = daemonLockPath(projectDir)
  await mkdir(daemonLockDir(), { recursive: true }).catch(() => undefined)
  const payload = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    projectDir: resolve(projectDir),
    at: Date.now(),
  })
  const tryCreate = async (): Promise<boolean> => {
    try {
      const fh = await open(path, 'wx')
      try {
        await fh.writeFile(payload, 'utf-8')
      } finally {
        await fh.close()
      }
      return true
    } catch {
      return false
    }
  }
  const release = async (): Promise<void> => {
    await rm(path, { force: true }).catch(() => undefined)
  }
  if (await tryCreate()) return release
  // Held — by a live process?
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as { pid?: unknown; host?: unknown }
    const pid = typeof raw.pid === 'number' ? raw.pid : undefined
    const sameHost = raw.host === hostname()
    if (pid && sameHost && pidAlive(pid)) return null
    // Foreign-host locks can't be liveness-checked; treat locks from another
    // host as stale (META_AGENT_HOME is per-user, cross-host sharing is rare).
  } catch { /* unreadable lock → treat as stale */ }
  await rm(path, { force: true }).catch(() => undefined)
  return (await tryCreate()) ? release : null
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = alive but not ours; anything else (ESRCH) = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ── Detached daemon spawn (layer B hand-off) ────────────────────────────────────

export interface SpawnDetachedSchedulerResult {
  pid: number | undefined
  logPath: string
}

/**
 * Hand pending schedules to a detached `orch-scheduler` process and return
 * immediately. Best-effort: returns null when the CLI entry cannot be
 * determined or the spawn fails — callers then just print the manual command.
 */
export function spawnDetachedAutoOrchScheduler(
  projectDir: string,
  opts?: { cliEntry?: string; extraArgs?: string[] },
): SpawnDetachedSchedulerResult | null {
  const entry = opts?.cliEntry ?? process.argv[1]
  if (!entry) return null
  try {
    const logDir = join(META_AGENT_HOME, 'logs')
    mkdirSync(logDir, { recursive: true })
    const logPath = join(logDir, 'auto-orch-scheduler.log')
    const out = openSync(logPath, 'a')
    const child = spawn(
      process.execPath,
      [entry, 'orch-scheduler', '--project', resolve(projectDir), ...(opts?.extraArgs ?? [])],
      { detached: true, stdio: ['ignore', out, out] },
    )
    child.unref()
    return { pid: child.pid, logPath }
  } catch {
    return null
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
