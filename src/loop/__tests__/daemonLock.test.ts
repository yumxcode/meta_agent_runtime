/**
 * The `.loop/daemon.lock` mutual-exclusion protocol.
 *
 * `loop/daemon.ts` sat at 14.4% coverage. This lock is what stops two
 * schedulers in the same workspace from claiming the same wake and running the
 * same graph activation twice, and it is also the piece that has to recover
 * from every way a holder can die: SIGKILL, a machine reboot, a crash halfway
 * through writing the lock file itself.
 *
 * Each rule below exists because getting it wrong has a specific bad outcome:
 *
 *   - `link()` rather than `writeFile('wx')`, so a lock file is never observed
 *     half-written. A corrupt lock used to wedge acquireDaemonLock forever.
 *   - a corrupt lock is reclaimed by MTIME, not treated as held for eternity.
 *   - release is token-checked, so a process that lost its lock to staleness
 *     cannot delete the new holder's lock on the way out.
 *   - a live local PID holds even when another process wants in; a dead one
 *     does not.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir, stat, utimes, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { acquireDaemonLock, releaseDaemonLock, runLoopScheduler } from '../daemon.js'

let dir: string
let lockPath: string
const dirs: string[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'daemon-lock-'))
  dirs.push(dir)
  lockPath = join(dir, '.loop', 'daemon.lock')
})
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

interface LockRecord { pid: number; host: string; token: string; at: number }

async function readLock(): Promise<LockRecord> {
  return JSON.parse(await readFile(lockPath, 'utf8')) as LockRecord
}

/** Write a lock owned by someone else, with a chosen age. */
async function plantLock(record: Partial<LockRecord>, ageMs = 0): Promise<void> {
  await mkdir(join(dir, '.loop'), { recursive: true })
  await writeFile(lockPath, JSON.stringify({
    pid: 999_999, host: hostname(), token: 'other-token', at: Date.now(), ...record,
  }))
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs)
    await utimes(lockPath, when, when)
  }
}

/** A PID that is almost certainly not running. */
const DEAD_PID = 999_999

describe('acquireDaemonLock', () => {
  it('creates the lock and its parent directory, returning a token', async () => {
    const token = await acquireDaemonLock(lockPath)
    expect(token).toBeTruthy()
    const held = await readLock()
    expect(held.token).toBe(token)
    expect(held.pid).toBe(process.pid)
    expect(held.host).toBe(hostname())
  })

  it('the second acquirer is refused while the first holds it', async () => {
    const first = await acquireDaemonLock(lockPath)
    expect(first).toBeTruthy()
    // Same process, so isAlive() is true and the lock is fresh.
    expect(await acquireDaemonLock(lockPath)).toBeNull()
  })

  it('leaves no temp file behind', async () => {
    await acquireDaemonLock(lockPath)
    const entries = await readdir(join(dir, '.loop'))
    expect(entries.filter(e => e.endsWith('.tmp'))).toEqual([])
  })

  it('never exposes a half-written lock: the file is complete JSON the instant it exists', async () => {
    // link() from a fully-written temp is what guarantees this; a
    // writeFile('wx') can be observed mid-write.
    const token = await acquireDaemonLock(lockPath)
    const raw = await readFile(lockPath, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect((JSON.parse(raw) as LockRecord).token).toBe(token)
  })

  it('reclaims a lock held by a DEAD pid on this host', async () => {
    await plantLock({ pid: DEAD_PID })
    const token = await acquireDaemonLock(lockPath)
    expect(token).toBeTruthy()
    expect((await readLock()).pid).toBe(process.pid)
  })

  it('respects a lock held by a LIVE pid on this host', async () => {
    await plantLock({ pid: process.pid, token: 'someone-elses' })
    expect(await acquireDaemonLock(lockPath)).toBeNull()
    expect((await readLock()).token).toBe('someone-elses')
  })

  it('respects a FRESH lock from another host (it cannot check liveness remotely)', async () => {
    await plantLock({ host: 'another-machine', pid: 12_345 })
    expect(await acquireDaemonLock(lockPath, 60_000)).toBeNull()
  })

  it('reclaims a STALE lock from another host', async () => {
    // The remote holder stopped heartbeating, so it is presumed gone.
    await plantLock({ host: 'another-machine', pid: 12_345 }, 10_000)
    expect(await acquireDaemonLock(lockPath, 1_000)).toBeTruthy()
  })

  it('reclaims a lock that is stale even though its pid is alive', async () => {
    // Heartbeat is 60s against a 5min freshness window: five missed beats mean
    // the holder is wedged, and a wedged scheduler must not hold the workspace.
    await plantLock({ pid: process.pid }, 10_000)
    expect(await acquireDaemonLock(lockPath, 1_000)).toBeTruthy()
  })

  it('backs off from a CORRUPT but fresh lock (a writer may be mid-crash)', async () => {
    await mkdir(join(dir, '.loop'), { recursive: true })
    await writeFile(lockPath, '{ this is not json')
    expect(await acquireDaemonLock(lockPath, 60_000)).toBeNull()
  })

  it('reclaims a CORRUPT lock once it goes stale', async () => {
    // Without the mtime path a corrupt lock is held forever and no scheduler
    // can ever start in that workspace again.
    await mkdir(join(dir, '.loop'), { recursive: true })
    await writeFile(lockPath, '{ this is not json')
    const when = new Date(Date.now() - 10_000)
    await utimes(lockPath, when, when)
    expect(await acquireDaemonLock(lockPath, 1_000)).toBeTruthy()
    expect((await readLock()).pid).toBe(process.pid)
  })

  it('leaves no .stale artefact after reclaiming', async () => {
    await plantLock({ pid: DEAD_PID })
    await acquireDaemonLock(lockPath)
    const entries = await readdir(join(dir, '.loop'))
    expect(entries.filter(e => e.endsWith('.stale'))).toEqual([])
  })

  it('exactly one of many concurrent acquirers wins', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => acquireDaemonLock(lockPath)),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = results.find(Boolean)!
    expect((await readLock()).token).toBe(winner)
  })
})

