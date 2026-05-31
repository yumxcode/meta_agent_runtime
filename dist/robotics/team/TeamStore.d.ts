/**
 * TeamStore (v2.0) — shared lab notebook persistence.
 *
 * Three entities (see types.ts): unit, task, attempt.  All mutations land in
 * `team/team.json` atomically; derived markdown views (board.md, log.md,
 * goals.md, README.md) are regenerated from team.json on every write.
 *
 * Concurrency model:
 *   - team.json is the only source of truth.
 *   - Writes use optimistic concurrency: the caller's `updatedAt` snapshot
 *     is re-checked against disk just before write; mismatch → throw and
 *     the caller retries.
 *   - attempts[] is append-only inside note() — concurrent notes from
 *     different units race on the same JSON file, but conflicts are rare
 *     and the retry is cheap.
 *
 * Exclusive ownership:
 *   - `task.ownerUnit` is the lock.  take() refuses to override an existing
 *     owner; steal() is the explicit escape hatch (records an audit attempt).
 */
import { STALE_CLAIM_MS, VALID_TASK_STATUSES, isActiveTask, isStaleClaim, type TeamAttempt, type TeamState, type TeamTask, type TeamTaskStatus, type TeamUnit } from './types.js';
export { STALE_CLAIM_MS, VALID_TASK_STATUSES, isActiveTask, isStaleClaim, type TeamAttempt, type TeamState, type TeamTask, type TeamTaskStatus, type TeamUnit, };
export interface TeamTaskAddInput {
    id: string;
    title: string;
}
export interface TeamSyncOptions {
    fetch?: boolean;
    updatePresence?: boolean;
    forceFetch?: boolean;
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
export interface TeamPullResult {
    applied: boolean;
    reason?: string;
    upstreamBranch?: string;
    changedFiles: string[];
    sync: TeamSyncSummary;
    state: TeamState | null;
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
    guidance: string[];
}
export interface TeamJsonResolveResult {
    resolved: boolean;
    strategy: 'theirs' | 'none' | 'failed';
    message: string;
}
export interface TeamNoteInput {
    taskId: string;
    direction: string;
    outcome: string;
    ref?: string;
}
export declare class TeamStore {
    private readonly projectDir;
    readonly unitId: string;
    private _lastFetchAt;
    constructor(projectDir: string, unitId?: string);
    get teamDir(): string;
    get statePath(): string;
    msSinceLastFetch(): number;
    /** Returns true when team.json exists for this project. */
    exists(): Promise<boolean>;
    status(): Promise<TeamState | null>;
    init(github?: string): Promise<TeamState>;
    join(github?: string, human?: string): Promise<TeamState>;
    addTask(input: TeamTaskAddInput): Promise<{
        state: TeamState;
        task: TeamTask;
    }>;
    /**
     * Exclusively claim a task.  Fails fast if another unit already owns it.
     * Re-taking your own claim is a no-op (returns the same task).
     */
    take(taskId: string): Promise<{
        state: TeamState;
        task: TeamTask;
    }>;
    /**
     * Release a task.  Only the current owner can drop.  Sets ownerUnit=null
     * and clears the recorded claimedAt.
     */
    drop(taskId?: string): Promise<{
        state: TeamState;
        task: TeamTask;
    }>;
    /**
     * Forcibly take a task already owned by someone else.  Writes an audit
     * entry to attempts[] so the prior owner can see why.
     */
    steal(taskId: string, reason?: string): Promise<{
        state: TeamState;
        task: TeamTask;
        previousOwner?: string;
    }>;
    /**
     * Append a single attempt entry to a task's log.  Only the owner can
     * record attempts (forces "if you want to write here, take it first").
     */
    note(input: TeamNoteInput): Promise<{
        state: TeamState;
        task: TeamTask;
        attempt: TeamAttempt;
    }>;
    /**
     * Transition a task's status (open ⇄ paused, or → done).
     * Only the owner can change status; clears ownership when marking done.
     */
    updateTaskStatus(taskId: string, status: TeamTaskStatus): Promise<{
        state: TeamState;
        task: TeamTask;
    }>;
    sync(options?: TeamSyncOptions): Promise<TeamSyncSummary>;
    pullRemoteTeam(): Promise<TeamPullResult>;
    detectMergeConflicts(): Promise<MergeConflictReport>;
    resolveTeamJsonConflict(): Promise<TeamJsonResolveResult>;
    formatPromptContext(): Promise<string | null>;
    private formatOwnedError;
    private requireTask;
    private ensure;
    private read;
    private localTeamChanges;
    private ensureUnit;
    /**
     * Atomically write team.json with an optional optimistic-concurrency check,
     * then regenerate the derived markdown views.
     */
    private writeAll;
}
//# sourceMappingURL=TeamStore.d.ts.map