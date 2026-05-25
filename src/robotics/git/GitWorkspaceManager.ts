import { execFile } from 'child_process'
import { promisify } from 'util'
import { stat, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { RoboticsAgentRole, RoboticsGitState } from '../types.js'
import type { SubAgentTaskId } from '../../subagent/types.js'

const execFileAsync = promisify(execFile)
const WORKTREE_BASE = join(homedir(), '.cache', 'meta-agent', 'worktrees')

export interface GitWorktreeRecord {
  taskId: SubAgentTaskId
  role: RoboticsAgentRole
  branchName: string
  worktreePath: string
  forkPoint: string
  createdAt: number
}

export interface GitSyncResult {
  branchName: string
  commitsAhead: number
  commitsBehind: number
  hasConflicts: boolean
}

export class GitWorkspaceManager {
  private readonly projectDir: string
  private readonly worktreeBaseDir: string
  private _gitMutationChain: Promise<void> = Promise.resolve()

  constructor(projectDir: string, worktreeBaseDir?: string) {
    this.projectDir = projectDir
    this.worktreeBaseDir = worktreeBaseDir ?? WORKTREE_BASE
  }

  get enabled(): boolean {
    return existsSync(join(this.projectDir, '.git'))
  }

  async detectGitState(): Promise<RoboticsGitState> {
    if (!this.enabled) return { enabled: false, mainBranch: 'main', subAgentBranches: {}, forkPoints: {} }
    try {
      const branch = (await this._git(['symbolic-ref', '--short', 'HEAD'])).trim()
      return { enabled: true, mainBranch: branch, subAgentBranches: {}, forkPoints: {} }
    } catch {
      return { enabled: false, mainBranch: 'main', subAgentBranches: {}, forkPoints: {} }
    }
  }

  async createWorktreeForTask(taskId: SubAgentTaskId, role: RoboticsAgentRole): Promise<GitWorktreeRecord> {
    return this._withGitMutationLock(async () => {
      const branchName = `sub/${taskId}/${role}`
      const worktreePath = join(this.worktreeBaseDir, taskId)
      const forkPoint = (await this._git(['rev-parse', 'HEAD'])).trim()
      await mkdir(this.worktreeBaseDir, { recursive: true })
      // Create the branch and worktree in one command. This avoids switching
      // the user's main working tree and keeps parallel dispatch deterministic.
      await this._git(['worktree', 'add', '-b', branchName, worktreePath, forkPoint])
      return { taskId, role, branchName, worktreePath, forkPoint, createdAt: Date.now() }
    })
  }

  async syncMainToTask(taskId: SubAgentTaskId, branchName: string): Promise<GitSyncResult> {
    return this._withGitMutationLock(async () => {
      const worktreePath = join(this.worktreeBaseDir, taskId)
      if (!(await this._worktreeExists(worktreePath))) {
        throw new Error(`Worktree not found for task ${taskId}`)
      }
      try {
        await this._gitIn(worktreePath, ['rebase', 'main'])
        const ahead  = parseInt((await this._gitIn(worktreePath, ['rev-list', '--count', 'main..HEAD'])).trim(), 10)
        const behind = parseInt((await this._gitIn(worktreePath, ['rev-list', '--count', 'HEAD..main'])).trim(), 10)
        return { branchName, commitsAhead: ahead, commitsBehind: behind, hasConflicts: false }
      } catch {
        await this._gitIn(worktreePath, ['rebase', '--abort']).catch(() => undefined)
        return { branchName, commitsAhead: 0, commitsBehind: 0, hasConflicts: true }
      }
    })
  }

  async mergeTaskBranch(
    taskId: SubAgentTaskId,
    branchName: string,
    opts: { strategy: 'squash' | 'merge' | 'cherry-pick'; message?: string; commitHashes?: string[] },
  ): Promise<{ merged: boolean; commitHash: string }> {
    return this._withGitMutationLock(async () => {
      const msg = opts.message ?? `feat: sub-agent ${branchName} results`
      switch (opts.strategy) {
        case 'squash':
          await this._git(['merge', '--squash', branchName])
          await this._git(['commit', '-m', msg])
          break
        case 'merge':
          await this._git(['merge', '--no-ff', '-m', msg, branchName])
          break
        case 'cherry-pick':
          if (!opts.commitHashes?.length) throw new Error('cherry-pick requires commitHashes')
          await this._git(['cherry-pick', ...opts.commitHashes])
          break
      }
      const commitHash = (await this._git(['rev-parse', 'HEAD'])).trim()
      return { merged: true, commitHash }
    })
  }

  async getTaskDiff(taskId: SubAgentTaskId, branchName: string): Promise<string> {
    try {
      return await this._git(['diff', 'main...', branchName, '--stat'])
    } catch {
      return 'Could not compute diff'
    }
  }

  async getTaskBranchStatus(taskId: SubAgentTaskId, branchName: string): Promise<{
    commitsAhead: number; commitsBehind: number; lastCommitMessage: string; lastCommitAt: number
  }> {
    try {
      const [aheadRaw, behindRaw, msgRaw, dateRaw] = await Promise.all([
        this._git(['rev-list', '--count', `main..${branchName}`]),
        this._git(['rev-list', '--count', `${branchName}..main`]),
        this._git(['log', '-1', '--format=%s', branchName]),
        this._git(['log', '-1', '--format=%at', branchName]),
      ])
      return {
        commitsAhead: parseInt(aheadRaw.trim(), 10),
        commitsBehind: parseInt(behindRaw.trim(), 10),
        lastCommitMessage: msgRaw.trim(),
        lastCommitAt: parseInt(dateRaw.trim(), 10) * 1000,
      }
    } catch {
      return { commitsAhead: 0, commitsBehind: 0, lastCommitMessage: '', lastCommitAt: 0 }
    }
  }

  async removeWorktree(taskId: SubAgentTaskId, opts: { deleteBranch?: boolean; branchName?: string } = {}): Promise<void> {
    return this._withGitMutationLock(async () => {
      const worktreePath = join(this.worktreeBaseDir, taskId)
      await this._git(['worktree', 'remove', '--force', worktreePath]).catch(() => undefined)
      if (opts.deleteBranch && opts.branchName) {
        await this._git(['branch', '-D', opts.branchName]).catch(() => undefined)
      }
    })
  }

  /**
   * Outcome-aware worktree cleanup.
   *
   * - success: remove worktree, optionally keep branch for code review /
   *   cherry-pick.  Default: keep branch (`deleteBranchOnSuccess = false`).
   * - failure: remove worktree, always keep branch for forensics.
   *
   * Use this instead of `removeWorktree()` when you know whether the sub-agent
   * succeeded, so cleanup intent is explicit in the call site.
   */
  async removeWorktreeWithOutcome(
    taskId: SubAgentTaskId,
    outcome: 'success' | 'failure',
    opts: { branchName?: string; deleteBranchOnSuccess?: boolean } = {},
  ): Promise<void> {
    const deleteBranch = outcome === 'success'
      ? (opts.deleteBranchOnSuccess ?? false)
      : false   // always keep branch on failure for forensics
    return this.removeWorktree(taskId, { deleteBranch, branchName: opts.branchName })
  }

  /**
   * Prune worktrees whose directory mtime is older than `ttlMs` milliseconds.
   *
   * Cleans up worktrees left on disk after a successful sub-agent run when the
   * caller did not explicitly call `removeWorktree()` (e.g. after a crash or
   * process restart).  Safe to call concurrently — runs inside the mutation lock.
   *
   * Returns the list of task IDs (directory names) that were pruned.
   */
  async pruneStaleWorktrees(ttlMs: number): Promise<string[]> {
    return this._withGitMutationLock(async () => {
      const pruned: string[] = []
      let entries: string[]
      try {
        const { readdir } = await import('fs/promises')
        entries = await readdir(this.worktreeBaseDir)
      } catch {
        return pruned  // base directory doesn't exist yet — nothing to prune
      }
      const now = Date.now()
      for (const entry of entries) {
        const worktreePath = join(this.worktreeBaseDir, entry)
        try {
          const s = await stat(worktreePath)
          if (!s.isDirectory()) continue
          if (now - s.mtimeMs > ttlMs) {
            await this._git(['worktree', 'remove', '--force', worktreePath])
              .catch(() => undefined)
            pruned.push(entry)
          }
        } catch { /* skip entries that disappeared mid-scan */ }
      }
      return pruned
    })
  }

  /**
   * Reconcile persisted worktree records against disk on session resume.
   *
   * For each recorded sub-agent branch:
   *   - If the worktree directory exists and is healthy → keep it as-is.
   *   - If missing → try to restore via `git worktree add`.
   *   - If restore also fails (branch deleted, repo moved, etc.) → treat the
   *     task as stale and return its ID so the caller can purge it from state.
   *
   * Returns the list of stale task IDs that could not be reconciled.
   * The caller is responsible for removing them from RoboticsProjectStore.
   */
  async reconcileWorktrees(gitState: RoboticsGitState): Promise<string[]> {
    return this._withGitMutationLock(async () => {
      const staleTaskIds: string[] = []
      for (const [taskId, branchName] of Object.entries(gitState.subAgentBranches)) {
        const worktreePath = join(this.worktreeBaseDir, taskId)
        try {
          await stat(worktreePath)
          await this._gitIn(worktreePath, ['status'])
          // Healthy — nothing to do
        } catch {
          // Worktree missing — try to restore
          const restored = await this._git(['worktree', 'add', worktreePath, branchName])
            .then(() => true)
            .catch(() => false)
          if (!restored) {
            // Cannot restore — mark stale for cleanup
            staleTaskIds.push(taskId)
          }
        }
      }
      return staleTaskIds
    })
  }

  private async _git(args: string[]): Promise<string> {
    return this._gitIn(this.projectDir, args)
  }

  private async _gitIn(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd })
    return stdout
  }

  private async _worktreeExists(path: string): Promise<boolean> {
    try { await stat(path); return true } catch { return false }
  }

  private _withGitMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._gitMutationChain.then(fn, fn)
    this._gitMutationChain = run.then(() => undefined, () => undefined)
    return run
  }
}