describe('releaseDaemonLock', () => {
  it('removes a lock the caller owns', async () => {
    const token = await acquireDaemonLock(lockPath)
    await releaseDaemonLock(lockPath, token!)
    await expect(stat(lockPath)).rejects.toThrow()
  })

  it('does NOT remove a lock owned by someone else', async () => {
    // The scenario: our fn outran staleMs, another process reclaimed the lock,
    // and now our finally block runs. Deleting here would let a third process
    // in alongside the new holder.
    await acquireDaemonLock(lockPath)
    await releaseDaemonLock(lockPath, 'not-my-token')
    await expect(stat(lockPath)).resolves.toBeTruthy()
  })

  it('does not remove a lock held by a different pid even with a matching token', async () => {
    await plantLock({ pid: DEAD_PID, token: 'shared-token' })
    await releaseDaemonLock(lockPath, 'shared-token')
    await expect(stat(lockPath)).resolves.toBeTruthy()
  })

  it('is a no-op on an already-released lock', async () => {
    const token = await acquireDaemonLock(lockPath)
    await releaseDaemonLock(lockPath, token!)
    await expect(releaseDaemonLock(lockPath, token!)).resolves.toBeUndefined()
  })

  it('is a no-op on a corrupt lock file', async () => {
    await mkdir(join(dir, '.loop'), { recursive: true })
    await writeFile(lockPath, 'not json')
    await expect(releaseDaemonLock(lockPath, 'anything')).resolves.toBeUndefined()
  })

  it('acquire → release → acquire round-trips', async () => {
    const first = await acquireDaemonLock(lockPath)
    await releaseDaemonLock(lockPath, first!)
    const second = await acquireDaemonLock(lockPath)
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
  })
})

describe('runLoopScheduler', () => {
  /** A graph executor that must never be reached in these tests. */
  const graphAgent = (() => {
    throw new Error('graphAgent must not run: no wakes were scheduled')
  }) as never

  it('refuses to start when another scheduler already holds the workspace', async () => {
    // Two schedulers in one workspace would claim the same wake and run the
    // same graph activation twice. The second must decline, not queue.
    const token = await acquireDaemonLock(lockPath)
    expect(token).toBeTruthy()
    const result = await runLoopScheduler({ projectDir: dir, graphAgent, pollMs: 10, idleExitMs: 10 })
    expect(result).toEqual({ ticks: 0, graphTicksRun: 0, exitReason: 'lock_held' })
  })

  it('exits idle on an empty workspace and releases the lock behind it', async () => {
    const result = await runLoopScheduler({ projectDir: dir, graphAgent, pollMs: 10, idleExitMs: 30 })
    expect(result.exitReason).toBe('idle')
    expect(result.graphTicksRun).toBe(0)
    // A scheduler that exits without releasing wedges the workspace until the
    // lock goes stale — five minutes of a project that looks permanently busy.
    await expect(stat(lockPath)).rejects.toThrow()
  }, 20_000)

  it('a second scheduler can start once the first exited', async () => {
    await runLoopScheduler({ projectDir: dir, graphAgent, pollMs: 10, idleExitMs: 20 })
    const second = await runLoopScheduler({ projectDir: dir, graphAgent, pollMs: 10, idleExitMs: 20 })
    expect(second.exitReason).toBe('idle')
  }, 20_000)

  it('an aborted scheduler reports `aborted` and still releases the lock', async () => {
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 40)
    const result = await runLoopScheduler({
      projectDir: dir, graphAgent, pollMs: 10, idleExitMs: 0, signal: abort.signal,
    })
    expect(result.exitReason).toBe('aborted')
    await expect(stat(lockPath)).rejects.toThrow()
  }, 20_000)

  it('idleExitMs: 0 keeps polling until aborted', async () => {
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 120)
    const started = Date.now()
    const result = await runLoopScheduler({
      projectDir: dir, graphAgent, pollMs: 10, idleExitMs: 0, signal: abort.signal,
    })
    expect(result.exitReason).toBe('aborted')
    // It kept ticking rather than exiting immediately on the empty queue.
    expect(Date.now() - started).toBeGreaterThan(80)
    expect(result.ticks).toBeGreaterThan(1)
  }, 20_000)
})
