/**
 * apply_patch + turn_diff at the tool layer.
 *
 * The parser and the tracker have their own tests. This file covers what the
 * TOOLS add: workspace containment, atomicity (nothing written when any part
 * fails), the TOCTOU guard, integration with the turn tracker, and the promise
 * that the existing write tools now feed the tracker without changing their
 * own behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
// §8.1: fully-resolved temp roots — apply_patch reports canonicalised paths.
import { makeTempDirSync } from '../../__tests__/tempDir.js'
import type { MetaAgentTool, ToolCallContext } from '../../core/types.js'
import { createApplyPatchTool } from '../fs/apply_patch/index.js'
import { createTurnDiffTool } from '../fs/turn_diff/index.js'
import { createEditFileTool } from '../fs/edit_file/index.js'
import { createWriteFileTool } from '../fs/write_file/index.js'
import { createAppendFileTool } from '../fs/append_file/index.js'
import { createFsTools } from '../fs/index.js'
import { TurnDiffTracker } from '../../infra/fs/TurnDiffTracker.js'
import { resolveToolAbortSupport } from '../../modes/toolAdapter.js'

let ws: string
let applyPatch: MetaAgentTool
let turnDiff: MetaAgentTool
let tracker: TurnDiffTracker

const p = (name: string): string => join(ws, name)
const wrap = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`

function ctx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    sessionId: 's',
    agentId: 'a',
    abortSignal: new AbortController().signal,
    workspaceRoot: ws,
    ...overrides,
  }
}

beforeEach(async () => {
  ws = makeTempDirSync('apply-patch-')
  tracker = new TurnDiffTracker()
  tracker.beginTurn('t1')
  ;[applyPatch, turnDiff] = await Promise.all([createApplyPatchTool(), createTurnDiffTool()])
})

afterEach(() => rmSync(ws, { recursive: true, force: true }))

describe('apply_patch — the happy paths', () => {
  it('adds, updates and deletes in one call', async () => {
    writeFileSync(p('mid.ts'), 'const a = 1\nconst b = 2\n')
    writeFileSync(p('old.ts'), 'obsolete\n')

    const res = await applyPatch.call(
      {
        patch: wrap(
          '*** Add File: new.ts\n+export const x = 1\n' +
            '*** Update File: mid.ts\n const a = 1\n-const b = 2\n+const b = 22\n' +
            '*** Delete File: old.ts',
        ),
      },
      ctx(),
    )

    expect(res.isError).toBe(false)
    expect(res.content).toContain('1 added, 1 updated, 1 deleted')
    expect(readFileSync(p('new.ts'), 'utf-8')).toBe('export const x = 1\n')
    expect(readFileSync(p('mid.ts'), 'utf-8')).toBe('const a = 1\nconst b = 22\n')
    expect(existsSync(p('old.ts'))).toBe(false)
  })

  it('renames a file with Move to, carrying the edit across', async () => {
    writeFileSync(p('old_name.ts'), "const NAME = 'old'\n")
    const res = await applyPatch.call(
      {
        patch: wrap(
          "*** Update File: old_name.ts\n*** Move to: new_name.ts\n-const NAME = 'old'\n+const NAME = 'new'",
        ),
      },
      ctx(),
    )

    expect(res.isError).toBe(false)
    expect(existsSync(p('old_name.ts'))).toBe(false)
    expect(readFileSync(p('new_name.ts'), 'utf-8')).toBe("const NAME = 'new'\n")
  })

  it('creates parent directories for an added file', async () => {
    const res = await applyPatch.call(
      { patch: wrap('*** Add File: deep/nested/file.ts\n+hi') },
      ctx(),
    )
    expect(res.isError).toBe(false)
    expect(readFileSync(p('deep/nested/file.ts'), 'utf-8')).toBe('hi\n')
  })

  it('accepts an absolute path inside the workspace', async () => {
    const res = await applyPatch.call(
      { patch: wrap(`*** Add File: ${p('abs.ts')}\n+ok`) },
      ctx(),
    )
    expect(res.isError).toBe(false)
    expect(existsSync(p('abs.ts'))).toBe(true)
  })

  it('reports per-file line counts', async () => {
    writeFileSync(p('f.ts'), 'a\nb\nc\n')
    const res = await applyPatch.call(
      { patch: wrap('*** Update File: f.ts\n a\n-b\n+B\n+B2\n c') },
      ctx(),
    )
    expect(res.content).toMatch(/\+2 -1/)
  })
})

describe('apply_patch — containment', () => {
  it('refuses a path outside the workspace', async () => {
    const res = await applyPatch.call(
      { patch: wrap('*** Add File: ../escape.ts\n+nope') },
      ctx(),
    )
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/outside workspace/)
    expect(existsSync(join(ws, '..', 'escape.ts'))).toBe(false)
  })

  it('refuses a move target outside the workspace', async () => {
    writeFileSync(p('a.ts'), 'x\n')
    const res = await applyPatch.call(
      { patch: wrap('*** Update File: a.ts\n*** Move to: ../out.ts\n-x\n+y') },
      ctx(),
    )
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/move target/)
    // The original must be untouched: containment is checked before planning.
    expect(readFileSync(p('a.ts'), 'utf-8')).toBe('x\n')
  })
})

describe('apply_patch — atomicity', () => {
  it('writes nothing when a later operation fails validation', async () => {
    // The whole reason to prefer a patch over N edit_file calls: a broken third
    // hunk must not leave the first two applied.
    writeFileSync(p('first.ts'), 'keep\n')
    writeFileSync(p('second.ts'), 'actual content\n')

    const res = await applyPatch.call(
      {
        patch: wrap(
          '*** Add File: created.ts\n+should not survive\n' +
            '*** Update File: first.ts\n-keep\n+changed\n' +
            '*** Update File: second.ts\n-this line is not in the file\n+x',
        ),
      },
      ctx(),
    )

    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/nothing was written/)
    expect(existsSync(p('created.ts'))).toBe(false)
    expect(readFileSync(p('first.ts'), 'utf-8')).toBe('keep\n')
    expect(readFileSync(p('second.ts'), 'utf-8')).toBe('actual content\n')
  })

  it('rejects adding a file that already exists', async () => {
    writeFileSync(p('exists.ts'), 'here\n')
    const res = await applyPatch.call(
      { patch: wrap('*** Add File: exists.ts\n+overwrite') },
      ctx(),
    )
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/already exists/)
    expect(readFileSync(p('exists.ts'), 'utf-8')).toBe('here\n')
  })

  it('rejects updating or deleting a file that does not exist', async () => {
    expect(
      (await applyPatch.call({ patch: wrap('*** Update File: ghost.ts\n-a\n+b') }, ctx())).content,
    ).toMatch(/does not exist/)
    expect(
      (await applyPatch.call({ patch: wrap('*** Delete File: ghost.ts') }, ctx())).content,
    ).toMatch(/does not exist/)
  })

  it('rejects a move onto an existing file', async () => {
    writeFileSync(p('a.ts'), 'a\n')
    writeFileSync(p('b.ts'), 'b\n')
    const res = await applyPatch.call(
      { patch: wrap('*** Update File: a.ts\n*** Move to: b.ts\n-a\n+A') },
      ctx(),
    )
    expect(res.isError).toBe(true)
    expect(readFileSync(p('b.ts'), 'utf-8')).toBe('b\n')
  })

  it('rolls back already-written files when a write fails mid-patch', async () => {
    // Simulate an unwritable target: a directory where the patch expects a file.
    writeFileSync(p('good.ts'), 'before\n')
    mkdirSync(p('blocked.ts'))

    const res = await applyPatch.call(
      {
        patch: wrap(
          '*** Update File: good.ts\n-before\n+after\n' +
            '*** Add File: blocked.ts\n+cannot write over a directory',
        ),
      },
      ctx(),
    )

    expect(res.isError).toBe(true)
    // Either it was caught in planning (add-over-existing) or rolled back after
    // a write error. Both outcomes must leave `good.ts` at its original bytes.
    expect(readFileSync(p('good.ts'), 'utf-8')).toBe('before\n')
  })
})

describe('apply_patch — guards inherited from edit_file', () => {
  it('refuses when the file drifted since it was last read', async () => {
    writeFileSync(p('f.ts'), 'a\n')
    const stale = {
      get: () => ({ sizeBytes: 999, mtimeMs: 1 }),
      record: () => {},
      has: () => true,
    } as unknown as ToolCallContext['readFileState']

    const res = await applyPatch.call(
      { patch: wrap('*** Update File: f.ts\n-a\n+b') },
      ctx({ readFileState: stale }),
    )
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/changed on disk/)
    expect(readFileSync(p('f.ts'), 'utf-8')).toBe('a\n')
  })

  it('refreshes the read snapshot for files it wrote', async () => {
    writeFileSync(p('f.ts'), 'a\n')
    const recorded: string[] = []
    const cache = {
      get: () => undefined,
      record: (path: string) => { recorded.push(path) },
      has: () => false,
    } as unknown as ToolCallContext['readFileState']

    await applyPatch.call({ patch: wrap('*** Update File: f.ts\n-a\n+b') }, ctx({ readFileState: cache }))
    // Without this a follow-up edit_file in the same turn trips the TOCTOU
    // guard on bytes apply_patch itself just wrote.
    expect(recorded).toContain(p('f.ts'))
  })

  it('validates its input', async () => {
    expect((await applyPatch.call({}, ctx())).isError).toBe(true)
    expect((await applyPatch.call({ patch: '   ' }, ctx())).isError).toBe(true)
    expect((await applyPatch.call({ patch: 'garbage' }, ctx())).content).toMatch(/parse error/)
  })
})

describe('turn tracking integration', () => {
  it('apply_patch captures baselines before writing', async () => {
    writeFileSync(p('a.ts'), 'v1\n')
    await applyPatch.call(
      {
        patch: wrap('*** Update File: a.ts\n-v1\n+v2\n*** Add File: b.ts\n+fresh'),
      },
      ctx({ turnDiff: tracker }),
    )

    const summary = await tracker.summary()
    const byPath = new Map(summary.entries.map(e => [e.path, e]))
    expect(byPath.get(p('a.ts'))?.before).toBe('v1\n')
    expect(byPath.get(p('a.ts'))?.after).toBe('v2\n')
    expect(byPath.get(p('b.ts'))?.status).toBe('added')
  })

  it('write_file, edit_file and append_file all feed the tracker', async () => {
    const [write, edit, append] = await Promise.all([
      createWriteFileTool(), createEditFileTool(), createAppendFileTool(),
    ])
    const c = ctx({ turnDiff: tracker })

    await write.call({ file_path: p('w.txt'), content: 'written\n' }, c)
    writeFileSync(p('e.txt'), 'old\n')
    await edit.call({ file_path: p('e.txt'), old_string: 'old', new_string: 'new' }, c)
    await append.call({ file_path: p('e.txt'), content: 'extra\n' }, c)

    const summary = await tracker.summary()
    expect(summary.filesChanged).toBe(2)
    const e = summary.entries.find(x => x.path === p('e.txt'))
    // append captured nothing new — the baseline is still the turn-start bytes.
    expect(e?.before).toBe('old\n')
    expect(e?.after).toBe('new\nextra\n')
  })

  it('a failed edit does not register the file as touched', async () => {
    // The turn diff must describe what CHANGED, not what was attempted.
    const edit = await createEditFileTool()
    writeFileSync(p('e.txt'), 'content\n')
    const res = await edit.call(
      { file_path: p('e.txt'), old_string: 'nonexistent', new_string: 'x' },
      ctx({ turnDiff: tracker }),
    )
    expect(res.isError).toBe(true)
    expect(tracker.trackedPaths()).toHaveLength(0)
  })

  it('tools behave identically with no tracker present', async () => {
    const write = await createWriteFileTool()
    const res = await write.call({ file_path: p('n.txt'), content: 'x\n' }, ctx())
    expect(res.isError).toBe(false)
    expect(readFileSync(p('n.txt'), 'utf-8')).toBe('x\n')
  })
})

describe('turn_diff tool', () => {
  it('renders the turn diff', async () => {
    writeFileSync(p('a.ts'), 'one\n')
    await applyPatch.call(
      { patch: wrap('*** Update File: a.ts\n-one\n+ONE') },
      ctx({ turnDiff: tracker }),
    )
    const res = await turnDiff.call({}, ctx({ turnDiff: tracker }))
    expect(res.isError).toBe(false)
    expect(res.content).toContain('-one')
    expect(res.content).toContain('+ONE')
  })

  it('renders stat-only output', async () => {
    writeFileSync(p('a.ts'), 'one\n')
    await applyPatch.call(
      { patch: wrap('*** Update File: a.ts\n-one\n+ONE') },
      ctx({ turnDiff: tracker }),
    )
    const res = await turnDiff.call({ action: 'stat' }, ctx({ turnDiff: tracker }))
    expect(res.content).toMatch(/modified/)
    expect(res.content).not.toContain('+ONE')
  })

  it('reverts the turn, including files it created', async () => {
    writeFileSync(p('a.ts'), 'original\n')
    await applyPatch.call(
      { patch: wrap('*** Update File: a.ts\n-original\n+mangled\n*** Add File: b.ts\n+junk') },
      ctx({ turnDiff: tracker }),
    )
    expect(readFileSync(p('a.ts'), 'utf-8')).toBe('mangled\n')

    const res = await turnDiff.call({ action: 'revert' }, ctx({ turnDiff: tracker }))
    expect(res.isError).toBe(false)
    expect(readFileSync(p('a.ts'), 'utf-8')).toBe('original\n')
    expect(existsSync(p('b.ts'))).toBe(false)
  })

  it('says plainly when tracking is disabled instead of reporting no changes', async () => {
    // "No changes" would read as "my edits did not land", which is a different
    // and much more alarming statement than "tracking is off".
    const res = await turnDiff.call({}, ctx())
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/not enabled/)
  })

  it('rejects an unknown action', async () => {
    const res = await turnDiff.call({ action: 'explode' }, ctx({ turnDiff: tracker }))
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/unknown action/)
  })

  it('is not concurrency-safe, because revert writes', () => {
    expect(turnDiff.isConcurrencySafe).toBe(false)
    expect(turnDiff.permission?.planMode).toBe('ask')
  })
})

describe('registration', () => {
  it('createFsTools includes apply_patch and turn_diff', async () => {
    const names = (await createFsTools()).map(t => t.name)
    expect(names).toContain('apply_patch')
    expect(names).toContain('turn_diff')
    // The existing set must be untouched.
    for (const legacy of ['read_file', 'write_file', 'append_file', 'edit_file', 'glob', 'grep', 'notebook_edit']) {
      expect(names, legacy).toContain(legacy)
    }
  })

  it('turnDiff: false drops only turn_diff', async () => {
    const names = (await createFsTools({ turnDiff: false })).map(t => t.name)
    expect(names).not.toContain('turn_diff')
    expect(names).toContain('apply_patch')
  })

  it('every fs tool resolves to an abort contract (auto mode rejects undeclared)', async () => {
    // Resolution, not the raw field: the older fs tools rely on the adapter's
    // built-in bounded list rather than declaring inline. What auto mode checks
    // is the resolved value, so that is what the test must check.
    for (const tool of await createFsTools()) {
      expect(resolveToolAbortSupport(tool), tool.name).toBeDefined()
    }
  })
})
