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
export class LocalExecutor {
    maxConcurrent;
    running = 0;
    queue = [];
    abortControllers = new Map();
    constructor(maxConcurrent = 4) {
        this.maxConcurrent = maxConcurrent;
    }
    submit(jobId, handler, input, context, callbacks) {
        const job = { jobId, handler, input, context, callbacks };
        if (this.running < this.maxConcurrent) {
            this._run(job);
        }
        else {
            callbacks.onQueued(jobId);
            this.queue.push(job);
        }
    }
    cancel(jobId) {
        const ctrl = this.abortControllers.get(jobId);
        if (ctrl) {
            ctrl.abort();
            // Callbacks will be fired from within _run() when the handler observes abort
            return;
        }
        // Job is still queued — remove it from the queue and fire cancelled
        const idx = this.queue.findIndex(j => j.jobId === jobId);
        if (idx !== -1) {
            const [job] = this.queue.splice(idx, 1);
            job.callbacks.onCancelled(jobId);
        }
    }
    /** How many slots are currently available */
    get freeSlots() {
        return this.maxConcurrent - this.running;
    }
    /** Total jobs: running + queued */
    get totalPending() {
        return this.running + this.queue.length;
    }
    _run(job) {
        const { jobId, handler, input, context, callbacks } = job;
        const ctrl = new AbortController();
        this.abortControllers.set(jobId, ctrl);
        this.running++;
        callbacks.onStarted(jobId);
        const fullContext = { ...context, abortSignal: ctrl.signal };
        const reporter = (progress) => {
            callbacks.onProgress({ jobId, ...progress });
        };
        handler(input, fullContext, reporter)
            .then((result) => {
            if (ctrl.signal.aborted) {
                callbacks.onCancelled(jobId);
            }
            else {
                callbacks.onCompleted(jobId, result);
            }
        })
            .catch((err) => {
            if (ctrl.signal.aborted ||
                (err instanceof Error && err.name === 'AbortError')) {
                callbacks.onCancelled(jobId);
            }
            else {
                callbacks.onFailed(jobId, err instanceof Error ? err : new Error(String(err)));
            }
        })
            .finally(() => {
            this.abortControllers.delete(jobId);
            this.running--;
            this._drainQueue();
        });
    }
    _drainQueue() {
        while (this.running < this.maxConcurrent && this.queue.length > 0) {
            const next = this.queue.shift();
            this._run(next);
        }
    }
}
//# sourceMappingURL=JobExecutor.js.map