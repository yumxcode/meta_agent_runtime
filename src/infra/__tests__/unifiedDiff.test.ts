import { describe, it, expect } from 'vitest'
import { unifiedDiff, diffLines, diffStat, splitLines } from '../fs/unifiedDiff.js'

describe('splitLines', () => {
  it('does not invent a final empty line for a trailing newline', () => {
    // Treating "a\nb\n" as three lines makes every complete file look like it
    // differs from itself at EOF, and the diff grows a phantom hunk.
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
    expect(splitLines('\n')).toEqual([''])
  })
})

describe('diffLines', () => {
  it('reports no edits for identical input', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'b', 'c'])
    expect(ops.every(o => o.kind === 'equal')).toBe(true)
    expect(ops).toHaveLength(3)
  })

  it('finds a minimal edit script for a single-line change', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'X', 'c'])
    expect(ops.filter(o => o.kind === 'delete')).toHaveLength(1)
    expect(ops.filter(o => o.kind === 'insert')).toHaveLength(1)
    expect(ops.filter(o => o.kind === 'equal')).toHaveLength(2)
  })

  it('handles pure insertion and pure deletion', () => {
    expect(diffLines([], ['a', 'b']).filter(o => o.kind === 'insert')).toHaveLength(2)
    expect(diffLines(['a', 'b'], []).filter(o => o.kind === 'delete')).toHaveLength(2)
  })

  it('reconstructs the target exactly from the edit script', () => {
    // The property that matters: applying the script must produce `b`. A diff
    // that renders plausibly but does not reconstruct is silently wrong.
    const a = 'alpha,beta,gamma,delta,epsilon'.split(',')
    const b = 'alpha,GAMMA,delta,zeta,epsilon,eta'.split(',')
    const ops = diffLines(a, b)
    const rebuilt: string[] = []
    for (const op of ops) {
      if (op.kind === 'equal') rebuilt.push(a[op.oldIndex] as string)
      else if (op.kind === 'insert') rebuilt.push(b[op.newIndex] as string)
    }
    expect(rebuilt).toEqual(b)
  })

  it('degrades gracefully instead of hanging past the edit-distance bound', () => {
    const a = Array.from({ length: 200 }, (_, i) => `a${i}`)
    const b = Array.from({ length: 200 }, (_, i) => `b${i}`)
    const ops = diffLines(a, b, 8)
    expect(ops.filter(o => o.kind === 'delete')).toHaveLength(200)
    expect(ops.filter(o => o.kind === 'insert')).toHaveLength(200)
  })
})

describe('unifiedDiff', () => {
  it('returns empty string for identical texts', () => {
    expect(unifiedDiff('same\n', 'same\n', 'f.txt')).toBe('')
  })

  it('renders headers, a hunk range, and +/- lines', () => {
    const out = unifiedDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\n', 'f.txt')
    expect(out).toContain('--- a/f.txt')
    expect(out).toContain('+++ b/f.txt')
    expect(out).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/)
    expect(out).toContain('-two')
    expect(out).toContain('+TWO')
    expect(out).toContain(' one')
  })

  it('emits separate hunks for distant changes, and merges near ones', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n') + '\n'
    const afterLines = before.split('\n')
    afterLines[1] = 'CHANGED-EARLY'
    afterLines[35] = 'CHANGED-LATE'
    const hunkCount = (d: string): number =>
      d.split('\n').filter(l => l.startsWith('@@')).length

    const far = unifiedDiff(before, afterLines.join('\n'), 'f.txt')
    expect(hunkCount(far)).toBe(2)

    const nearLines = before.split('\n')
    nearLines[10] = 'A'
    nearLines[11] = 'B'
    const near = unifiedDiff(before, nearLines.join('\n'), 'f.txt')
    expect(hunkCount(near)).toBe(1)
  })

  it('honours the context setting', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n'
    const after = before.replace('l10', 'CHANGED')
    const tight = unifiedDiff(before, after, 'f.txt', { context: 1 })
    const loose = unifiedDiff(before, after, 'f.txt', { context: 5 })
    expect(loose.split('\n').length).toBeGreaterThan(tight.split('\n').length)
  })

  it('renders a whole-file addition against /dev/null labels', () => {
    const out = unifiedDiff('', 'new\ncontent\n', 'n.txt', {
      oldLabel: '/dev/null',
      newLabel: 'b/n.txt',
    })
    expect(out).toContain('--- /dev/null')
    expect(out).toContain('+new')
    expect(out).toContain('+content')
    // A zero-length side starts at 0, not 1 — that is the unified-diff rule.
    expect(out).toContain('@@ -0,0 +1,2 @@')
  })

  it('reports a change that only removes the trailing newline', () => {
    // Without the "no newline" line this renders as no change at all, and a
    // reviewer sees an empty diff for a file that really did change.
    const out = unifiedDiff('a\n', 'a', 'f.txt')
    expect(out).not.toBe('')
    expect(out).toContain('No newline at end of file')
  })
})

describe('diffStat', () => {
  it('counts added and removed lines', () => {
    expect(diffStat('a\nb\n', 'a\nb\nc\n')).toEqual({ added: 1, removed: 0 })
    expect(diffStat('a\nb\nc\n', 'a\n')).toEqual({ added: 0, removed: 2 })
    expect(diffStat('a\n', 'b\n')).toEqual({ added: 1, removed: 1 })
  })

  it('is zero for identical text', () => {
    expect(diffStat('x\n', 'x\n')).toEqual({ added: 0, removed: 0 })
  })
})
