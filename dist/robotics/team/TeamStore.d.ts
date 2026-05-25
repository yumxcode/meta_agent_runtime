export type TeamTaskStatus = 'backlog' | 'claimed' | 'in_progress' | 'blocked' | 'review' | 'done' | 'paused' | 'handoff' | 'cancelled';
export interface TeamTask {
    id: string;
    title: string;
    status: TeamTaskStatus;
    module?: string;
    ownerUnit?: string;
    branch?: string;
    githubIssueNumber?: number;
    githubIssueUrl?: string;
    paths: string[];
    updatedAt: string;
}
export interface TeamUnit {
    id: string;
    human?: string;
    machine: string;
    status: 'active' | 'idle' | 'offline';
    currentTask?: string;
    lastSeen: string;
}
export interface TeamModule {
    name: string;
    ownerUnit?: string;
    paths: string[];
    responsibilities: string[];
}
export interface TeamState {
    schemaVersion: '1.0';
    project: string;
    github?: string;
    goals: string[];
    modules: TeamModule[];
    tasks: TeamTask[];
    units: TeamUnit[];
    decisions: string[];
    updatedAt: string;
}
export interface TeamSyncSummary {
    gitFetched: boolean;
    currentBranch?: string;
    upstreamBranch?: string;
    ahead?: number;
    behind?: number;
    remoteSummary?: string;
    remoteTeamChanges: string[];
    state: TeamState | null;
}
export interface TeamSyncOptions {
    fetch?: boolean;
    updatePresence?: boolean;
    writeActivity?: boolean;
}
export interface TeamPullResult {
    applied: boolean;
    reason?: string;
    upstreamBranch?: string;
    changedFiles: string[];
    sync: TeamSyncSummary;
    state: TeamState | null;
}
export interface TeamTaskAddInput {
    id: string;
    title: string;
    module?: string;
    paths?: string[];
}
export interface TeamModuleAddInput {
    name: string;
    paths: string[];
    responsibilities?: string[];
    ownerUnit?: string;
}
export interface TeamConflictIssue {
    severity: 'warning' | 'error';
    kind: 'task_overlap' | 'module_owner' | 'task_scope' | 'no_current_task';
    message: string;
    path?: string;
    taskId?: string;
    module?: string;
    ownerUnit?: string;
}
export interface TeamConflictReport {
    unitId: string;
    currentTask?: TeamTask;
    changedFiles: string[];
    issues: TeamConflictIssue[];
}
export interface TeamBranchResult {
    state: TeamState;
    task: TeamTask;
    branch: string;
    previousBranch?: string;
    created: boolean;
}
export interface TeamPushResult {
    branch: string;
    upstream?: string;
    pushed: boolean;
    output: string;
}
export interface TeamPrDraftResult {
    task: TeamTask;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
    filePath: string;
}
export interface TeamHandoffResult {
    state: TeamState;
    task: TeamTask;
    filePath: string;
    content: string;
}
export interface TeamOnboardingSummary {
    project: string;
    github?: string;
    goals: string[];
    activeUnits: TeamUnit[];
    modules: TeamModule[];
    recommendedTasks: TeamTask[];
    activeTasks: TeamTask[];
}
export interface MergeConflict {
    path: string;
    isTeamFile: boolean;
    isTeamJson: boolean;
}
export interface MergeConflictReport {
    hasConflicts: boolean;
    conflicts: MergeConflict[];
    teamJsonConflicted: boolean;
    /** Step-by-step guidance lines ready to print to the user. */
    guidance: string[];
}
export interface TeamJsonResolveResult {
    resolved: boolean;
    strategy: 'theirs' | 'none' | 'failed';
    message: string;
}
export interface TeamGitHubIssueSyncResult {
    taskId: string;
    issueNumber?: number;
    issueUrl?: string;
    action: 'created' | 'updated' | 'skipped';
    message?: string;
}
export interface TeamGitHubProjectResult {
    projectNumber: string;
    owner: string;
    added: Array<{
        taskId: string;
        issueUrl: string;
        output: string;
    }>;
    skipped: Array<{
        taskId: string;
        reason: string;
    }>;
}
/**
 * Single authoritative definition of "active" for a team task.
 *
 * Used consistently across TeamStore, dynamicSection, and CLI formatTeamState
 * so that prompt context, onboarding summary, and the board all agree.
 *
 * Active = the task is in progress or reserved and NOT yet done/cancelled/handoff.
 */
