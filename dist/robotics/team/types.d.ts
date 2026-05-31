/**
 * Public type definitions for team mode (v2.0).
 *
 * Three entities, no modules / no paths / no decisions:
 *   - TeamUnit:    a participant
 *   - TeamTask:    something someone is doing
 *   - TeamAttempt: an append-only entry: direction + outcome + ref
 *
 * Re-exported from TeamStore.ts so the existing
 *   import { ... } from './team/TeamStore.js'
 * imports continue to resolve.
 */
export type TeamTaskStatus = 'open' | 'paused' | 'done';
/** ms threshold for "claim has gone stale" board warnings (7 days). */
export declare const STALE_CLAIM_MS: number;
export interface TeamAttempt {
    at: string;
    unit: string;
    direction: string;
    outcome: string;
    ref?: string;
}
export interface TeamTask {
    id: string;
    title: string;
    status: TeamTaskStatus;
    /** Non-empty = locked; only owner can note/drop/done. */
    ownerUnit?: string;
    /** ISO of claim time — drives stale-claim visual warnings on the board. */
    claimedAt?: string;
    /** Append-only attempts log: directions tried + outcomes. */
    attempts: TeamAttempt[];
    updatedAt: string;
}
export interface TeamUnit {
    id: string;
    human?: string;
    machine: string;
    status: 'active' | 'away';
    currentTask?: string;
    lastSeen: string;
}
export interface TeamState {
    schemaVersion: '2.0';
    project: string;
    github?: string;
    goals: string[];
    tasks: TeamTask[];
    units: TeamUnit[];
    updatedAt: string;
}
export declare const VALID_TASK_STATUSES: TeamTaskStatus[];
/** A task is active when someone owns it AND it's not done. */
export declare function isActiveTask(task: Pick<TeamTask, 'status' | 'ownerUnit'>): boolean;
/** Returns true when the claim is older than STALE_CLAIM_MS. */
export declare function isStaleClaim(task: Pick<TeamTask, 'claimedAt' | 'status'>): boolean;
//# sourceMappingURL=types.d.ts.map