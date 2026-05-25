/**
 * JobStore — persists EngineeringJob records to disk.
 *
 * Storage path: ~/.meta-agent/jobs/{sessionId}/{jobId}.json
 *
 * Each job is a single JSON file written atomically via core/persist utilities
 * (write to a .tmp file, then rename) so a crash mid-write never leaves
 * a corrupted record.
 */
import type { EngineeringJob, JobId } from './types.js';
export declare class JobStore {
    private readonly sessionId;
    constructor(sessionId: string);
    /**
     * Persist (create or overwrite) a job record atomically.
     */
    save(job: EngineeringJob): Promise<void>;
    /**
     * Load a single job by ID. Returns null if not found.
     */
    load(jobId: JobId): Promise<EngineeringJob | null>;
    /**
     * Load all jobs for this session. Skips corrupt or unreadable files.
     */
    loadAll(): Promise<EngineeringJob[]>;
    /**
     * Delete a job record from disk. No-op if not found.
     */
    delete(jobId: JobId): Promise<void>;
    /** Convenience: check if a job exists on disk. */
    exists(jobId: JobId): Promise<boolean>;
}
//# sourceMappingURL=JobStore.d.ts.map