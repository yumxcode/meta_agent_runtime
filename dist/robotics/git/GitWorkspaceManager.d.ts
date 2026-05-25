import type { RoboticsAgentRole, RoboticsGitState } from '../types.js';
import type { SubAgentTaskId } from '../../subagent/types.js';
export interface GitWorktreeRecord {
    taskId: SubAgentTaskId;
    role: RoboticsAgentRole;
    branchName: string;
    worktreePath: string;
    forkPoint: string;
    createdAt: number;
}
export interface GitSyncResult {
    branchName: string;
    commitsAhead: number;
    commitsBehind: number;
    hasConflicts: boolean;
}
export declare class GitWorkspaceManager {
    private readonly projectDir;
    private readonly worktreeBaseDir;
    private _gitMutationChain;
    constructor(projectDir: string, worktreeBaseDir?: string);
    get enabled(): boolean;
    detectGitState(): Promise<RoboticsGitState>;
    createWorktreeForTask(taskId: SubAgentTaskId, role: RoboticsAgentRole): Promise<GitWorktreeRecord>;
    syncMainToTask(taskId: SubAgentTaskId, branchName: string): Promise<GitSyncResult>;
    mergeTaskBranch(taskId: SubAgentTaskId, branchName: string, opts: {
        strategy: 'squash' | 'merge' | 'cherry-pick';
        message?: string;
        commitHashes?: string[];
    }): Promise<{
        merged: boolean;
        commitHash: string;
    }>;
    getTaskDiff(taskId: SubAgentTaskId, branchName: string): Promise<string>;
    getTaskBranchStatus(taskId: SubAgentTaskId, branchName: string): Promise<{
        commitsAhead: number;
        commitsBehind: number;
        lastCommitMessage: string;
        lastCommitAt: number;
    }>;
    removeWorktree(taskId: SubAgentTaskId, opts?: {
        deleteBranch?: boolean;
        branchName?: string;
    }): Promise<void>;
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
    removeWorktreeWithOutcome(taskId: SubAgentTaskId, outcome: 'success' | 'failure', opts?: {
        branchName?: string;
        deleteBranchOnSuccess?: boolean;
    }): Promise<void>;
    /**
     * Prune worktrees whose directory mtime is older than `ttlMs` milliseconds.
     *
     * Cleans up worktrees left on disk after a successful sub-agent run when the
     * caller did not explicitly call `removeWorktree()` (e.g. after a crash or
     * process restart).  Safe to call concurrently — runs inside the mutation lock.
     *
     * Returns the list of task IDs (directory names) that were pruned.
     */
    pruneStaleWorktrees(ttlMs: number): Promise<string[]>;
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
    reconcileWorktrees(gitState: RoboticsGitState): Promise<string[]>;
    private _git;
    private _gitIn;
    private _worktreeExists;
    private _withGitMutationLock;
}
//# sourceMappingURL=GitWorkspaceManager.d.ts.map