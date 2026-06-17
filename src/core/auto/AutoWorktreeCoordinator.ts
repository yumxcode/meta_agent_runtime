/**
 * AutoWorktreeCoordinator — concurrent-write isolation for auto-mode sub-agents.
 *
 * When several writing sub-agents run in parallel against one workspace, direct
 * shared-tree writes race and corrupt files. This coordinator gives each task
 * its own git worktree + branch to work in; the main agent then merges branches
 * back SERIALLY (GitWorkspaceManager serialises every git mutation through an
 * internal lock, so merges/creates never interleave). Conflicts surface at merge
 * time and can be discarded.
 *
 * It is a thin, auto-specific facade over the existing robotics GitWorkspaceManager
 * (reused, not forked) with its own worktree base under the project's
 * `.meta-agent/auto/worktrees`. No-ops gracefully when the workspace is not a git
 * repo (enabled === false), so callers can always attempt allocation.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, resolve } from 'path'
import { GitWorkspaceManager } from '../../robotics/git/GitWorkspaceManager.js'
import type { SubAgentTaskId } from '../../subagent/types.js'

const execFileAsync = promisify(execFile)

export interface AutoWorktreeHandle {
  taskId: string
  worktreePath: string
  branchName: string
}

export interface AutoMergeResult {
  merged: boolean
  commitHash: string
}

export class AutoWorktreeCoordinator {
  private readonly gwm: GitWorkspaceManager
  private readonly projectDir: string
  /** taskId → { branch, forkPoint } for tasks with a live worktree. */
  private readonly branches = new Map<string, { branchName: string; forkPoint: string }>()

  constructor(projectDir: string) {
    this.projectDir = resolve(projectDir)
    const base = join(this.projectDir, '.meta-agent', 'auto', 'worktrees')
    this.gwm = new GitWorkspaceManager(projectDir, base)
  }

  /** True when the workspace is a git repo (worktrees are possible). */
  get enabled(): boolean {
    return this.gwm.enabled
  }

  /** taskIds with a live worktree. */
  activeTasks(): string[] {
    return [...this.branches.keys()]
  }

  branchFor(taskId: string): string | undefined {
    return this.branches.get(taskId)?.branchName
  }

  /**
   * Allocate an isolated worktree+branch for `taskId`. Returns null when the
   * workspace is not a git repo (caller then falls back to shared-tree writes).
   */
  async allocate(taskId: SubAgentTaskId): Promise<AutoWorktreeHandle | null> {
    if (!this.enabled) return null
    // role is only a branch-name component; 'code' is a valid generic worker role.
    const rec = await this.gwm.createWorktreeForTask(taskId, 'code')
    this.branches.set(taskId, { branchName: rec.branchName, forkPoint: rec.forkPoint })
    return { taskId, worktreePath: rec.worktreePath, branchName: rec.branchName }
  }

  /**
   * Merge a task's branch back into main. Serialised by GitWorkspaceManager's
   * internal mutation lock. Returns null when the task has no tracked worktree.
   */
  async merge(
    taskId: SubAgentTaskId,
    opts?: { strategy?: 'squash' | 'merge'; message?: string },
  ): Promise<AutoMergeResult | null> {
    const entry = this.branches.get(taskId)
    if (!entry) return null
    return this.gwm.mergeTaskBranch(taskId, entry.branchName, {
      strategy: opts?.strategy ?? 'squash',
      message: opts?.message,
    })
  }

  /**
   * Diff (stat) of a task branch's changes since it forked from main.
   * Uses the recorded fork point so the comparison is exact regardless of how
   * far main has advanced in the meantime.
   */
  async diff(taskId: SubAgentTaskId): Promise<string> {
    const entry = this.branches.get(taskId)
    if (!entry) return `No worktree for task ${taskId}`
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', this.projectDir, 'diff', '--stat', `${entry.forkPoint}..${entry.branchName}`],
        { maxBuffer: 10 * 1024 * 1024 },
      )
      return stdout.trim() || '(no changes)'
    } catch (err) {
      return `Could not compute diff: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  /** Drop a task's worktree and branch (e.g. on conflict or abandonment). */
  async discard(taskId: SubAgentTaskId): Promise<void> {
    const entry = this.branches.get(taskId)
    await this.gwm.removeWorktree(taskId, { deleteBranch: true, branchName: entry?.branchName }).catch(() => undefined)
    this.branches.delete(taskId)
  }

  /**
   * Discard every still-tracked worktree+branch. Called on session teardown so
   * worktrees the main agent never merged/discarded (e.g. a sub-agent that
   * failed, or a run that ended mid-flight) don't leak under
   * `.meta-agent/auto/worktrees`. Best-effort: each removal swallows its own
   * error, and one failure never blocks the rest.
   */
  async cleanupAll(): Promise<void> {
    const taskIds = [...this.branches.keys()]
    await Promise.allSettled(taskIds.map(id => this.discard(id)))
  }
}
