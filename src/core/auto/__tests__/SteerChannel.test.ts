/**
 * SteerChannel — out-of-band mid-turn corrections.
 *
 * This is the delivery path for `meta-agent steer <sessionId> "…"`, which
 * exists because `auto-scheduler` cannot use Ctrl+G at all (no readline, stdin
 * not in raw mode, usually detached with no TTY).
 *
 * The properties worth pinning are the ones that make it usable as a
 * cross-process channel: a writer and a reader must not need a lock, a message
 * must be delivered exactly once, ordering must come from the writer's clock
 * rather than readdir order, and a queue nobody drains must not grow forever.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  enqueueSteer, drainSteer, pendingSteerCount, clearSteer, pruneSteer,
  steerDir, MAX_STEER_TEXT_CHARS,
} from '../SteerChannel.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'steer-'))
  dirs.push(dir)
  return dir
}

describe('enqueue / drain round-trip', () => {
  it('delivers a queued correction', async () => {
    const p = await project()
    await enqueueSteer(p, 's1', 'use the coarse mesh')
    expect((await drainSteer(p, 's1')).map(m => m.text)).toEqual(['use the coarse mesh'])
  })

  it('delivers EXACTLY ONCE — a second drain sees nothing', async () => {
    const p = await project()
    await enqueueSteer(p, 's1', 'once only')
    expect(await drainSteer(p, 's1')).toHaveLength(1)
    expect(await drainSteer(p, 's1')).toHaveLength(0)
  })

  it('draining an unknown session is not an error', async () => {
    const p = await project()
    expect(await drainSteer(p, 'never-existed')).toEqual([])
  })

  it('keeps sessions isolated', async () => {
    const p = await project()
    await enqueueSteer(p, 's1', 'for one')
    await enqueueSteer(p, 's2', 'for two')
    expect((await drainSteer(p, 's1')).map(m => m.text)).toEqual(['for one'])
    expect((await drainSteer(p, 's2')).map(m => m.text)).toEqual(['for two'])
  })

  it('rejects empty / whitespace-only text at enqueue time', async () => {
    const p = await project()
    await expect(enqueueSteer(p, 's1', '   ')).rejects.toThrow(/empty/)
    await expect(enqueueSteer(p, 's1', '')).rejects.toThrow(/empty/)
  })

  it('trims the text but preserves internal formatting', async () => {
    const p = await project()
    await enqueueSteer(p, 's1', '  line one\nline two  ')
    expect((await drainSteer(p, 's1'))[0]?.text).toBe('line one\nline two')
  })

  it('caps an oversized correction rather than blowing up the context', async () => {
    // `meta-agent steer s1 "$(cat bigfile)"` should not paste a megabyte into
    // the model's context window.
    const p = await project()
    await enqueueSteer(p, 's1', 'x'.repeat(MAX_STEER_TEXT_CHARS * 3))
    const [msg] = await drainSteer(p, 's1')
    expect(msg!.text.length).toBeLessThan(MAX_STEER_TEXT_CHARS + 100)
    expect(msg!.text).toMatch(/truncated/)
  })

  it('records origin and a timestamp', async () => {
    const p = await project()
    const before = Date.now()
    await enqueueSteer(p, 's1', 'hi', 'test-suite')
    const [msg] = await drainSteer(p, 's1')
    expect(msg!.origin).toBe('test-suite')
    expect(msg!.at).toBeGreaterThanOrEqual(before)
  })
})

describe('ordering and concurrency', () => {
  it('returns corrections in the order they were issued', async () => {
    const p = await project()
    await enqueueSteer(p, 's1', 'first')
    await new Promise(r => setTimeout(r, 3))
    await enqueueSteer(p, 's1', 'second')
    await new Promise(r => setTimeout(r, 3))
    await enqueueSteer(p, 's1', 'third')
    expect((await drainSteer(p, 's1')).map(m => m.text)).toEqual(['first', 'second', 'third'])
  })

  it('orders by the writer timestamp, not by readdir order', async () => {
    // uuid filenames sort arbitrarily; the `at` field is the source of truth.
    const p = await project()
    const dir = steerDir(p, 's1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'zzz.json'), JSON.stringify(
      { schemaVersion: '1.0', id: 'z', sessionId: 's1', text: 'older', at: 1_000, origin: 'x' }), 'utf-8')
    await writeFile(join(dir, 'aaa.json'), JSON.stringify(
      { schemaVersion: '1.0', id: 'a', sessionId: 's1', text: 'newer', at: 2_000, origin: 'x' }), 'utf-8')
    expect((await drainSteer(p, 's1')).map(m => m.text)).toEqual(['older', 'newer'])
  })

  it('concurrent writers never collide (one file per message, no lock)', async () => {
    const p = await project()
    await Promise.all(Array.from({ length: 25 }, (_, i) => enqueueSteer(p, 's1', `msg-${i}`)))
    const drained = await drainSteer(p, 's1')
    expect(drained).toHaveLength(25)
    expect(new Set(drained.map(m => m.text)).size).toBe(25)
  })

  it('a writer racing a drain still gets delivered on the next poll', async () => {
    const p = await project()
    await enqueueSteer(p, 's1', 'early')
    const [drainResult] = await Promise.all([
      drainSteer(p, 's1'),
      enqueueSteer(p, 's1', 'late'),
    ])
    // The late message lands either in this drain or the next — never lost.
    const total = drainResult.length + (await drainSteer(p, 's1')).length
    expect(total).toBe(2)
  })
})

describe('robustness', () => {
  it('drops an unparseable message instead of re-reading it forever', async () => {
    // Left in place, a corrupt file would be retried on every poll for the whole
    // run. Consume-and-discard is the only terminating behaviour.
    const p = await project()
    const dir = steerDir(p, 's1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf-8')
    await enqueueSteer(p, 's1', 'good one')

    expect((await drainSteer(p, 's1')).map(m => m.text)).toEqual(['good one'])
    expect(await drainSteer(p, 's1')).toEqual([])
    expect((await readdir(dir)).filter(f => f.endsWith('.json'))).toEqual([])
  })

  it('ignores a record with an unknown schemaVersion', async () => {
    const p = await project()
    const dir = steerDir(p, 's1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'future.json'), JSON.stringify(
      { schemaVersion: '9.9', text: 'from the future', at: 1 }), 'utf-8')
    expect(await drainSteer(p, 's1')).toEqual([])
  })

  it('ignores non-json files in the queue directory', async () => {
    const p = await project()
    const dir = steerDir(p, 's1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'README.txt'), 'not a message', 'utf-8')
    await enqueueSteer(p, 's1', 'real')
    expect((await drainSteer(p, 's1')).map(m => m.text)).toEqual(['real'])
  })
})

describe('pendingSteerCount / clearSteer', () => {
  it('counts without consuming', async () => {
    const p = await project()
    await enqueueSteer(p, 's1', 'a')
    await enqueueSteer(p, 's1', 'b')
    expect(await pendingSteerCount(p, 's1')).toBe(2)
    expect(await pendingSteerCount(p, 's1')).toBe(2)   // still there
    expect(await drainSteer(p, 's1')).toHaveLength(2)
  })

  it('reports zero for an unknown session', async () => {
    expect(await pendingSteerCount(await project(), 'nope')).toBe(0)
  })

  it('clearSteer drops the whole queue', async () => {
    const p = await project()
    await enqueueSteer(p, 's1', 'a')
    await enqueueSteer(p, 's1', 'b')
    await clearSteer(p, 's1')
    expect(await pendingSteerCount(p, 's1')).toBe(0)
    expect(await drainSteer(p, 's1')).toEqual([])
  })

  it('clearSteer on an unknown session is a no-op', async () => {
    await expect(clearSteer(await project(), 'nope')).resolves.toBeUndefined()
  })
})

describe('pruneSteer', () => {
  it('removes messages older than the retention window', async () => {
    // Otherwise a correction typed for a session that never resumes would be
    // injected days later, wildly out of context.
    const p = await project()
    await enqueueSteer(p, 's1', 'ancient')
    const removed = await pruneSteer(p, 60_000, Date.now() + 120_000)
    expect(removed).toBe(1)
    expect(await drainSteer(p, 's1')).toEqual([])
  })

  it('keeps messages inside the window', async () => {
    const p = await project()
    await enqueueSteer(p, 's1', 'recent')
    expect(await pruneSteer(p, 60_000)).toBe(0)
    expect(await drainSteer(p, 's1')).toHaveLength(1)
  })

  it('falls back to mtime for a record whose contents are unreadable', async () => {
    const p = await project()
    const dir = steerDir(p, 's1')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'broken.json')
    await writeFile(path, '{ corrupt', 'utf-8')
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(path, old, old)
    expect(await pruneSteer(p, 60_000)).toBe(1)
  })

  it('removes an emptied queue directory', async () => {
    const p = await project()
    await enqueueSteer(p, 's1', 'gone soon')
    await pruneSteer(p, 0, Date.now() + 1_000)
    await expect(readdir(steerDir(p, 's1'))).rejects.toThrow()
  })

  it('is a no-op when no queue root exists', async () => {
    expect(await pruneSteer(await project())).toBe(0)
  })

  it('prunes across multiple sessions independently', async () => {
    const p = await project()
    await enqueueSteer(p, 'old-session', 'stale')
    await new Promise(r => setTimeout(r, 5))
    const cutoff = Date.now()
    await new Promise(r => setTimeout(r, 5))
    await enqueueSteer(p, 'new-session', 'fresh')

    await pruneSteer(p, Date.now() - cutoff, Date.now())
    expect(await drainSteer(p, 'old-session')).toEqual([])
    expect(await drainSteer(p, 'new-session')).toHaveLength(1)
  })
})

describe('session id handling', () => {
  it('encodes ids that are not filesystem-safe', async () => {
    const p = await project()
    const weird = 'loop:ws-1/2:agent 3'
    await enqueueSteer(p, weird, 'works anyway')
    expect((await drainSteer(p, weird)).map(m => m.text)).toEqual(['works anyway'])
  })

  it('two ids differing only by encoding do not share a queue', async () => {
    const p = await project()
    await enqueueSteer(p, 'a/b', 'slash')
    await enqueueSteer(p, 'a%2Fb', 'encoded')
    expect((await drainSteer(p, 'a/b')).map(m => m.text)).toEqual(['slash'])
    expect((await drainSteer(p, 'a%2Fb')).map(m => m.text)).toEqual(['encoded'])
  })
})
