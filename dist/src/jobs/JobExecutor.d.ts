/**
 * JobExecutor — runs a JobHandler in the background and reports status
 * back to the JobManager via callbacks.
 *
 * This is the **local in-process executor** (Phase 1).  It executes the
 * handler as an async function in the same Node.js process, which is
 * suitable for L0/L1 tools (analytical formulas, quick scripts).
 *
 * For Phase 4 (subprocess / remote HPC), a `SubprocessExecutor` can be
 * swapped in by implementing the same `Executor` interface.
 *
 * Cancellation:
 *   Each executing job gets its own AbortController. Calling abort() causes
 *   the AbortSignal passed to the handler to become aborted. Well-behaved
 *   handlers check `signal.aborted` periodically and throw/reject promptly.
 *   JobExecutor catches the abort and reports status = 'cancelled'.
 *
 * Concurrency:
 *   The executor maintains a simple slot-based queue: at most `maxConcurrent`
 *   jobs run simultaneously; extras wait in a FIFO queue.
 */
import type { JobId, JobHandler, JobContext, JobResult, JobProgress, DimensionalRecord } from './types.js';
export interface ExecutorCallbacks {
    onQueued(jobId: JobId): void;
    onStarted(jobId: JobId): void;
    onProgress(progress: JobProgress): void;
    onCompleted(jobId: JobId, result: Pick<JobResult, 'output' | 'summary' | 'artifacts'>): void;
    onFailed(jobId: JobId, error: Error): void;
    onCancelled(jobId: JobId): void;
}
export interface Executor {
    submit(jobId: JobId, handler: JobHandler, input: DimensionalRecord, context: Omit<JobContext, 'abortSignal'>, callbacks: ExecutorCallbacks): void;
    cancel(jobId: JobId): void;
}
export declare class LocalExecutor implements Executor {
    private readonly maxConcurrent;
    private running;
    private queue;
    private abortControllers;
    constructor(maxConcurrent?: number);
    submit(jobId: JobId, handler: JobHandler, input: DimensionalRecord, context: Omit<JobContext, 'abortSignal'>, callbacks: ExecutorCallbacks): void;
    cancel(jobId: JobId): void;
    /** How many slots are currently available */
    get freeSlots(): number;
    /** Total jobs: running + queued */
    get totalPending(): number;
    private _run;
    private _drainQueue;
}
//# sourceMappingURL=JobExecutor.d.ts.map