import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, utimes, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pruneStaleDebug } from '../api/DebugWriter.js'

describe('pruneStaleDebug (S4)', () => {
  it('removes session dirs whose newest file is older than ttl', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debug-root-'))
    const stale = join(root, 'old-session')
    const fresh = join(root, 'new-session')
    await mkdir(stale, { recursive: true })
    await mkdir(fresh, { recursive: true })
    const oldFile = join(stale, '1.jsonl')
    const newFile = join(fresh, '1.jsonl')
    await writeFile(oldFile, 'x')
    await writeFile(newFile, 'x')
    // Backdate the stale file 30 days
    const thirtyDaysAgo = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000
    await utimes(oldFile, thirtyDaysAgo, thirtyDaysAgo)
    const summary = await pruneStaleDebug({ rootDir: root, ttlMs: 14 * 24 * 60 * 60 * 1000 })
    expect(summary.removedSessions).toBeGreaterThanOrEqual(1)
    const after = await readdir(root)
    expect(after).toContain('new-session')
    expect(after).not.toContain('old-session')
  })

  it('trims oversized sessions down to the cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debug-root-'))
    const session = join(root, 's1')
    await mkdir(session, { recursive: true })
    // Three 1 KB files, cap 1500 bytes → expect 1 file trimmed
    const sizes = [1024, 1024, 1024]
    for (let i = 0; i < sizes.length; i++) {
      const f = join(session, `${i}.jsonl`)
      await writeFile(f, Buffer.alloc(sizes[i]!))
      // Stagger mtimes so the oldest is evicted first
      const t = Math.floor((Date.now() - (sizes.length - i) * 1000) / 1000)
      await utimes(f, t, t)
    }
    const summary = await pruneStaleDebug({ rootDir: root, sessionSizeCapBytes: 1500, ttlMs: 99999999999 })
    expect(summary.trimmedFiles).toBeGreaterThanOrEqual(1)
    const left = await readdir(session)
    expect(left.length).toBeLessThan(sizes.length)
  })

  it('returns zero summary when root does not exist', async () => {
    const root = join(tmpdir(), 'nonexistent-debug-' + Date.now())
    const summary = await pruneStaleDebug({ rootDir: root })
    expect(summary.scannedSessions).toBe(0)
    expect(summary.removedSessions).toBe(0)
  })
})
