import { describe, it, expect } from 'vitest'
import {
  parsePatch,
  applyHunks,
  describeOperations,
  PatchParseError,
  PatchApplyError,
} from '../fs/patchFormat.js'

const wrap = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`

describe('parsePatch — envelope', () => {
  it('rejects a patch with no Begin marker', () => {
    expect(() => parsePatch('*** Add File: a.ts\n+x\n*** End Patch')).toThrow(PatchParseError)
  })

  it('rejects a patch with no End marker', () => {
    expect(() => parsePatch('*** Begin Patch\n*** Add File: a.ts\n+x')).toThrow(/must end with/)
  })

  it('rejects an empty patch', () => {
    expect(() => parsePatch(wrap(''))).toThrow(/no operations/)
  })

  it('tolerates a fenced code block and surrounding blank lines', () => {
    // Models emit ``` constantly. Rejecting the whole change over a stray fence
    // costs a turn and teaches nothing about the change itself.
    const ops = parsePatch('\n\n```\n*** Begin Patch\n*** Delete File: a.ts\n*** End Patch\n```\n')
    expect(ops).toHaveLength(1)
  })

  it('reports the offending line number', () => {
    try {
      parsePatch(wrap('*** Add File: a.ts\nnot-prefixed'))
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(PatchParseError)
      expect((err as PatchParseError).message).toMatch(/line 3/)
    }
  })
})

describe('parsePatch — operations', () => {
  it('parses Add File and appends a trailing newline', () => {
    const ops = parsePatch(wrap('*** Add File: src/new.ts\n+line one\n+line two'))
    expect(ops).toEqual([
      { kind: 'add', path: 'src/new.ts', contents: 'line one\nline two\n' },
    ])
  })

  it('parses an empty Add File as an empty file', () => {
    const ops = parsePatch(wrap('*** Add File: empty.txt'))
    expect(ops[0]).toEqual({ kind: 'add', path: 'empty.txt', contents: '' })
  })

  it('rejects an Add File body line missing its + prefix', () => {
    expect(() => parsePatch(wrap('*** Add File: a.ts\nno-plus'))).toThrow(/must start with "\+"/)
  })

  it('parses Delete File', () => {
    expect(parsePatch(wrap('*** Delete File: gone.ts'))).toEqual([
      { kind: 'delete', path: 'gone.ts' },
    ])
  })

  it('parses Update File hunks with all three line kinds', () => {
    const ops = parsePatch(wrap('*** Update File: a.ts\n context\n-old\n+new'))
    expect(ops[0]).toMatchObject({ kind: 'update', path: 'a.ts' })
    const op = ops[0] as Extract<typeof ops[number], { kind: 'update' }>
    expect(op.hunks[0]?.lines).toEqual([
      { kind: 'context', text: 'context' },
      { kind: 'remove', text: 'old' },
      { kind: 'add', text: 'new' },
    ])
  })

  it('parses a Move to directly after Update File', () => {
    const ops = parsePatch(wrap('*** Update File: old.ts\n*** Move to: new.ts\n ctx\n-a\n+b'))
    expect(ops[0]).toMatchObject({ kind: 'update', path: 'old.ts', movePath: 'new.ts' })
  })

  it('splits hunks on @@ and keeps the header text', () => {
    const ops = parsePatch(
      wrap('*** Update File: a.ts\n@@ function one\n ctx1\n-x\n@@ function two\n ctx2\n-y'),
    )
    const op = ops[0] as Extract<typeof ops[number], { kind: 'update' }>
    expect(op.hunks).toHaveLength(2)
    expect(op.hunks[0]?.header).toBe('function one')
    expect(op.hunks[1]?.header).toBe('function two')
  })

  it('rejects an Update File with no hunks', () => {
    expect(() => parsePatch(wrap('*** Update File: a.ts'))).toThrow(/no hunks/)
  })

  it('rejects the same path appearing twice', () => {
    // Both edits were written against the ORIGINAL content, so applying them in
    // sequence silently drops the first.
    expect(() =>
      parsePatch(wrap('*** Update File: a.ts\n ctx\n-x\n+y\n*** Delete File: a.ts')),
    ).toThrow(/appears twice/)
  })

  it('parses a multi-operation patch in order', () => {
    const ops = parsePatch(
      wrap(
        '*** Add File: new.ts\n+hello\n' +
          '*** Update File: mid.ts\n ctx\n-a\n+b\n' +
          '*** Delete File: old.ts',
      ),
    )
    expect(ops.map(o => o.kind)).toEqual(['add', 'update', 'delete'])
  })
})

