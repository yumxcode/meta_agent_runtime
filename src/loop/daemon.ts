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
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { hostname } from 'os'
import { tickOnce, type TickDeps, type TickResult } from './runner.js'
import { WakeStore } from './wake/WakeStore.js'

export interface DaemonOptions extends TickDeps {
  pollMs?: number
  /** Exit after this long with nothing pending. Default 60 s. */
  idleExitMs?: number
  /** Observer for each non-empty tick (CLI renders progress). */
  onTick?: (result: TickResult) => void
  /** Test hook: clock source. */
  now?: () => number
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

  if (!(await acquireLock(lockPath))) {
    return { ticks: 0, roundsRun: 0, probesRun: 0, exitReason: 'lock_held' }
  }
  const wakeStore = new WakeStore(opts.projectDir)
  let ticks = 0
  let roundsRun = 0
  let probesRun = 0
  let idleSince: number | null = null
  try {
    for (;;) {
      if (opts.signal?.aborted) return { ticks, roundsRun, probesRun, exitReason: 'aborted' }

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

      // Idle detection: pending OR claimed wakes (even future ones) keep us alive.
      const live = (await wakeStore.list()).filter(
        w => w.status === 'pending' || w.status === 'claimed',
      )
      if (live.length === 0) {
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
    await releaseLock(lockPath)
  }
}

async function acquireLock(lockPath: string): Promise<boolean> {
  await mkdir(join(lockPath, '..'), { recursive: true }).catch(() => undefined)
  try {
    const raw = await readFile(lockPath, 'utf-8')
    const held = JSON.parse(raw) as { pid: number; host: string }
    if (held.host === hostname() && isAlive(held.pid)) return false
    // Stale lock (dead pid or other host's leftover on a shared dir): reap it.
    await rm(lockPath, { force: true })
  } catch {
    // no lock file — free to take it
  }
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }), {
      flag: 'wx', // exclusive create — loser of a race backs off
    })
    return true
  } catch {
    return false
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    const held = JSON.parse(await readFile(lockPath, 'utf-8')) as { pid: number }
    if (held.pid === process.pid) await rm(lockPath, { force: true })
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
