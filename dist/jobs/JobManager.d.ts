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
    /**
     * S2: LRU cap on terminal jobs held in memory.  Active (queued / running)
     * jobs are NEVER evicted regardless of this cap — only completed / failed /
     * cancelled records count toward the limit.  Default keeps the most recent
     * 200 completed records for `list()` / `await()` re-attach; tune via
     * `META_AGENT_KEEP_TERMINAL_JOBS` env var or `setTerminalJobCap()`.
     */
    private _terminalJobCap;
    private static readonly DEFAULT_TERMINAL_JOB_CAP;
    /**
     * S2: insertion-ordered list of terminal job IDs (oldest first) used by the
     * LRU eviction pass.  We can't rely on `jobs.keys()` order because jobs may
     * transition from active → terminal arbitrarily.
     */
    private readonly _terminalOrder;
    constructor(sessionId: string, executor?: Executor);
    /**
     * Override the LRU cap on terminal jobs.  Pass `Infinity` to disable
     * eviction (useful for tests that want to inspect every job afterwards).
     */
    setTerminalJobCap(cap: number): void;
    /**
     * S2: Forget a single terminal job.  No-op for active jobs (returns false)
     * so callers can't accidentally drop work in flight.
     */
    forgetJob(jobId: JobId): boolean;
    /**
     * S2: Forget every terminal job whose completion time is older than `ts`.
     * Returns the number evicted.  Falls back to submittedAt when completedAt
     * is unavailable.
     */
    forgetCompletedBefore(ts: number): number;
    /** S2: drop in-memory state for every terminal job. Used by host shutdown. */
    forgetAllCompleted(): number;
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
    /** S2: drop oldest terminal jobs until size ≤ _terminalJobCap. */
    private _evictTerminalIfOverCap;
    private _dropFromTerminalOrder;
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