describe('applyHunks', () => {
  const file = 'one\ntwo\nthree\nfour\n'

  it('applies a single replacement hunk', () => {
    const out = applyHunks(
      file,
      [{ lines: [
        { kind: 'context', text: 'one' },
        { kind: 'remove', text: 'two' },
        { kind: 'add', text: 'TWO' },
      ] }],
      'f.txt',
    )
    expect(out).toBe('one\nTWO\nthree\nfour\n')
  })

  it('applies several hunks in order', () => {
    const out = applyHunks(
      file,
      [
        { lines: [{ kind: 'remove', text: 'one' }, { kind: 'add', text: 'ONE' }] },
        { lines: [{ kind: 'remove', text: 'four' }, { kind: 'add', text: 'FOUR' }] },
      ],
      'f.txt',
    )
    expect(out).toBe('ONE\ntwo\nthree\nFOUR\n')
  })

  it('searches forward only, so repeated lines resolve deterministically', () => {
    // `}` on its own line appears three times. Hunk 2 must match AFTER hunk 1,
    // which is the order the patch author wrote them.
    const repeated = 'a\n}\nb\n}\nc\n}\n'
    const out = applyHunks(
      repeated,
      [
        { lines: [{ kind: 'context', text: 'a' }, { kind: 'remove', text: '}' }, { kind: 'add', text: '} // first' }] },
        { lines: [{ kind: 'context', text: 'b' }, { kind: 'remove', text: '}' }, { kind: 'add', text: '} // second' }] },
      ],
      'f.txt',
    )
    expect(out).toBe('a\n} // first\nb\n} // second\nc\n}\n')
  })

  it('uses the @@ header to disambiguate', () => {
    const repeated = 'fn alpha\n  return null\nfn beta\n  return null\n'
    const out = applyHunks(
      repeated,
      [{
        header: 'fn beta',
        lines: [{ kind: 'remove', text: '  return null' }, { kind: 'add', text: '  return 42' }],
      }],
      'f.txt',
    )
    expect(out).toBe('fn alpha\n  return null\nfn beta\n  return 42\n')
  })

  it('inserts lines when the hunk is anchored by context', () => {
    const out = applyHunks(
      file,
      [{ lines: [
        { kind: 'context', text: 'two' },
        { kind: 'add', text: 'two-and-a-half' },
        { kind: 'context', text: 'three' },
      ] }],
      'f.txt',
    )
    expect(out).toBe('one\ntwo\ntwo-and-a-half\nthree\nfour\n')
  })

  it('rejects a hunk with nothing to anchor to', () => {
    // Guessing where a pure insertion goes yields a patch that applies cleanly
    // and is wrong — strictly worse than a rejection.
    expect(() =>
      applyHunks(file, [{ lines: [{ kind: 'add', text: 'orphan' }] }], 'f.txt'),
    ).toThrow(/no context or removed lines/)
  })

  it('reports what it looked for when a hunk does not match', () => {
    try {
      applyHunks(file, [{ lines: [{ kind: 'remove', text: 'nonexistent' }] }], 'f.txt')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(PatchApplyError)
      expect((err as Error).message).toContain('nonexistent')
      expect((err as Error).message).toMatch(/Re-read the file/)
    }
  })

  it('forgives trailing whitespace but not leading whitespace', () => {
    // Trailing spaces are invisible in every UI the model read the file
    // through. Leading whitespace is Python's semantics.
    const withTrailing = 'def f():\n    return 1   \n'
    expect(
      applyHunks(
        withTrailing,
        [{ lines: [{ kind: 'remove', text: '    return 1' }, { kind: 'add', text: '    return 2' }] }],
        'f.py',
      ),
    ).toBe('def f():\n    return 2\n')

    expect(() =>
      applyHunks(
        'def f():\n    return 1\n',
        [{ lines: [{ kind: 'remove', text: 'return 1' }, { kind: 'add', text: 'return 2' }] }],
        'f.py',
      ),
    ).toThrow(PatchApplyError)
  })

  it('preserves the absence of a trailing newline', () => {
    const out = applyHunks(
      'a\nb',
      [{ lines: [{ kind: 'remove', text: 'b' }, { kind: 'add', text: 'B' }] }],
      'f.txt',
    )
    expect(out).toBe('a\nB')
  })

  it('can empty a file entirely', () => {
    const out = applyHunks(
      'only\n',
      [{ lines: [{ kind: 'remove', text: 'only' }] }],
      'f.txt',
    )
    expect(out).toBe('')
  })
})

describe('describeOperations', () => {
  it('summarises counts including moves', () => {
    const ops = parsePatch(
      wrap(
        '*** Add File: a.ts\n+x\n' +
          '*** Update File: b.ts\n*** Move to: c.ts\n ctx\n-1\n+2\n' +
          '*** Delete File: d.ts',
      ),
    )
    expect(describeOperations(ops)).toBe('1 added, 1 updated, 1 moved, 1 deleted')
  })

  it('handles the empty case', () => {
    expect(describeOperations([])).toBe('no changes')
  })
})
