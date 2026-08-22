import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TurnDiffTracker, TURN_DIFF_LIMITS } from '../fs/TurnDiffTracker.js'

let dir: string
let tracker: TurnDiffTracker

const p = (name: string): string => join(dir, name)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'turn-diff-'))
  tracker = new TurnDiffTracker()
  tracker.beginTurn('t1')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('TurnDiffTracker — capture semantics', () => {
  it('records the state at FIRST capture, not at last write', async () => {
    // The baseline is "the file at turn start". Re-capturing on every write
    // would make the diff show only the last edit, which is precisely the
    // per-edit view the tracker exists to replace.
    writeFileSync(p('a.txt'), 'v1\n')
    await tracker.capture(p('a.txt'))
    writeFileSync(p('a.txt'), 'v2\n')
    await tracker.capture(p('a.txt'))
    writeFileSync(p('a.txt'), 'v3\n')

    const summary = await tracker.summary()
    expect(summary.entries[0]?.before).toBe('v1\n')
    expect(summary.entries[0]?.after).toBe('v3\n')
  })

  it('treats a missing file as an absent baseline, so it renders as added', async () => {
    await tracker.capture(p('new.txt'))
    writeFileSync(p('new.txt'), 'created\n')

    const summary = await tracker.summary()
    expect(summary.entries[0]?.status).toBe('added')
    expect(summary.entries[0]?.before).toBeNull()
  })

  it('detects deletion', async () => {
    writeFileSync(p('doomed.txt'), 'bye\n')
    await tracker.capture(p('doomed.txt'))
    rmSync(p('doomed.txt'))

    const summary = await tracker.summary()
    expect(summary.entries[0]?.status).toBe('deleted')
    expect(summary.entries[0]?.after).toBeNull()
  })

  it('reports a captured-but-unchanged file as unchanged', async () => {
    writeFileSync(p('same.txt'), 'x\n')
    await tracker.capture(p('same.txt'))

    const summary = await tracker.summary()
    expect(summary.entries[0]?.status).toBe('unchanged')
    expect(summary.filesChanged).toBe(0)
  })

  it('never throws — a tracker failure must not break the write it observes', async () => {
    // capture() runs inside the write path. If it could throw, an unreadable
    // file would fail the user's actual edit instead of just degrading its diff.
    await expect(tracker.capture(join(dir, 'no', 'such', 'dir', 'f.txt'))).resolves.toBeUndefined()
    await expect(tracker.capture(dir)).resolves.toBeUndefined()
  })

  it('skips diffing files past the size ceiling but still reports them', async () => {
    const big = p('big.bin')
    writeFileSync(big, 'x'.repeat(TURN_DIFF_LIMITS.MAX_TRACKED_BYTES + 10))
    await tracker.capture(big)
    writeFileSync(big, 'y'.repeat(TURN_DIFF_LIMITS.MAX_TRACKED_BYTES + 10))

    const summary = await tracker.summary()
    expect(summary.entries[0]?.oversized).toBe(true)
    expect(summary.entries[0]?.before).toBeNull()
  })

  it('captureAll records several paths', async () => {
    writeFileSync(p('a.txt'), 'a\n')
    writeFileSync(p('b.txt'), 'b\n')
    await tracker.captureAll([p('a.txt'), p('b.txt')])
    expect(tracker.trackedPaths()).toHaveLength(2)
  })
})

describe('TurnDiffTracker — turn boundaries', () => {
  it('beginTurn clears the previous turn entirely', async () => {
    writeFileSync(p('a.txt'), 'v1\n')
    await tracker.capture(p('a.txt'))
    writeFileSync(p('a.txt'), 'v2\n')

    tracker.beginTurn('t2')
    expect(tracker.trackedPaths()).toHaveLength(0)
    expect((await tracker.summary()).filesChanged).toBe(0)
    expect(tracker.currentTurnId).toBe('t2')
  })

  it('auto-numbers turns when no id is given', () => {
    const t = new TurnDiffTracker()
    expect(t.beginTurn()).toBe('turn-1')
    expect(t.beginTurn()).toBe('turn-2')
  })
})

