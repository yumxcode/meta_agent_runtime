/**
 * Regression tests for P2-4 and P2-8 (review 2026-08-27).
 *
 *   P2-4  directory-wide reads must be bounded, so recovering a session with
 *         thousands of records cannot exhaust the descriptor table.
 *   P2-8  a lock whose initialisation fails must leave nothing behind — no open
 *         descriptor, no orphan sentinel that blocks every later acquisition
 *         until the stale window expires.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  mapWithConcurrency,
  withFileLock,
  MIN_LOCK_STALE_MS,
  DEFAULT_READ_CONCURRENCY,
} from '../index.js'
import { makeTempDir } from '../../../__tests__/tempDir.js'

/**
 * Fault injection for the lock's initialisation window.
 *
 * `vi.spyOn` cannot patch an ESM export, so the module under test gets a
 * wrapped `fs/promises` whose `open()` hands back a handle with a poisoned
 * `writeFile`. Note the specifier: infra/persist/index.ts imports from
 * `'fs/promises'` (no `node:` prefix), and the mock has to match it.
 */
const injection = vi.hoisted(() => ({ failWriteWith: null as string | null }))

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (injection.failWriteWith !== null) {
        const code = injection.failWriteWith
        handle.writeFile = async () => {
          throw Object.assign(new Error(`injected ${code}`), { code })
        }
      }
      return handle
    },
  }
})

/** Open descriptors for this process, on platforms that expose them. */
function openDescriptorCount(): number | null {
  try {
    return readdirSync('/proc/self/fd').length
  } catch {
    return null
  }
}

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('persist-lock-')
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  injection.failWriteWith = null
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('mapWithConcurrency (P2-4)', () => {
  it('never exceeds the requested number of in-flight operations', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 200 }, (_, i) => i)

    const results = await mapWithConcurrency(items, 8, async i => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 1))
      inFlight--
      return i * 2
    })

    expect(peak).toBeLessThanOrEqual(8)
    // Not just "at most 8" — it must actually use the budget, or the fix would
    // have traded an EMFILE for a serial recovery.
    expect(peak).toBeGreaterThan(1)
    expect(results).toHaveLength(200)
    expect((results[7] as PromiseFulfilledResult<number>).value).toBe(14)
  })

  it('preserves input order regardless of completion order', async () => {
    // Callers zip results back against the input array, so order is load-bearing.
    const results = await mapWithConcurrency([30, 10, 20], 3, async ms => {
      await new Promise(r => setTimeout(r, ms))
      return ms
    })
    expect(results.map(r => (r as PromiseFulfilledResult<number>).value)).toEqual([30, 10, 20])
  })

  it('captures per-item rejections instead of failing the batch', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async i => {
      if (i === 2) throw new Error('item 2 failed')
      return i
    })
    expect(results[0]?.status).toBe('fulfilled')
    expect(results[1]?.status).toBe('rejected')
    expect(results[2]?.status).toBe('fulfilled')
  })

  it('handles an empty input and a limit larger than the input', async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([])
    const results = await mapWithConcurrency([1], 1000, async i => i)
    expect(results).toHaveLength(1)
  })

  it('falls back to the default limit for a non-finite one', async () => {
    let peak = 0
    let inFlight = 0
    await mapWithConcurrency(Array.from({ length: 100 }, (_, i) => i), NaN, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 1))
      inFlight--
    })
    expect(peak).toBeLessThanOrEqual(DEFAULT_READ_CONCURRENCY)
  })
})

describe('withFileLock initialisation failure (P2-8)', () => {
  it('removes the sentinel it created when the initial write fails', async () => {
    const dir = await tempDir()
    const target = join(dir, 'state.json')
    const lockPath = `${target}.lock`

    // The ENOSPC/EIO case: the sentinel is created, then the write that
    // initialises it fails. The original code left both the descriptor and the
    // sentinel behind.
    injection.failWriteWith = 'ENOSPC'
    await expect(withFileLock(target, async () => 'unreachable')).rejects.toThrow(/ENOSPC/)

    // The assertion that matters: no orphan sentinel. With the bug, this file
    // survived and every later acquisition blocked until the stale window.
    expect(existsSync(lockPath)).toBe(false)
  })

  it('does not leak a descriptor per failed acquisition', async () => {
    const before = openDescriptorCount()
    if (before === null) return   // /proc unavailable — covered by the checks above

    const dir = await tempDir()
    injection.failWriteWith = 'EIO'
    for (let i = 0; i < 25; i++) {
      await expect(withFileLock(join(dir, `state-${i}.json`), async () => 1)).rejects.toThrow(/EIO/)
    }
    injection.failWriteWith = null

    // 25 failures used to mean 25 permanently-open handles. Allow a small
    // margin for unrelated descriptors the runtime opens meanwhile.
    expect(openDescriptorCount()! - before).toBeLessThan(10)
  })

  it('lets the next acquisition succeed immediately after a failed one', async () => {
    const dir = await tempDir()
    const target = join(dir, 'state.json')

    injection.failWriteWith = 'EIO'
    await expect(withFileLock(target, async () => 1)).rejects.toThrow(/EIO/)
    injection.failWriteWith = null

    // No waiting for MIN_LOCK_STALE_MS: the failed attempt left no lock.
    const started = Date.now()
    const value = await withFileLock(target, async () => 'acquired', { timeoutMs: 1_000 })
    expect(value).toBe('acquired')
    expect(Date.now() - started).toBeLessThan(MIN_LOCK_STALE_MS)
  })

  it('still runs and releases normally in the happy path', async () => {
    const dir = await tempDir()
    const target = join(dir, 'state.json')
    await mkdir(dir, { recursive: true })
    await writeFile(target, '{}', 'utf-8')

    const result = await withFileLock(target, async () => 'ok')
    expect(result).toBe('ok')
    expect(existsSync(`${target}.lock`)).toBe(false)
  })

  it('releases the lock when the critical section throws', async () => {
    const dir = await tempDir()
    const target = join(dir, 'state.json')

    await expect(withFileLock(target, async () => {
      throw new Error('caller failed')
    })).rejects.toThrow('caller failed')

    expect(existsSync(`${target}.lock`)).toBe(false)
    await expect(withFileLock(target, async () => 'next', { timeoutMs: 1_000 })).resolves.toBe('next')
  })
})
