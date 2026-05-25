/**
 * JobManager — the single Runtime-level singleton for all async job lifecycle.
 *
 * API surface:
 *
 *   submit(toolName, handler, input, opts)  → Promise<JobId>
 *   poll(jobId)                             → Promise<JobStatus>
 *   await(jobId, onProgress?)               → Promise<JobResult>
 *   cancel(jobId)                           → Promise<void>
 *   list(filter?)                           → EngineeringJob[]
 *   reattach(jobId)                         → Promise<EngineeringJob | null>
 *
 * Persistence:
 *   Every status transition triggers JobStore.save().  On restart, the
 *   caller can call reattach(jobId) to read the persisted record and, if
 *   the job was interrupted mid-run, re-queue it.
 *
 * Progress subscriptions:
 *   await() accepts an optional onProgress callback that is called
 *   synchronously every time the running handler reports progress.
 *   Multiple callers can await() the same job simultaneously — each
 *   gets their own callback stream.
 */
import type { JobId, JobHandler, JobStatus, JobResult, JobProgress, EngineeringJob, DimensionalRecord, JobFilter } from './types.js';
import type { Executor } from './JobExecutor.js';
export interface SubmitOptions {
    domain?: string;
    fidelityLevel?: number;
    agentId?: string;
}
export declare class JobManager {
    private readonly store;
    private readonly executor;
    private readonly sessionId;
    private readonly jobs;
    constructor(sessionId: string, executor?: Executor);
    /**
     * Submit a new job and return its ID immediately.
     *
     * The handler runs asynchronously; use await() to block until completion.
     */
    submit(toolName: string, handler: JobHandler, input: DimensionalRecord, opts?: SubmitOptions): Promise<JobId>;
    /**
     * Returns the current status of a job.
     * Checks in-memory first; falls back to disk for reattached jobs.
     */
    poll(jobId: JobId): Promise<JobStatus>;
    /**
     * Waits for a job to reach a terminal state and returns its result.
     * Optionally receives progress updates while waiting.
     *
     * If the job is already complete, resolves immediately.
     * Multiple callers can await the same job.
     *
     * P1-9 fix: reattach() and loadSession() register jobs with a terminal
     * status but without a `result` object (executor callbacks never fired).
     * Previously, awaitJob() would fall through to registering a resolver that
     * is never called — hanging permanently.
     *
     * Fix: if the in-memory record is terminal but has no result, reject
     * immediately with the job's stored error message so the caller isn't stuck.
     * A completed job without a result is treated as failed (shouldn't happen in
     * normal flow, but defensive).
     */
    awaitJob(jobId: JobId, onProgress?: (p: JobProgress) => void): Promise<JobResult>;
    /**
     * Request cancellation of a job. No-op for terminal jobs.
     */
    cancel(jobId: JobId): Promise<void>;
    /**
     * Return all in-memory jobs (optionally filtered).
     */
    list(filter?: JobFilter): EngineeringJob[];
    /**
     * Reload a job from disk after a process restart.
     *
     * If the job was still running/queued at the time of the crash, it will be
     * returned with status 'failed' (the process died; the job did not complete).
     * The caller can choose to re-submit it.
     *
     * Terminal jobs are returned as-is.
     */
    reattach(jobId: JobId): Promise<EngineeringJob | null>;
    /**
     * Load all persisted jobs for this session into memory (e.g. on restart).
     */
    loadSession(): Promise<EngineeringJob[]>;
    private _transition;
    /**
     * Persist a job record with up to MAX_PERSIST_RETRIES attempts, using
     * exponential back-off between retries (100 ms → 200 ms → 400 ms).
     *
     * On exhaustion the in-memory job is marked 'failed' and completion
     * promises are rejected, so the job is never silently stuck in a
     * non-terminal state.
     *
     * P1-6: replaces bare .catch(console.error) that gave no retry path.
     */
    private _persistWithRetry;
}
//# sourceMappingURL=JobManager.d.ts.map