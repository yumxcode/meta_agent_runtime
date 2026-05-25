import type { RoboticsProjectState, RoboticsProjectSummary, ActiveSubAgentRecord, RoboticsGitState } from '../types.js';
export declare class RoboticsProjectStore {
    static findByProjectDir(dir: string): Promise<RoboticsProjectState | null>;
    static save(state: RoboticsProjectState): Promise<void>;
    static touch(projectDir: string): Promise<void>;
    static appendProgress(projectDir: string, note: string): Promise<void>;
    static registerSubAgentTask(dir: string, record: ActiveSubAgentRecord): Promise<void>;
    static completeSubAgentTask(dir: string, taskId: string): Promise<void>;
    /**
     * Remove a stale sub-agent task that could not be reconciled on session resume.
     * Clears the task from activeSubAgentTasks, subAgentBranches, and forkPoints.
     * Does NOT add to completedSubAgentTaskIds — stale tasks were never finished.
     */
    static purgeStaleSubAgentTask(dir: string, taskId: string): Promise<void>;
    static updateGitState(dir: string, git: Partial<RoboticsGitState>): Promise<void>;
    /**
     * List all persisted sessions, sorted by lastActiveAt descending (most recent first).
     * Reads every bucket under PROJECTS_ROOT; silently skips corrupt entries.
     */
    static listAll(): Promise<RoboticsProjectSummary[]>;
    /**
     * Set or clear the star flag for a session.
     * Starred sessions are exempt from 7-day auto-purge.
     */
    static star(projectDir: string, starred: boolean): Promise<void>;
    /**
     * Replace the tag list for a session.
     * Pass an empty array to clear all tags.
     */
    static setTags(projectDir: string, tags: string[]): Promise<void>;
    /**
     * Delete sessions that are not starred and have been idle for more than
     * STALE_TTL_MS (7 days).  Safe to call at startup — reads all buckets,
     * skips starred or recently-active ones, removes the rest.
     *
     * @returns Number of sessions purged.
     */
    static purgeStale(): Promise<number>;
}
//# sourceMappingURL=RoboticsProjectStore.d.ts.map