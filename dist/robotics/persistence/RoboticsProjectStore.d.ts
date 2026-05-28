import type { RoboticsProjectState, RoboticsProjectSummary, ActiveSubAgentRecord, RoboticsGitState } from '../types.js';
export declare class RoboticsProjectStore {
    /**
     * Find the most recent valid session state for a project directory.
     *
     * Enumerates all session subdirs under the project bucket and returns the
     * one with the highest lastActiveAt that is still within the 30-day resume
     * window.  Used by the --resume flow when no specific sessionId is known.
     */
    static findLatestByProjectDir(dir: string): Promise<RoboticsProjectState | null>;
    /**
     * Find a specific session's state by (projectDir, sessionId).
     *
     * Used by all mutation methods to load-modify-save atomically, and by
     * RoboticsSession.init() on exact-match resume (e.g. session picker).
     */
    static findBySession(dir: string, sessionId: string): Promise<RoboticsProjectState | null>;
    /** Atomically persist state.  Path is derived from state.projectDir + state.sessionId. */
    static save(state: RoboticsProjectState): Promise<void>;
    /** Update lastActiveAt for an active session (heartbeat). */
    static touch(projectDir: string, sessionId: string): Promise<void>;
    /**
     * Append a progress note to the session's rolling buffer.
     *
     * Buffer is capped at MAX_PROGRESS_NOTES (15).  When the cap is exceeded the
     * oldest entries are evicted so the most recent context is always visible in R5.
     */
    static appendProgress(projectDir: string, sessionId: string, note: string): Promise<void>;
    static registerSubAgentTask(dir: string, sessionId: string, record: ActiveSubAgentRecord): Promise<void>;
    static completeSubAgentTask(dir: string, sessionId: string, taskId: string): Promise<void>;
    /**
     * Remove a stale sub-agent task that could not be reconciled on session resume.
     * Clears the task from activeSubAgentTasks, subAgentBranches, and forkPoints.
     * Does NOT add to completedSubAgentTaskIds — stale tasks were never finished.
     */
    static purgeStaleSubAgentTask(dir: string, sessionId: string, taskId: string): Promise<void>;
    static updateGitState(dir: string, sessionId: string, git: Partial<RoboticsGitState>): Promise<void>;
    /**
     * List all persisted sessions across all projects, sorted by lastActiveAt
     * descending (most recent first).
     *
     * Enumerates two levels: <bucket>/<sessionId>/state.json
     */
    static listAll(): Promise<RoboticsProjectSummary[]>;
    /**
     * Set or clear the star flag for a specific session.
     * Starred sessions are exempt from 7-day auto-purge.
     */
    static star(projectDir: string, sessionId: string, starred: boolean): Promise<void>;
    /**
     * Replace the tag list for a specific session.
     * Pass an empty array to clear all tags.
     */
    static setTags(projectDir: string, sessionId: string, tags: string[]): Promise<void>;
    /**
     * Delete session dirs that are not starred and have been idle for more than
     * STALE_TTL_MS (7 days).  Operates on individual session dirs — the project
     * bucket may become empty but is left in place (harmless, cleaned on next purge).
     *
     * @returns Number of session dirs purged.
     */
    static purgeStale(): Promise<number>;
}
//# sourceMappingURL=RoboticsProjectStore.d.ts.map