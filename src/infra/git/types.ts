/**
 * Neutral git-worktree types.
 *
 * GitWorkspaceManager is general-purpose infrastructure (used by both robotics
 * multi-agent orchestration and auto-mode isolated writes), so it lives under
 * `infra/` and depends on these mode-agnostic types instead of robotics ones.
 * `robotics/types.ts` re-exports `GitWorkspaceState` as `RoboticsGitState` for
 * backward compatibility. See architecture-review-2026-06-18.md §1.2.
 */

/**
 * Role label for a task worktree/branch. Free-form string at this layer; each
 * mode supplies its own role vocabulary (robotics uses RoboticsAgentRole,
 * auto uses 'code'). Kept as a plain string so infra stays mode-agnostic.
 */
export type WorktreeRole = string

/** Snapshot of the workspace's git worktree/branch state. */
export interface GitWorkspaceState {
  enabled: boolean
  mainBranch: string
  subAgentBranches: Record<string, string>   // taskId → branchName
  forkPoints: Record<string, string>          // taskId → commitHash
}
