import { createHash } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import { readdir, rm } from 'fs/promises';
import { atomicWriteJson, readJsonFile } from '../../core/persist/index.js';
const PROJECTS_ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'projects');
const RESUME_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — hard cap for resume
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days  — auto-purge for non-starred
const MAX_PROGRESS_NOTES = 15; // rolling window, oldest evicted first
// ── Path helpers ──────────────────────────────────────────────────────────────
//
// Storage layout:
//   <PROJECTS_ROOT>/<sha1(projectDir)>/<sessionId>/state.json
//
// One state file per (project, session) pair.  Different sessions for the same
// project never share progress notes — each session's R5 is fully isolated.
// The bucket dir groups sessions by project for listAll() and purgeStale().
function projectHash(projectDir) {
    return createHash('sha1').update(projectDir).digest('hex').slice(0, 16);
}
function projectBucketDir(dir) {
    return join(PROJECTS_ROOT, projectHash(dir));
}
function stateFile(dir, sessionId) {
    return join(projectBucketDir(dir), sessionId, 'state.json');
}
// ── RoboticsProjectStore ──────────────────────────────────────────────────────
export class RoboticsProjectStore {
    // ── Read ────────────────────────────────────────────────────────────────────
    /**
     * Find the most recent valid session state for a project directory.
     *
     * Enumerates all session subdirs under the project bucket and returns the
     * one with the highest lastActiveAt that is still within the 30-day resume
     * window.  Used by the --resume flow when no specific sessionId is known.
     */
    static async findLatestByProjectDir(dir) {
        const bucket = projectBucketDir(dir);
        let sessionDirs;
        try {
            sessionDirs = await readdir(bucket);
        }
        catch {
            return null;
        }
        const states = await Promise.all(sessionDirs.map(async (sid) => {
            const state = await readJsonFile(join(bucket, sid, 'state.json'));
            if (!state || state.schemaVersion !== '1.0')
                return null;
            if (Date.now() - state.lastActiveAt > RESUME_WINDOW_MS)
                return null;
            return state;
        }));
        const valid = states.filter(Boolean)
            .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
        return valid[0] ?? null;
    }
    /**
     * Find a specific session's state by (projectDir, sessionId).
     *
     * Used by all mutation methods to load-modify-save atomically, and by
     * RoboticsSession.init() on exact-match resume (e.g. session picker).
     */
    static async findBySession(dir, sessionId) {
        const state = await readJsonFile(stateFile(dir, sessionId));
        if (!state || state.schemaVersion !== '1.0')
            return null;
        if (Date.now() - state.lastActiveAt > RESUME_WINDOW_MS)
            return null;
        return state;
    }
    // ── Write ───────────────────────────────────────────────────────────────────
    /** Atomically persist state.  Path is derived from state.projectDir + state.sessionId. */
    static async save(state) {
        await atomicWriteJson(stateFile(state.projectDir, state.sessionId), state);
    }
    /** Update lastActiveAt for an active session (heartbeat). */
    static async touch(projectDir, sessionId) {
        const state = await RoboticsProjectStore.findBySession(projectDir, sessionId);
        if (state) {
            state.lastActiveAt = Date.now();
            await RoboticsProjectStore.save(state);
        }
    }
    /**
     * Append a progress note to the session's rolling buffer.
     *
     * Buffer is capped at MAX_PROGRESS_NOTES (15).  When the cap is exceeded the
     * oldest entries are evicted so the most recent context is always visible in R5.
     */
    static async appendProgress(projectDir, sessionId, note) {
        const state = await RoboticsProjectStore.findBySession(projectDir, sessionId);
        if (!state)
            return;
        state.progressNotes.push(`[${new Date().toISOString().slice(0, 16)}] ${note}`);
        if (state.progressNotes.length > MAX_PROGRESS_NOTES) {
            state.progressNotes = state.progressNotes.slice(-MAX_PROGRESS_NOTES);
        }
        await RoboticsProjectStore.save(state);
    }
    static async registerSubAgentTask(dir, sessionId, record) {
        const state = await RoboticsProjectStore.findBySession(dir, sessionId);
        if (!state)
            return;
        state.activeSubAgentTasks = state.activeSubAgentTasks.filter(t => t.taskId !== record.taskId);
        state.activeSubAgentTasks.push(record);
        await RoboticsProjectStore.save(state);
    }
    static async completeSubAgentTask(dir, sessionId, taskId) {
        const state = await RoboticsProjectStore.findBySession(dir, sessionId);
        if (!state)
            return;
        state.activeSubAgentTasks = state.activeSubAgentTasks.filter(t => t.taskId !== taskId);
        if (!state.completedSubAgentTaskIds.includes(taskId)) {
            state.completedSubAgentTaskIds.push(taskId);
        }
        await RoboticsProjectStore.save(state);
    }
    /**
     * Remove a stale sub-agent task that could not be reconciled on session resume.
     * Clears the task from activeSubAgentTasks, subAgentBranches, and forkPoints.
     * Does NOT add to completedSubAgentTaskIds — stale tasks were never finished.
     */
    static async purgeStaleSubAgentTask(dir, sessionId, taskId) {
        const state = await RoboticsProjectStore.findBySession(dir, sessionId);
        if (!state)
            return;
        state.activeSubAgentTasks = state.activeSubAgentTasks.filter(t => t.taskId !== taskId);
        delete state.git.subAgentBranches[taskId];
        delete state.git.forkPoints[taskId];
        await RoboticsProjectStore.save(state);
    }
    static async updateGitState(dir, sessionId, git) {
        const state = await RoboticsProjectStore.findBySession(dir, sessionId);
        if (!state)
            return;
        state.git = {
            ...state.git,
            ...git,
            subAgentBranches: { ...state.git.subAgentBranches, ...(git.subAgentBranches ?? {}) },
            forkPoints: { ...state.git.forkPoints, ...(git.forkPoints ?? {}) },
        };
        await RoboticsProjectStore.save(state);
    }
    // ── Session management ───────────────────────────────────────────────────────
    /**
     * List all persisted sessions across all projects, sorted by lastActiveAt
     * descending (most recent first).
     *
     * Enumerates two levels: <bucket>/<sessionId>/state.json
     */
    static async listAll() {
        let buckets;
        try {
            buckets = await readdir(PROJECTS_ROOT);
        }
        catch {
            return [];
        }
        const results = [];
        await Promise.all(buckets.map(async (bucket) => {
            const bucketPath = join(PROJECTS_ROOT, bucket);
            let sessionDirs;
            try {
                sessionDirs = await readdir(bucketPath);
            }
            catch {
                return;
            }
            await Promise.all(sessionDirs.map(async (sid) => {
                const state = await readJsonFile(join(bucketPath, sid, 'state.json'));
                if (!state || state.schemaVersion !== '1.0')
                    return;
                const idleDays = Math.floor((Date.now() - state.lastActiveAt) / 86_400_000);
                results.push({
                    projectDir: state.projectDir,
                    sessionId: state.sessionId,
                    robot: state.robot,
                    createdAt: state.createdAt,
                    lastActiveAt: state.lastActiveAt,
                    starred: state.starred ?? false,
                    tags: state.tags ?? [],
                    currentPhase: state.currentPhase,
                    agentMode: state.agentMode,
                    idleDays,
                });
            }));
        }));
        return results.filter(Boolean)
            .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    }
    /**
     * Set or clear the star flag for a specific session.
     * Starred sessions are exempt from 7-day auto-purge.
     */
    static async star(projectDir, sessionId, starred) {
        const state = await RoboticsProjectStore.findBySession(projectDir, sessionId);
        if (!state)
            return;
        state.starred = starred;
        await RoboticsProjectStore.save(state);
    }
    /**
     * Replace the tag list for a specific session.
     * Pass an empty array to clear all tags.
     */
    static async setTags(projectDir, sessionId, tags) {
        const state = await RoboticsProjectStore.findBySession(projectDir, sessionId);
        if (!state)
            return;
        state.tags = tags;
        await RoboticsProjectStore.save(state);
    }
    /**
     * Delete session dirs that are not starred and have been idle for more than
     * STALE_TTL_MS (7 days).  Operates on individual session dirs — the project
     * bucket may become empty but is left in place (harmless, cleaned on next purge).
     *
     * @returns Number of session dirs purged.
     */
    static async purgeStale() {
        let buckets;
        try {
            buckets = await readdir(PROJECTS_ROOT);
        }
        catch {
            return 0;
        }
        const now = Date.now();
        let purged = 0;
        await Promise.allSettled(buckets.map(async (bucket) => {
            const bucketPath = join(PROJECTS_ROOT, bucket);
            let sessionDirs;
            try {
                sessionDirs = await readdir(bucketPath);
            }
            catch {
                return;
            }
            await Promise.allSettled(sessionDirs.map(async (sid) => {
                const sessionDir = join(bucketPath, sid);
                const state = await readJsonFile(join(sessionDir, 'state.json'));
                if (!state || state.schemaVersion !== '1.0')
                    return;
                if (state.starred)
                    return; // ← starred: exempt
                if (now - state.lastActiveAt < STALE_TTL_MS)
                    return; // ← active within 7 days
                await rm(sessionDir, { recursive: true, force: true });
                purged++;
            }));
        }));
        return purged;
    }
}
//# sourceMappingURL=RoboticsProjectStore.js.map