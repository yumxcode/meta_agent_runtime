/**
 * JobStore — persists EngineeringJob records to disk.
 *
 * Storage path: ~/.meta-agent/jobs/{sessionId}/{jobId}.json
 *
 * Each job is a single JSON file written atomically via core/persist utilities
 * (write to a .tmp file, then rename) so a crash mid-write never leaves
 * a corrupted record.
 */
import { join } from 'path';
import { homedir } from 'os';
import { atomicWriteJson, readJsonFile, listJsonIds, deleteJsonFile } from '../core/persist/index.js';
// ─────────────────────────────────────────────────────────────────────────────
function jobsRoot() {
    return join(homedir(), '.meta-agent', 'jobs');
}
function sessionDir(sessionId) {
    return join(jobsRoot(), sessionId);
}
function jobPath(sessionId, jobId) {
    return join(sessionDir(sessionId), `${jobId}.json`);
}
// ─────────────────────────────────────────────────────────────────────────────
export class JobStore {
    sessionId;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
    /**
     * Persist (create or overwrite) a job record atomically.
     */
    async save(job) {
        await atomicWriteJson(jobPath(this.sessionId, job.jobId), job);
    }
    /**
     * Load a single job by ID. Returns null if not found.
     */
    async load(jobId) {
        return readJsonFile(jobPath(this.sessionId, jobId));
    }
    /**
     * Load all jobs for this session. Skips corrupt or unreadable files.
     */
    async loadAll() {
        const dir = sessionDir(this.sessionId);
        const ids = await listJsonIds(dir);
        const results = await Promise.allSettled(ids.map(id => readJsonFile(jobPath(this.sessionId, id))));
        return results
            .filter((r) => r.status === 'fulfilled')
            .map(r => r.value)
            .filter((j) => j !== null);
    }
    /**
     * Delete a job record from disk. No-op if not found.
     */
    async delete(jobId) {
        await deleteJsonFile(jobPath(this.sessionId, jobId));
    }
    /** Convenience: check if a job exists on disk. */
    async exists(jobId) {
        return (await this.load(jobId)) !== null;
    }
}
//# sourceMappingURL=JobStore.js.map