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
}
//# sourceMappingURL=GitWorkspaceManager.d.ts.map