export declare function isActiveTask(task: TeamTask): boolean;
export declare class TeamStore {
    private readonly projectDir;
    readonly unitId: string;
    constructor(projectDir: string, unitId?: string);
    get teamDir(): string;
    get statePath(): string;
    init(github?: string): Promise<TeamState>;
    join(github?: string, human?: string): Promise<TeamState>;
    claim(taskId: string): Promise<{
        state: TeamState;
        task: TeamTask;
        warnings: string[];
    }>;
    /**
     * Transition a task from `claimed` (or `backlog`) → `in_progress`.
     * Call this when the unit actually begins making changes to the codebase,
     * as opposed to `claim()` which merely reserves the task.
     */
    startTask(taskId?: string): Promise<{
        state: TeamState;
        task: TeamTask;
    }>;
    addTask(input: TeamTaskAddInput): Promise<{
        state: TeamState;
        task: TeamTask;
    }>;
    updateTaskStatus(taskId: string, status: TeamTaskStatus): Promise<{
        state: TeamState;
        task: TeamTask;
    }>;
    checkWorkspaceConflicts(): Promise<TeamConflictReport>;
    checkPathsConflicts(paths: string[]): Promise<TeamConflictReport>;
    /**
     * Return the files actually changed on `task.branch` relative to the base branch.
     *
     * Uses `git diff --name-only <base>...<branch>` which includes all commits
     * reachable from branch but not from base.  Falls back to an empty list when
     * the branch doesn't exist locally, git isn't available, or the task has no
     * recorded branch.
     */
    actualChangedFilesForTask(task: TeamTask): Promise<string[]>;
    branchForTask(taskId?: string): Promise<TeamBranchResult>;
    pushCurrentBranch(): Promise<TeamPushResult>;
    createPrDraft(taskId?: string): Promise<TeamPrDraftResult>;
    createHandoff(taskId?: string, note?: string): Promise<TeamHandoffResult>;
    /** Returns true when team.json exists for this project. */
    exists(): Promise<boolean>;
    onboardingSummary(): Promise<TeamOnboardingSummary>;
    syncGitHubIssues(taskId?: string): Promise<TeamGitHubIssueSyncResult[]>;
    addGitHubIssuesToProject(projectNumber: string, owner?: string): Promise<TeamGitHubProjectResult>;
    private checkPaths;
    addModule(input: TeamModuleAddInput): Promise<{
        state: TeamState;
        module: TeamModule;
    }>;
    setModuleOwner(name: string, ownerUnit?: string): Promise<{
        state: TeamState;
        module: TeamModule;
    }>;
    status(): Promise<TeamState | null>;
    sync(options?: TeamSyncOptions): Promise<TeamSyncSummary>;
    /**
     * Restore the `team/` directory from the upstream branch.
     *
     * ⚠️  After a successful pull the restored files are STAGED but NOT committed.
     * Always follow up with `git add team/ && git commit -m "chore: sync team state"`
     * (or the equivalent) to record the update on the current branch.
     */
    pullRemoteTeam(): Promise<TeamPullResult>;
    /**
     * Detect git merge conflicts in the working tree.
     *
     * Uses `git ls-files -u` which lists each unmerged (stage 1/2/3) entry.
     * Returns a structured report with categorised conflicts and step-by-step
     * guidance text ready to display in the REPL.
     */
    detectMergeConflicts(): Promise<MergeConflictReport>;
    /**
     * Auto-resolve a conflicted team.json by accepting the remote ("theirs") version.
     *
     * Since team/team.json is the shared source of truth, "theirs" (the remote's version)
     * is almost always the correct choice.  After applying, the file is staged so the
     * caller only needs to `git commit`.
     */
    resolveTeamJsonConflict(): Promise<TeamJsonResolveResult>;
    formatPromptContext(): Promise<string | null>;
    private ensure;
    private read;
    private localTeamChanges;
    /**
     * Persist team state atomically.
     *
     * Optimistic concurrency guard (P1-B): when `checkUpdatedAt` is provided the
     * current disk state is re-read immediately before writing.  If the on-disk
     * `updatedAt` differs from the expected value another process wrote between
     * our read and our write — we reject the write so the caller can retry.
     *
     * Only pass `checkUpdatedAt` for state-mutating operations (claim, start,
     * updateStatus, …).  Creation paths (init) leave it undefined.
     */
    private writeAll;
    private detectPathConflicts;
    /**
     * Async variant with actual-git-change awareness.
     *
     * Conflict detection strategy (per other task):
     *   1. If `actualFilesMap` contains real changed files for the other task AND
     *      we also have real changed files (`ourChangedFiles`): compare file sets
     *      directly.  This is the most precise check — only real overlaps fire.
     *   2. If only the other task has real files (we don't have ours, e.g. at claim
     *      time): check if any of the other task's actual files match our task.paths
     *      patterns.  More precise than pure pattern overlap.
     *   3. Fallback: pure pattern-to-pattern overlap (existing behaviour).
     */
    private detectTaskOverlapIssues;
    /** Synchronous pattern-only variant used at claim time before git data is available. */
    private detectTaskOverlapIssuesByPattern;
    private changedWorkspaceFiles;
    private ensureUnit;
    private resolveTaskForUnit;
    private makeBranchName;
    private currentGitBranch;
    private defaultBaseBranch;
    private changedFilesAgainst;
    private gitOne;
    private gitLines;
    private githubIssueBody;
    private githubRepo;
    private ensureGitHubLabels;
    private gh;
    private toRepoPath;
}
//# sourceMappingURL=TeamStore.d.ts.map