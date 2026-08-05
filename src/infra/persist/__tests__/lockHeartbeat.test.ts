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
import { withFileLock } from '../index.js'

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
      // staleMs/3 = 40ms heartbeat; hold well past that.
      await sleep(260)
      lastMtime = (await stat(lockPath)).mtimeMs
    }, { staleMs: 120, timeoutMs: 1_000 })

    expect(lastMtime).toBeGreaterThan(firstMtime)
  })

  it('a long critical section is NOT reclaimed as stale by a second waiter', async () => {
    const target = join(await scratch(), 'state.json')
    const order: string[] = []

    // Holder runs ~5x staleMs. Without the heartbeat the waiter would decide
    // the lock was orphaned, claim it, and both would be inside at once.
    const holder = withFileLock(target, async () => {
      order.push('holder:enter')
      await sleep(300)
      order.push('holder:exit')
    }, { staleMs: 60, timeoutMs: 5_000 })

    await sleep(40)   // ensure the waiter starts while the holder is inside

    const waiter = withFileLock(target, async () => {
      order.push('waiter:enter')
    }, { staleMs: 60, timeoutMs: 5_000 })

    await Promise.all([holder, waiter])

    // The waiter must not enter before the holder leaves.
    expect(order).toEqual(['holder:enter', 'holder:exit', 'waiter:enter'])
  })

  it('still reclaims a genuinely abandoned lock (no heartbeat, dead holder)', async () => {
    const target = join(await scratch(), 'state.json')
    const lockPath = `${target}.lock`

    // Simulate a crashed holder: a lock file nobody is refreshing.
    await writeFile(lockPath, 'someone-else.dead-token 1970-01-01T00:00:00.000Z')
    await sleep(80)

    let entered = false
    await withFileLock(target, async () => { entered = true }, { staleMs: 50, timeoutMs: 2_000 })
    expect(entered).toBe(true)
  })

  it('stops heartbeating once the section throws', async () => {
    const target = join(await scratch(), 'state.json')
    const lockPath = `${target}.lock`

    await expect(withFileLock(target, async () => {
      throw new Error('boom')
    }, { staleMs: 120, timeoutMs: 1_000 })).rejects.toThrow('boom')

    // Lock released despite the throw, so the next acquire is immediate.
    let entered = false
    await withFileLock(target, async () => { entered = true }, { staleMs: 120, timeoutMs: 500 })
    expect(entered).toBe(true)
    // And nothing is still touching a file that no longer exists.
    await sleep(150)
    await expect(stat(lockPath)).rejects.toThrow()
  })
})
