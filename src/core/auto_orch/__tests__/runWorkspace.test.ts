/**
 * RunWorkspace integration tests — real git repos in temp dirs.
 *
 * These pin the run-level transaction semantics:
 *   • run completed  → ONE squash merge of the integration branch into main;
 *   • run failed     → discard everything, main byte-for-byte untouched;
 *   • either way     → no stash residue, no leftover worktrees/branches, and a
 *     re-run right after a failure works (the "git stash error on re-run" bug).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createAutoOrchRunWorkspace,
  attachAutoOrchRunWorkspace,
  sweepStaleAutoOrchRuns,
  AUTO_ORCH_RUN_BRANCH_PREFIX,
} from '../RunWorkspace.js'
import { snapshotFileHashes, verifyIntegration } from '../KernelBranchOps.js'

let repo: string

function git(args: string[], cwd: string = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-orch-ws-'))
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@meta-agent.dev'], dir)
  git(['config', 'user.name', 'meta-agent-test'], dir)
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  git(['add', '-A'], dir)
  git(['commit', '-m', 'init'], dir)
  return dir
}

function branches(): string[] {
  return git(['branch', '--format=%(refname:short)']).split('\n').filter(Boolean)
}

function stashCount(): number {
  const out = git(['stash', 'list'])
  return out ? out.split('\n').filter(Boolean).length : 0
}

beforeEach(() => {
  repo = initRepo()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('createAutoOrchRunWorkspace', () => {
  it('forks an integration branch into a private tree and seeds state/', async () => {
    mkdirSync(join(repo, 'state'), { recursive: true })
    writeFileSync(join(repo, 'state', 'progress.json'), '{"n":1}')
    const ws = await createAutoOrchRunWorkspace(repo)
    expect(ws).not.toBeNull()
    expect(existsSync(ws!.root)).toBe(true)
    expect(branches()).toContain(ws!.branchName)
    // Untracked state/ files were copied into the integration tree.
    expect(readFileSync(join(ws!.root, 'state', 'progress.json'), 'utf-8')).toBe('{"n":1}')
    // Main HEAD is the fork point.
    expect(ws!.forkPoint).toBe(git(['rev-parse', 'HEAD']))
    await ws!.finishDiscard()
  })

  it('returns null for a non-git workspace (legacy on-main fallback)', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'auto-orch-plain-'))
    try {
      expect(await createAutoOrchRunWorkspace(plain)).toBeNull()
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('finishSuccess', () => {
  it('squash-merges the run branch into main and cleans everything up', async () => {
    const ws = (await createAutoOrchRunWorkspace(repo))!
    // Simulate a node's work landing on the run branch.
    writeFileSync(join(ws.root, 'feature.ts'), 'export const x = 1\n')
    expect(await ws.commitAll('node work')).toBe(true)

    const preHead = git(['rev-parse', 'HEAD'])
    const fin = await ws.finishSuccess('auto_orch run: test goal')
    expect(fin.merged).toBe(true)
    // Main gained exactly one commit with the node's file.
    expect(git(['rev-parse', 'HEAD'])).not.toBe(preHead)
    expect(readFileSync(join(repo, 'feature.ts'), 'utf-8')).toBe('export const x = 1\n')
    expect(git(['status', '--porcelain'])).toBe('')
    // No residue: branch, tree, stash all gone.
    expect(branches().some(b => b.startsWith(AUTO_ORCH_RUN_BRANCH_PREFIX))).toBe(false)
    expect(existsSync(ws.root)).toBe(false)
    expect(stashCount()).toBe(0)
  })

  it('merges through an isolated task worktree (executor path) end to end', async () => {
    const ws = (await createAutoOrchRunWorkspace(repo))!
    // Executor: task worktree forked from the RUN branch, merged back into it.
    const handle = await ws.coordinator.allocate('task-1', 'test-session')
    expect(handle).not.toBeNull()
    expect(git(['rev-parse', 'HEAD'], handle!.worktreePath)).toBe(ws.forkPoint)
    writeFileSync(join(handle!.worktreePath, 'src.txt'), 'work\n')
    const merged = await ws.coordinator.merge('task-1', { message: 'node merge' })
    expect(merged?.merged).toBe(true)
    // Landed on the run branch, NOT on main.
    expect(readFileSync(join(ws.root, 'src.txt'), 'utf-8')).toBe('work\n')
    expect(existsSync(join(repo, 'src.txt'))).toBe(false)

    const fin = await ws.finishSuccess('auto_orch run: executor')
    expect(fin.merged).toBe(true)
    expect(readFileSync(join(repo, 'src.txt'), 'utf-8')).toBe('work\n')
    expect(stashCount()).toBe(0)
    expect(branches()).toEqual(['main'])
  })

  it('preserves the user\'s uncommitted changes on a dirty main', async () => {
    const ws = (await createAutoOrchRunWorkspace(repo))!
    writeFileSync(join(ws.root, 'feature.ts'), 'x\n')
    await ws.commitAll('node work')
    // User dirties main while the run executes.
    writeFileSync(join(repo, 'wip.txt'), 'my uncommitted work\n')
    writeFileSync(join(repo, 'README.md'), 'hello edited\n')

    const fin = await ws.finishSuccess('auto_orch run: dirty main')
    expect(fin.merged).toBe(true)
    expect(readFileSync(join(repo, 'feature.ts'), 'utf-8')).toBe('x\n')
    expect(readFileSync(join(repo, 'wip.txt'), 'utf-8')).toBe('my uncommitted work\n')
    expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('hello edited\n')
    expect(stashCount()).toBe(0)
  })

  it('rolls main back and preserves the branch when the final merge conflicts', async () => {
    const ws = (await createAutoOrchRunWorkspace(repo))!
    writeFileSync(join(ws.root, 'README.md'), 'run version\n')
    await ws.commitAll('run edits README')
    // Main diverges on the same file after the fork → squash merge conflicts.
    writeFileSync(join(repo, 'README.md'), 'main version\n')
    git(['add', '-A'])
    git(['commit', '-m', 'main diverges'])
    const preHead = git(['rev-parse', 'HEAD'])
    writeFileSync(join(repo, 'wip.txt'), 'dirty\n')

    const fin = await ws.finishSuccess('auto_orch run: conflict')
    expect(fin.merged).toBe(false)
    expect(fin.branchPreserved).toBe(true)
    // Main rolled back byte-for-byte: HEAD unchanged, dirty file restored.
    expect(git(['rev-parse', 'HEAD'])).toBe(preHead)
    expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('main version\n')
    expect(readFileSync(join(repo, 'wip.txt'), 'utf-8')).toBe('dirty\n')
    expect(stashCount()).toBe(0)
    // The work survives on the preserved branch for manual recovery.
    expect(branches()).toContain(ws.branchName)
    // A defensive finishDiscard afterwards must NOT destroy the preserved branch.
    await ws.finishDiscard()
    expect(branches()).toContain(ws.branchName)
  })

  it('is a no-op merge when the run branch has no changes', async () => {
    const ws = (await createAutoOrchRunWorkspace(repo))!
    const preHead = git(['rev-parse', 'HEAD'])
    const fin = await ws.finishSuccess('auto_orch run: empty')
    expect(fin.merged).toBe(true)
    expect(git(['rev-parse', 'HEAD'])).toBe(preHead)
    expect(branches()).toEqual(['main'])
  })
})

describe('finishDiscard', () => {
  it('discards all run work and leaves main byte-for-byte untouched', async () => {
    writeFileSync(join(repo, 'wip.txt'), 'user work\n')
    const preHead = git(['rev-parse', 'HEAD'])
    const ws = (await createAutoOrchRunWorkspace(repo))!
    // Node work on the run branch + a task worktree left mid-flight.
    writeFileSync(join(ws.root, 'junk.ts'), 'garbage\n')
    await ws.commitAll('doomed work')
    await ws.coordinator.allocate('task-x', 'test-session')

    await ws.finishDiscard()
    expect(git(['rev-parse', 'HEAD'])).toBe(preHead)
    expect(existsSync(join(repo, 'junk.ts'))).toBe(false)
    expect(readFileSync(join(repo, 'wip.txt'), 'utf-8')).toBe('user work\n')
    expect(branches()).toEqual(['main'])
    expect(existsSync(ws.root)).toBe(false)
    expect(stashCount()).toBe(0)
    expect(git(['status', '--porcelain'])).toBe('?? wip.txt')
  })

  it('a failed run leaves the repo re-runnable (the stash-error regression)', async () => {
    const ws1 = (await createAutoOrchRunWorkspace(repo))!
    writeFileSync(join(ws1.root, 'a.txt'), '1\n')
    await ws1.commitAll('run1')
    await ws1.finishDiscard()

    // Second run right after a failure: must create, execute and merge cleanly.
    const ws2 = (await createAutoOrchRunWorkspace(repo))!
    expect(ws2).not.toBeNull()
    writeFileSync(join(ws2.root, 'b.txt'), '2\n')
    await ws2.commitAll('run2')
    const fin = await ws2.finishSuccess('run2 done')
    expect(fin.merged).toBe(true)
    expect(readFileSync(join(repo, 'b.txt'), 'utf-8')).toBe('2\n')
    expect(existsSync(join(repo, 'a.txt'))).toBe(false)
    expect(stashCount()).toBe(0)
  })
})

describe('attach + sweep', () => {
  it('re-attaches a persisted workspace, restoring a missing worktree dir', async () => {
    const ws = (await createAutoOrchRunWorkspace(repo))!
    writeFileSync(join(ws.root, 'kept.txt'), 'kept\n')
    await ws.commitAll('paused work')
    const desc = ws.descriptor()
    // Simulate a lost checkout (crash/reboot): remove the worktree directory.
    git(['worktree', 'remove', '--force', ws.root])

    const attached = await attachAutoOrchRunWorkspace(repo, desc)
    expect(attached).not.toBeNull()
    expect(readFileSync(join(attached!.root, 'kept.txt'), 'utf-8')).toBe('kept\n')
    const fin = await attached!.finishSuccess('resumed run')
    expect(fin.merged).toBe(true)
    expect(readFileSync(join(repo, 'kept.txt'), 'utf-8')).toBe('kept\n')
  })

  it('returns null when the run branch no longer exists', async () => {
    const ws = (await createAutoOrchRunWorkspace(repo))!
    const desc = ws.descriptor()
    await ws.finishDiscard()
    expect(await attachAutoOrchRunWorkspace(repo, desc)).toBeNull()
  })

  it('sweeps stale runs but protects the keep set', async () => {
    const stale = (await createAutoOrchRunWorkspace(repo))!
    const kept = (await createAutoOrchRunWorkspace(repo))!
    const removed = await sweepStaleAutoOrchRuns(repo, new Set([kept.runId]))
    expect(removed).toContain(stale.runId)
    expect(removed).not.toContain(kept.runId)
    expect(branches()).toContain(kept.branchName)
    expect(branches()).not.toContain(stale.branchName)
    expect(existsSync(stale.root)).toBe(false)
    await kept.finishDiscard()
  })
})

describe('verifyIntegration (H1: a completed integrator is not a merge)', () => {
  it('rejects when no conflict file changed', async () => {
    writeFileSync(join(repo, 'c.txt'), 'original\n')
    const before = await snapshotFileHashes(repo, ['c.txt'])
    const v = await verifyIntegration(repo, ['c.txt'], before)
    expect(v.ok).toBe(false)
  })

  it('rejects leftover conflict markers', async () => {
    writeFileSync(join(repo, 'c.txt'), 'original\n')
    const before = await snapshotFileHashes(repo, ['c.txt'])
    writeFileSync(join(repo, 'c.txt'), '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n')
    const v = await verifyIntegration(repo, ['c.txt'], before)
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.reason).toMatch(/conflict markers/)
  })

  it('accepts a real reconciliation', async () => {
    writeFileSync(join(repo, 'c.txt'), 'original\n')
    const before = await snapshotFileHashes(repo, ['c.txt'])
    writeFileSync(join(repo, 'c.txt'), 'merged both sides\n')
    const v = await verifyIntegration(repo, ['c.txt'], before)
    expect(v.ok).toBe(true)
  })
})
