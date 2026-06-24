import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { withReadonlySnapshot, THIS_ROUND_DIFF_FILE } from '../JudgeSnapshot.js'

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
}

describe('withReadonlySnapshot', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ma-snap-'))
  })
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  })

  it('passes null when not a git repo', async () => {
    const got = await withReadonlySnapshot(dir, async p => p)
    expect(got).toBeNull()
  })

  it('passes a null diff when not a git repo', async () => {
    const diff = await withReadonlySnapshot(dir, async (_p, d) => d)
    expect(diff).toBeNull()
  })

  it('pre-computes the round diff (stat + patch) and materialises THIS_ROUND.diff', async () => {
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 't@t.dev'])
    git(dir, ['config', 'user.name', 'tester'])
    writeFileSync(join(dir, 'committed.txt'), 'original\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-m', 'init'])

    // Executor-style mutations WITHOUT committing:
    writeFileSync(join(dir, 'committed.txt'), 'EDITED\n')   // tracked edit
    writeFileSync(join(dir, 'brand-new.txt'), 'NEW\n')      // untracked new file

    const captured = await withReadonlySnapshot(dir, async (snap, diff) => {
      return {
        diff,
        // THIS_ROUND.diff must exist INSIDE the snapshot for the read-only judge.
        roundFile: existsSync(join(snap!, THIS_ROUND_DIFF_FILE))
          ? readFileSync(join(snap!, THIS_ROUND_DIFF_FILE), 'utf-8')
          : null,
      }
    })

    expect(captured.diff).not.toBeNull()
    // --stat names both the tracked edit and the untracked new file.
    expect(captured.diff!.stat).toContain('committed.txt')
    expect(captured.diff!.stat).toContain('brand-new.txt')
    expect(captured.diff!.truncated).toBe(false)
    // Full patch carries the actual line-level change and the new content.
    expect(captured.diff!.patch).toContain('EDITED')
    expect(captured.diff!.patch).toContain('NEW')
    // Materialised artifact mirrors the patch and is readable in the snapshot.
    expect(captured.roundFile).not.toBeNull()
    expect(captured.roundFile).toContain('brand-new.txt')
  })

  it('reports an empty diff when nothing changed since HEAD', async () => {
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 't@t.dev'])
    git(dir, ['config', 'user.name', 'tester'])
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-m', 'init'])
    // No working-tree changes after the commit.

    const diff = await withReadonlySnapshot(dir, async (_snap, d) => d)
    expect(diff).not.toBeNull()
    expect(diff!.stat.trim()).toBe('')
    expect(diff!.patch.trim()).toBe('')
  })

  it('captures uncommitted edits AND untracked new files', async () => {
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 't@t.dev'])
    git(dir, ['config', 'user.name', 'tester'])
    writeFileSync(join(dir, 'committed.txt'), 'original\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-m', 'init'])

    // Executor-style mutations WITHOUT committing:
    writeFileSync(join(dir, 'committed.txt'), 'EDITED\n')   // uncommitted edit
    writeFileSync(join(dir, 'brand-new.txt'), 'NEW\n')      // untracked new file

    const result = await withReadonlySnapshot(dir, async snap => {
      expect(snap).not.toBeNull()
      return {
        edited: readFileSync(join(snap!, 'committed.txt'), 'utf-8'),
        hasNew: existsSync(join(snap!, 'brand-new.txt')),
        newBody: existsSync(join(snap!, 'brand-new.txt'))
          ? readFileSync(join(snap!, 'brand-new.txt'), 'utf-8')
          : '',
      }
    })

    expect(result.edited).toBe('EDITED\n')   // sees the uncommitted edit
    expect(result.hasNew).toBe(true)         // sees the untracked file
    expect(result.newBody).toBe('NEW\n')
  })

  it('cleans up the worktree after use and leaves the live tree untouched', async () => {
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 't@t.dev'])
    git(dir, ['config', 'user.name', 'tester'])
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-m', 'init'])
    writeFileSync(join(dir, 'a.txt'), 'live-edit\n')

    await withReadonlySnapshot(dir, async () => undefined)

    // Snapshot worktree removed.
    expect(existsSync(join(dir, '.meta-agent', 'auto', 'verify-snapshot'))).toBe(false)
    // Live working tree edit is preserved (snapshot used an isolated index).
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('live-edit\n')
  })
})
