import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AutoWorktreeCoordinator } from '../AutoWorktreeCoordinator.js'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  writeFileSync(join(dir, 'README.md'), 'base\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'init'])
}

describe('AutoWorktreeCoordinator', () => {
  let repo: string
  beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'auto-wt-')) })
  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  it('enabled is false for a non-git directory', () => {
    const coord = new AutoWorktreeCoordinator(repo)
    expect(coord.enabled).toBe(false)
  })

  it('allocate returns null when not a git repo (caller falls back)', async () => {
    const coord = new AutoWorktreeCoordinator(repo)
    expect(await coord.allocate('task-1')).toBeNull()
  })

  it('allocates an isolated worktree+branch over a git repo', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    expect(coord.enabled).toBe(true)
    const handle = await coord.allocate('task-1')
    expect(handle).not.toBeNull()
    expect(existsSync(handle!.worktreePath)).toBe(true)
    expect(handle!.branchName).toContain('task-1')
    expect(coord.activeTasks()).toContain('task-1')
  })

  it('merges a sub-agent worktree branch back into main (serial integration)', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    const handle = await coord.allocate('task-1')

    // Simulate the sub-agent doing isolated work in its worktree.
    writeFileSync(join(handle!.worktreePath, 'feature.txt'), 'from sub-agent\n')
    git(handle!.worktreePath, ['add', '.'])
    git(handle!.worktreePath, ['commit', '-q', '-m', 'sub-agent work'])

    // Main agent merges it back (squash).
    const result = await coord.merge('task-1')
    expect(result?.merged).toBe(true)

    // The file now exists on main.
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true)
    expect(readFileSync(join(repo, 'feature.txt'), 'utf-8')).toContain('from sub-agent')
    // A successful merge reclaims the worktree and stops tracking the task,
    // so it can't be double-merged and doesn't linger on disk.
    expect(existsSync(handle!.worktreePath)).toBe(false)
    expect(coord.activeTasks()).not.toContain('task-1')
    expect(await coord.merge('task-1')).toBeNull()
  })

  it('finalize commits dirty and untracked worktree files before merge', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    const handle = await coord.allocate('task-dirty', 'session-1')
    writeFileSync(join(handle!.worktreePath, 'dirty.txt'), 'uncommitted output\n')

    const finalized = await coord.finalize('task-dirty')
    expect(finalized.status).toBe('committed')
    expect(finalized.changedFiles).toContain('dirty.txt')
    expect(git(handle!.worktreePath, ['status', '--porcelain'])).toBe('')
    expect(coord.recordFor('task-dirty')).toMatchObject({
      sessionId: 'session-1',
      phase: 'awaiting_merge',
      finalizedCommit: finalized.commitHash,
    })

    await coord.merge('task-dirty')
    expect(readFileSync(join(repo, 'dirty.txt'), 'utf-8')).toBe('uncommitted output\n')
  })

  it('finalize is idempotent after a worktree is awaiting merge', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    const handle = await coord.allocate('task-idempotent', 'session-1')
    writeFileSync(join(handle!.worktreePath, 'once.txt'), 'one commit\n')

    const first = await coord.finalize('task-idempotent')
    const second = await coord.finalize('task-idempotent')

    expect(first.status).toBe('committed')
    expect(second).toEqual({
      status: 'already_committed',
      commitHash: first.commitHash,
      changedFiles: [],
    })
  })

  it('persists task-to-branch mapping and restores a missing worktree on reconcile', async () => {
    initRepo(repo)
    const first = new AutoWorktreeCoordinator(repo)
    const handle = await first.allocate('task-resume', 'session-1')
    writeFileSync(join(handle!.worktreePath, 'resume.txt'), 'resume me\n')
    await first.finalize('task-resume')
    git(repo, ['worktree', 'remove', '--force', handle!.worktreePath])
    expect(existsSync(handle!.worktreePath)).toBe(false)

    const resumed = new AutoWorktreeCoordinator(repo)
    expect(resumed.branchFor('task-resume')).toBe(handle!.branchName)
    const reconciled = await resumed.reconcile()
    expect(reconciled.restored).toContain('task-resume')
    expect(existsSync(handle!.worktreePath)).toBe(true)
    expect(readFileSync(join(handle!.worktreePath, 'resume.txt'), 'utf-8')).toBe('resume me\n')
  })

  it('rolls back a conflicting merge and restores the main tree dirty state', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    const handle = await coord.allocate('task-conflict', 'session-1')

    writeFileSync(join(handle!.worktreePath, 'README.md'), 'sub-agent version\n')
    await coord.finalize('task-conflict')

    // The main agent has an uncommitted edit to the same file. Integration
    // succeeds against clean HEAD, then stash restoration conflicts; the whole
    // transaction must roll back to the original HEAD and dirty contents.
    const beforeHead = git(repo, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repo, 'README.md'), 'main dirty version\n')

    await expect(coord.merge('task-conflict')).rejects.toThrow(/rolled back/)
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead)
    expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('main dirty version\n')
    expect(git(repo, ['status', '--porcelain'])).toContain('README.md')
    expect(git(repo, ['diff', '--name-only', '--diff-filter=U'])).toBe('')
    expect(coord.recordFor('task-conflict')?.phase).toBe('conflicted')
    expect(existsSync(handle!.worktreePath)).toBe(true)
  })

  it('preserves staged, unstaged and untracked main-tree state after a successful merge', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    const handle = await coord.allocate('task-preserve', 'session-1')
    writeFileSync(join(handle!.worktreePath, 'feature.txt'), 'branch output\n')
    await coord.finalize('task-preserve')

    writeFileSync(join(repo, 'README.md'), 'staged main edit\n')
    git(repo, ['add', 'README.md'])
    writeFileSync(join(repo, 'README.md'), 'staged plus unstaged main edit\n')
    writeFileSync(join(repo, 'local.txt'), 'untracked main file\n')

    await coord.merge('task-preserve')

    expect(readFileSync(join(repo, 'feature.txt'), 'utf-8')).toBe('branch output\n')
    expect(readFileSync(join(repo, 'README.md'), 'utf-8'))
      .toBe('staged plus unstaged main edit\n')
    expect(readFileSync(join(repo, 'local.txt'), 'utf-8')).toBe('untracked main file\n')
    const status = git(repo, ['status', '--porcelain'])
    expect(status).toContain('MM README.md')
    expect(status).toContain('?? local.txt')
  })

  it('recovers an interrupted merge transaction from the durable registry', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    const handle = await coord.allocate('task-crash', 'session-1')
    writeFileSync(join(handle!.worktreePath, 'feature.txt'), 'branch output\n')
    await coord.finalize('task-crash')

    const preMergeHead = git(repo, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repo, 'README.md'), 'main dirty before crash\n')
    git(repo, [
      'stash',
      'push',
      '--include-untracked',
      '-m',
      'simulated transaction',
      '--',
      '.',
      ':(exclude).meta-agent/**',
    ])
    const stashCommit = git(repo, ['rev-parse', 'refs/stash']).trim()
    git(repo, ['merge', '--squash', handle!.branchName])
    git(repo, ['commit', '-q', '-m', 'partially integrated before crash'])

    const registryPath = join(repo, '.git', 'meta-agent', 'auto-worktrees.json')
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
    registry.tasks['task-crash'] = {
      ...registry.tasks['task-crash'],
      phase: 'merging',
      preMergeHead,
      stashCommit,
    }
    writeFileSync(registryPath, JSON.stringify(registry, null, 2))

    const resumed = new AutoWorktreeCoordinator(repo)
    const result = await resumed.reconcile()
    expect(result.recoveredTransactions).toContain('task-crash')
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(preMergeHead)
    expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('main dirty before crash\n')
    expect(existsSync(join(repo, 'feature.txt'))).toBe(false)
    expect(resumed.recordFor('task-crash')?.phase).toBe('conflicted')
    expect(git(repo, ['stash', 'list', '--format=%H'])).not.toContain(stashCommit)
  })

  it('does not let runtime .meta-agent files enter the main merge transaction', async () => {
    initRepo(repo)
    const runtimeDir = join(repo, '.meta-agent', 'auto')
    require('fs').mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'checkpoint.json'), '{"keep":true}\n')
    const coord = new AutoWorktreeCoordinator(repo)
    const handle = await coord.allocate('task-runtime', 'session-1')
    writeFileSync(join(handle!.worktreePath, 'feature.txt'), 'feature\n')

    await coord.merge('task-runtime')
    expect(readFileSync(join(runtimeDir, 'checkpoint.json'), 'utf-8')).toBe('{"keep":true}\n')
    expect(readFileSync(join(repo, 'feature.txt'), 'utf-8')).toBe('feature\n')
  })

  it('does not finalize worktree-local .meta-agent runtime state into the task branch', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    const handle = await coord.allocate('task-runtime-local', 'session-1')
    const runtimeDir = join(handle!.worktreePath, '.meta-agent', 'auto')
    require('fs').mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'checkpoint.json'), '{"runtime":true}\n')
    writeFileSync(join(handle!.worktreePath, 'feature.txt'), 'feature\n')

    await coord.finalize('task-runtime-local')
    expect(git(handle!.worktreePath, ['show', '--name-only', '--format=', 'HEAD']))
      .toContain('feature.txt')
    expect(git(handle!.worktreePath, ['show', '--name-only', '--format=', 'HEAD']))
      .not.toContain('.meta-agent')
  })

  it('diff reports the branch changes vs main', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    const handle = await coord.allocate('task-1')
    writeFileSync(join(handle!.worktreePath, 'feature.txt'), 'x\n')
    git(handle!.worktreePath, ['add', '.'])
    git(handle!.worktreePath, ['commit', '-q', '-m', 'work'])
    const diff = await coord.diff('task-1')
    expect(diff).toContain('feature.txt')
  })

  it('discard removes the worktree and stops tracking the task', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    const handle = await coord.allocate('task-1')
    expect(existsSync(handle!.worktreePath)).toBe(true)
    await coord.discard('task-1')
    expect(coord.activeTasks()).not.toContain('task-1')
  })

  it('merge returns null for an unknown task', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    expect(await coord.merge('nope')).toBeNull()
  })

  it('cleanupAll discards every tracked worktree (no leak on teardown)', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    await coord.allocate('task-1')
    await coord.allocate('task-2')
    expect(coord.activeTasks().sort()).toEqual(['task-1', 'task-2'])
    await coord.cleanupAll()
    expect(coord.activeTasks()).toEqual([])
  })

  it('safe cleanup removes no-change finalized worktrees and preserves unmerged commits', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    const empty = await coord.allocate('task-empty')
    const changed = await coord.allocate('task-changed')
    writeFileSync(join(changed!.worktreePath, 'feature.txt'), 'keep me\n')

    await coord.finalize('task-empty')
    await coord.finalize('task-changed')

    const result = await coord.cleanup('safe')
    expect(result.removed).toContain('task-empty')
    expect(result.preserved.map(p => p.taskId)).toContain('task-changed')
    expect(existsSync(empty!.worktreePath)).toBe(false)
    expect(existsSync(changed!.worktreePath)).toBe(true)
    expect(coord.activeTasks()).toEqual(['task-changed'])
  })

  it('aggressive cleanup discards tracked worktrees even when commits await merge', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    const handle = await coord.allocate('task-changed')
    writeFileSync(join(handle!.worktreePath, 'feature.txt'), 'discard me\n')
    await coord.finalize('task-changed')

    const result = await coord.cleanup('aggressive')
    expect(result.removed).toContain('task-changed')
    expect(coord.activeTasks()).toEqual([])
    expect(existsSync(handle!.worktreePath)).toBe(false)
  })

  it('cleanupAll is a no-op when nothing is tracked', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    await expect(coord.cleanupAll()).resolves.toBeUndefined()
  })
})
