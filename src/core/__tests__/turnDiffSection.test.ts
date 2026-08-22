/**
 * The supplementary change view handed to the verify / drift judges.
 *
 * The property under test throughout: this must add information the git
 * snapshot diff could not provide, and must never repeat information it did.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TurnDiffTracker } from '../../infra/fs/TurnDiffTracker.js'
import { renderTurnDiffSection, pathsInGitStat } from '../auto/turnDiffSection.js'

let ws: string
let tracker: TurnDiffTracker
const p = (n: string): string => join(ws, n)

async function touch(name: string, before: string | null, after: string | null): Promise<void> {
  if (before !== null) writeFileSync(p(name), before)
  await tracker.capture(p(name))
  if (after === null) rmSync(p(name), { force: true })
  else writeFileSync(p(name), after)
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'turn-diff-section-'))
  tracker = new TurnDiffTracker()
  tracker.beginTurn('run')
})

afterEach(() => rmSync(ws, { recursive: true, force: true }))

describe('pathsInGitStat', () => {
  it('extracts filenames from a git --stat block', () => {
    const stat = [
      ' src/a.ts       | 12 ++++++------',
      ' src/b/c.ts     |  3 +++',
      ' 2 files changed, 15 insertions(+), 6 deletions(-)',
    ].join('\n')
    const paths = pathsInGitStat(stat)
    expect(paths.has('src/a.ts')).toBe(true)
    expect(paths.has('src/b/c.ts')).toBe(true)
    // The summary line has no pipe and must not be mistaken for a filename.
    expect(paths.size).toBe(2)
  })

  it('records both halves of a rename', () => {
    const paths = pathsInGitStat(' src/old.ts => src/new.ts | 4 ++--')
    expect(paths.has('src/old.ts')).toBe(true)
    expect(paths.has('src/new.ts')).toBe(true)
  })

  it('survives junk without throwing', () => {
    expect(() => pathsInGitStat('')).not.toThrow()
    expect(pathsInGitStat('no pipes here').size).toBe(0)
  })
})

describe('renderTurnDiffSection', () => {
  it('returns null when nothing was tracked', async () => {
    // NOT an empty-state string: a tracker miss is not evidence that nothing
    // happened (it only sees tool writes), and the judge must not read it as
    // "the executor did nothing" — only git can support that claim.
    expect(await renderTurnDiffSection(tracker, { workspaceRoot: ws })).toBeNull()
  })

  it('returns null when a captured file ended up unchanged', async () => {
    await touch('same.ts', 'x\n', 'x\n')
    expect(await renderTurnDiffSection(tracker, { workspaceRoot: ws })).toBeNull()
  })

  it('renders a stat block with relative paths and totals', async () => {
    await touch('a.ts', 'one\n', 'one\ntwo\n')
    await touch('gone.ts', 'bye\n', null)
    await touch('new.ts', null, 'fresh\n')

    const out = await renderTurnDiffSection(tracker, { workspaceRoot: ws })
    expect(out).toContain('修改 a.ts')
    expect(out).toContain('删除 gone.ts')
    expect(out).toContain('新增 new.ts')
    // Absolute paths would leak the temp dir and waste tokens.
    expect(out).not.toContain(ws)
    expect(out).toMatch(/3 个文件/)
  })

  it('drops files the git diff already showed', async () => {
    // Repeating them would spend tokens restating what the judge was already
    // told, and bury the part that is genuinely new.
    await touch('tracked.ts', 'a\n', 'b\n')
    await touch('ignored.ts', 'a\n', 'b\n')

    const out = await renderTurnDiffSection(tracker, {
      workspaceRoot: ws,
      coveredPaths: new Set(['tracked.ts']),
    })
    expect(out).not.toContain('tracked.ts')
    expect(out).toContain('ignored.ts')
    expect(out).toMatch(/git 看不到的改动/)
  })

  it('returns null when git already covered everything', async () => {
    await touch('a.ts', 'a\n', 'b\n')
    const out = await renderTurnDiffSection(tracker, {
      workspaceRoot: ws,
      coveredPaths: new Set(['a.ts']),
    })
    expect(out).toBeNull()
  })

  it('uses the plain header when there is no git view to complement', async () => {
    await touch('a.ts', 'a\n', 'b\n')
    const out = await renderTurnDiffSection(tracker, { workspaceRoot: ws })
    expect(out).toMatch(/由写入工具记录/)
    expect(out).not.toMatch(/git 看不到/)
  })

  it('caps the stat block and says how many it dropped', async () => {
    for (let i = 0; i < 200; i++) {
      await touch(`file-with-a-fairly-long-name-${i}.ts`, 'a\n', 'b\n')
    }
    const out = await renderTurnDiffSection(tracker, { workspaceRoot: ws, maxChars: 900 })
    expect(out!.length).toBeLessThan(1_200)
    expect(out).toMatch(/未列出/)
  })

  it('includes a patch only when asked', async () => {
    await touch('a.ts', 'one\n', 'ONE\n')
    const stat = await renderTurnDiffSection(tracker, { workspaceRoot: ws })
    expect(stat).not.toContain('+ONE')

    const patch = await renderTurnDiffSection(tracker, {
      workspaceRoot: ws,
      includePatch: true,
    })
    expect(patch).toContain('+ONE')
    expect(patch).toContain('-one')
  })

  it('reports an oversized file rather than dropping it', async () => {
    const big = p('big.bin')
    writeFileSync(big, 'x'.repeat(3 * 1024 * 1024))
    await tracker.capture(big)
    writeFileSync(big, 'y'.repeat(3 * 1024 * 1024))

    const out = await renderTurnDiffSection(tracker, { workspaceRoot: ws })
    expect(out).toMatch(/文件过大/)
  })

  it('never throws when the tracker itself fails', async () => {
    // This runs inside a gate. A tracker fault must degrade the judge's view,
    // never break the gate that was only trying to enrich it.
    const broken = {
      summary: () => Promise.reject(new Error('boom')),
    } as unknown as TurnDiffTracker
    await expect(renderTurnDiffSection(broken)).resolves.toBeNull()
  })
})