describe('TurnDiffTracker — rendering', () => {
  it('says so plainly when nothing changed', async () => {
    expect(await tracker.render()).toBe('No file changes in this turn.')
  })

  it('renders a header with totals and a unified diff per file', async () => {
    writeFileSync(p('a.txt'), 'one\ntwo\n')
    await tracker.capture(p('a.txt'))
    writeFileSync(p('a.txt'), 'one\nTWO\nthree\n')
    await tracker.capture(p('b.txt'))
    writeFileSync(p('b.txt'), 'brand new\n')

    const out = await tracker.render()
    expect(out).toMatch(/2 file\(s\) changed/)
    expect(out).toMatch(/\[t1\]/)
    expect(out).toContain('M ')
    expect(out).toContain('A ')
    expect(out).toContain('-two')
    expect(out).toContain('+TWO')
    expect(out).toContain('+brand new')
  })

  it('labels an added file against /dev/null', async () => {
    await tracker.capture(p('n.txt'))
    writeFileSync(p('n.txt'), 'x\n')
    expect(await tracker.render()).toContain('--- /dev/null')
  })

  it('labels a deleted file against /dev/null', async () => {
    writeFileSync(p('d.txt'), 'x\n')
    await tracker.capture(p('d.txt'))
    rmSync(p('d.txt'))
    expect(await tracker.render()).toContain('+++ /dev/null')
  })

  it('elides files past the char budget instead of blowing the context', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      writeFileSync(p(name), '')
      await tracker.capture(p(name))
      writeFileSync(p(name), Array.from({ length: 200 }, (_, i) => `${name}-line-${i}`).join('\n'))
    }
    const out = await tracker.render({ maxChars: 900 })
    expect(out).toMatch(/file\(s\) not shown/)
    expect(out.length).toBeLessThan(4_000)
  })

  it('names oversized files as not shown rather than pretending they are unchanged', async () => {
    const big = p('big.bin')
    writeFileSync(big, 'x'.repeat(TURN_DIFF_LIMITS.MAX_TRACKED_BYTES + 10))
    await tracker.capture(big)
    writeFileSync(big, 'y'.repeat(TURN_DIFF_LIMITS.MAX_TRACKED_BYTES + 10))
    expect(await tracker.render()).toMatch(/too large to diff/)
  })
})

describe('TurnDiffTracker — revert', () => {
  it('restores modified content', async () => {
    writeFileSync(p('a.txt'), 'original\n')
    await tracker.capture(p('a.txt'))
    writeFileSync(p('a.txt'), 'mangled\n')

    const outcome = await tracker.revert()
    expect(outcome.restored).toEqual([p('a.txt')])
    expect(readFileSync(p('a.txt'), 'utf-8')).toBe('original\n')
  })

  it('deletes files that did not exist at turn start', async () => {
    await tracker.capture(p('created.txt'))
    writeFileSync(p('created.txt'), 'new\n')

    const outcome = await tracker.revert()
    expect(outcome.removed).toEqual([p('created.txt')])
    expect(existsSync(p('created.txt'))).toBe(false)
  })

  it('recreates a file the turn deleted, including its parent directory', async () => {
    mkdirSync(join(dir, 'nested'))
    writeFileSync(p('nested/x.txt'), 'content\n')
    await tracker.capture(p('nested/x.txt'))
    rmSync(join(dir, 'nested'), { recursive: true })

    await tracker.revert()
    expect(readFileSync(p('nested/x.txt'), 'utf-8')).toBe('content\n')
  })

  it('clears the baselines after a clean revert', async () => {
    writeFileSync(p('a.txt'), 'v1\n')
    await tracker.capture(p('a.txt'))
    writeFileSync(p('a.txt'), 'v2\n')
    await tracker.revert()

    // Leaving stale baselines would let a second revert "restore" a state with
    // no remaining relationship to the tree.
    expect(tracker.trackedPaths()).toHaveLength(0)
    expect((await tracker.summary()).filesChanged).toBe(0)
  })

  it('names what it could not revert instead of failing silently', async () => {
    const big = p('big.bin')
    writeFileSync(big, 'x'.repeat(TURN_DIFF_LIMITS.MAX_TRACKED_BYTES + 10))
    await tracker.capture(big)
    writeFileSync(big, 'y')

    const outcome = await tracker.revert()
    expect(outcome.failed).toHaveLength(1)
    expect(outcome.failed[0]?.path).toBe(big)
    // A partial revert must not silently drop its baselines: the caller still
    // needs them to know what remains unreverted.
    expect(tracker.trackedPaths()).toContain(big)
  })

  it('is a no-op when nothing was tracked', async () => {
    const outcome = await tracker.revert()
    expect(outcome).toEqual({ restored: [], removed: [], failed: [] })
  })
})
