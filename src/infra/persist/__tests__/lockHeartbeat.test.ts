/**
 * withFileLock liveness.
 *
 * The lock file's mtime used to be stamped once at acquisition and never
 * refreshed, so `staleMs` measured "how long ago the lock was taken" rather
 * than "how long since the holder was last alive". Any critical section that
 * outlived staleMs was reclaimed out from under its live holder and two
 * processes ran inside it together — reachable in practice via
 * ExperienceStore.rebuildIndex, which holds the default 30s lock across an
 * index rebuild.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock, MIN_LOCK_STALE_MS } from '../index.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lock-hb-'))
  dirs.push(dir)
  return dir
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('withFileLock heartbeat', () => {
  it('refreshes the lock mtime while the critical section is running', async () => {
    const target = join(await scratch(), 'state.json')
    const lockPath = `${target}.lock`

    let firstMtime = 0
    let lastMtime = 0

    await withFileLock(target, async () => {
      firstMtime = (await stat(lockPath)).mtimeMs
      // Hold across several beats. Timings are derived from MIN_LOCK_STALE_MS
      // rather than written as literals so that changing the clamp cannot leave
      // this test asserting against a beat interval that no longer exists.
      await sleep(MIN_LOCK_STALE_MS * 2)
      lastMtime = (await stat(lockPath)).mtimeMs
    }, { staleMs: MIN_LOCK_STALE_MS, timeoutMs: 5_000 })

    expect(lastMtime).toBeGreaterThan(firstMtime)
  })

  it('a long critical section is NOT reclaimed as stale by a second waiter', async () => {
    // This assertion used to fail roughly 1 acquisition in 40 — and the failure
    // was real, not a flaky assertion: the observed order was
    // holder:enter → waiter:enter → holder:exit, i.e. two callers inside the
    // critical section at once. The cause was `staleMs: 60` combined with a
    // heartbeat that floored at 50ms, leaving 10ms of margin for a readFile +
    // utimes pair. See MIN_LOCK_STALE_MS.
    //
    // The test now asks for the shortest deadline the lock will honour, so it
    // still exercises the tightest real timing rather than a comfortable one.
    const target = join(await scratch(), 'state.json')
    const order: string[] = []

    // Holder runs several times staleMs. Without the heartbeat the waiter would
    // decide the lock was orphaned, claim it, and both would be inside at once.
    const holder = withFileLock(target, async () => {
      order.push('holder:enter')
      await sleep(MIN_LOCK_STALE_MS * 3)
      order.push('holder:exit')
    }, { staleMs: MIN_LOCK_STALE_MS, timeoutMs: 10_000 })

    // Start the waiter while the holder is inside, and before the deadline
    // could have elapsed even once.
    await sleep(Math.floor(MIN_LOCK_STALE_MS / 3))

    const waiter = withFileLock(target, async () => {
      order.push('waiter:enter')
    }, { staleMs: MIN_LOCK_STALE_MS, timeoutMs: 10_000 })

    await Promise.all([holder, waiter])

    // The waiter must not enter before the holder leaves.
    expect(order).toEqual(['holder:enter', 'holder:exit', 'waiter:enter'])
  }, 15_000)

  it('still reclaims a genuinely abandoned lock (no heartbeat, dead holder)', async () => {
    const target = join(await scratch(), 'state.json')
    const lockPath = `${target}.lock`

    // Simulate a crashed holder: a lock file nobody is refreshing.
    await writeFile(lockPath, 'someone-else.dead-token 1970-01-01T00:00:00.000Z')
    // Must exceed the CLAMPED deadline, not the requested one — a caller asking
    // for 50ms now gets MIN_LOCK_STALE_MS, and waiting 80ms would find the lock
    // still fresh and block until the timeout.
    await sleep(MIN_LOCK_STALE_MS + 60)

    let entered = false
    await withFileLock(target, async () => { entered = true }, { staleMs: 50, timeoutMs: 5_000 })
    expect(entered).toBe(true)
  }, 15_000)

  it('clamps a staleMs the heartbeat could not honour', async () => {
    // The property behind the fix: a caller cannot ask for a deadline shorter
    // than three heartbeats and be quietly given one. Asking for 10ms must
    // behave exactly like asking for MIN_LOCK_STALE_MS — a lock younger than
    // the clamp is NOT reclaimable, however small the requested staleMs was.
    const target = join(await scratch(), 'state.json')
    const lockPath = `${target}.lock`

    // Freshly written, so it is already older than the REQUESTED 10ms but far
    // younger than the clamp. The timeout must expire well before the clamp
    // does, or the lock goes genuinely stale and the acquire legitimately
    // succeeds — which is what this assertion originally got wrong.
    await writeFile(lockPath, 'someone-else.dead-token 1970-01-01T00:00:00.000Z')

    await expect(
      withFileLock(target, async () => undefined,
        { staleMs: 10, timeoutMs: Math.floor(MIN_LOCK_STALE_MS / 3) }),
    ).rejects.toThrow(/timed out/)

    // …and the same lock IS reclaimable once it outlives the clamp, which is
    // what makes the assertion above about clamping rather than about the lock
    // never being reclaimable at all.
    await sleep(MIN_LOCK_STALE_MS)
    let entered = false
    await withFileLock(target, async () => { entered = true }, { staleMs: 10, timeoutMs: 5_000 })
    expect(entered).toBe(true)
  }, 15_000)

  it('stops heartbeating once the section throws', async () => {
    const target = join(await scratch(), 'state.json')
    const lockPath = `${target}.lock`

    await expect(withFileLock(target, async () => {
      throw new Error('boom')
    }, { staleMs: MIN_LOCK_STALE_MS, timeoutMs: 1_000 })).rejects.toThrow('boom')

    // Lock released despite the throw, so the next acquire is immediate.
    let entered = false
    await withFileLock(target, async () => { entered = true },
      { staleMs: MIN_LOCK_STALE_MS, timeoutMs: 1_000 })
    expect(entered).toBe(true)
    // And nothing is still touching a file that no longer exists: wait past a
    // full beat, then confirm no timer recreated it.
    await sleep(MIN_LOCK_STALE_MS)
    await expect(stat(lockPath)).rejects.toThrow()
  })
})
