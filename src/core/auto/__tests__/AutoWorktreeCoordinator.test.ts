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

  it('cleanupAll is a no-op when nothing is tracked', async () => {
    initRepo(repo)
    const coord = new AutoWorktreeCoordinator(repo)
    await expect(coord.cleanupAll()).resolves.toBeUndefined()
  })
})
