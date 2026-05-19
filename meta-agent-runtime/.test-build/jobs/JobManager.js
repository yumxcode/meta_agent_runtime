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
import { makeJobId, TERMINAL_STATUSES } from './types.js';
import { JobStore } from './JobStore.js';
import { LocalExecutor } from './JobExecutor.js';
// ─────────────────────────────────────────────────────────────────────────────
export class JobManager {
    store;
    executor;
    sessionId;
    jobs = new Map();
    constructor(sessionId, executor) {
        this.sessionId = sessionId;
        this.store = new JobStore(sessionId);
        this.executor = executor ?? new LocalExecutor();
    }
    // ── submit ───────────────────────────────────────────────────────────────
    /**
     * Submit a new job and return its ID immediately.
     *
     * The handler runs asynchronously; use await() to block until completion.
     */
    async submit(toolName, handler, input, opts = {}) {
        const jobId = makeJobId(opts.domain ?? 'generic', toolName);
        const now = Date.now();
        const job = {
            jobId,
            toolName,
            domain: opts.domain ?? 'generic',
            fidelityLevel: opts.fidelityLevel ?? 0,
            input,
            status: 'submitted',
            metrics: { submittedAt: now },
            agentId: opts.agentId ?? 'unknown',
            sessionId: this.sessionId,
        };
        const rt = {
            job,
            progressListeners: [],
            completionResolvers: [],
        };
        this.jobs.set(jobId, rt);
        await this.store.save(job);
        const callbacks = {
            onQueued: (id) => this._transition(id, 'queued'),
            onStarted: (id) => {
                const rj = this.jobs.get(id);
                if (rj) {
                    rj.job.metrics.startedAt = Date.now();
                    this._transition(id, 'running');
                }
            },
            onProgress: (p) => {
                const rj = this.jobs.get(p.jobId);
                if (rj) {
                    for (const listener of rj.progressListeners)
                        listener(p);
                }
            },
            onCompleted: (id, partial) => {
                const rj = this.jobs.get(id);
                if (!rj)
                    return;
                const now = Date.now();
                rj.job.metrics.completedAt = now;
                rj.job.metrics.wallTimeMs = now - rj.job.metrics.submittedAt;
                const result = {
                    jobId: id,
                    status: 'completed',
                    output: partial.output,
                    summary: partial.summary,
                    artifacts: partial.artifacts ?? [],
                    metrics: { ...rj.job.metrics },
                };
                rj.result = result;
                this._transition(id, 'completed');
                for (const { resolve } of rj.completionResolvers)
                    resolve(result);
                rj.completionResolvers = [];
            },
            onFailed: (id, err) => {
                const rj = this.jobs.get(id);
                if (!rj)
                    return;
                const now = Date.now();
                rj.job.error = err.message;
                rj.job.metrics.completedAt = now;
                rj.job.metrics.wallTimeMs = now - rj.job.metrics.submittedAt;
                const result = {
                    jobId: id,
                    status: 'failed',
                    artifacts: [],
                    metrics: { ...rj.job.metrics },
                    error: err.message,
                };
                rj.result = result;
                this._transition(id, 'failed');
                for (const { reject } of rj.completionResolvers)
                    reject(err);
                rj.completionResolvers = [];
            },
            onCancelled: (id) => {
                const rj = this.jobs.get(id);
                if (!rj)
                    return;
                const now = Date.now();
                rj.job.metrics.completedAt = now;
                rj.job.metrics.wallTimeMs = now - rj.job.metrics.submittedAt;
                const result = {
                    jobId: id,
                    status: 'cancelled',
                    artifacts: [],
                    metrics: { ...rj.job.metrics },
                };
                rj.result = result;
                this._transition(id, 'cancelled');
                const err = new Error(`Job ${id} was cancelled`);
                for (const { reject } of rj.completionResolvers)
                    reject(err);
                rj.completionResolvers = [];
            },
        };
        const executorCtx = {
            jobId,
            sessionId: this.sessionId,
            agentId: opts.agentId ?? 'unknown',
            domain: opts.domain ?? 'generic',
            fidelityLevel: opts.fidelityLevel ?? 0,
        };
        this.executor.submit(jobId, handler, input, executorCtx, callbacks);
        return jobId;
    }
    // ── poll ─────────────────────────────────────────────────────────────────
    /**
     * Returns the current status of a job.
     * Checks in-memory first; falls back to disk for reattached jobs.
     */
    async poll(jobId) {
        const rt = this.jobs.get(jobId);
        if (rt)
            return rt.job.status;
        const persisted = await this.store.load(jobId);
        if (persisted)
            return persisted.status;
        throw new Error(`Unknown job: ${jobId}`);
    }
    // ── awaitJob ──────────────────────────────────────────────────────────────
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
    awaitJob(jobId, onProgress) {
        const rt = this.jobs.get(jobId);
        if (!rt)
            return Promise.reject(new Error(`Unknown job: ${jobId}`));
        // Already done (executor callback populated rt.result)?
        if (rt.result)
            return Promise.resolve(rt.result);
        // Terminal status but no result — reattached or loadSession() job that
        // never passed through executor callbacks.  Return immediately to prevent
        // a permanent hang.
        if (TERMINAL_STATUSES.has(rt.job.status)) {
            const errMsg = rt.job.error ?? `Job ${jobId} ended with status "${rt.job.status}"`;
            return Promise.reject(new Error(errMsg));
        }
        return new Promise((resolve, reject) => {
            if (onProgress)
                rt.progressListeners.push(onProgress);
            rt.completionResolvers.push({ resolve, reject });
        });
    }
    // ── cancel ───────────────────────────────────────────────────────────────
    /**
     * Request cancellation of a job. No-op for terminal jobs.
     */
    async cancel(jobId) {
        const rt = this.jobs.get(jobId);
        if (!rt)
            throw new Error(`Unknown job: ${jobId}`);
        if (TERMINAL_STATUSES.has(rt.job.status))
            return;
        this.executor.cancel(jobId);
        // Actual status transition happens via onCancelled callback
    }
    // ── list ─────────────────────────────────────────────────────────────────
    /**
     * Return all in-memory jobs (optionally filtered).
     */
    list(filter) {
        const all = [...this.jobs.values()].map(rt => rt.job);
        if (!filter)
            return all;
        return all.filter(job => {
            if (filter.agentId && job.agentId !== filter.agentId)
                return false;
            if (filter.sessionId && job.sessionId !== filter.sessionId)
                return false;
            if (filter.domain && job.domain !== filter.domain)
                return false;
            if (filter.toolName && job.toolName !== filter.toolName)
                return false;
            if (filter.status && !filter.status.includes(job.status))
                return false;
            return true;
        });
    }
    // ── reattach ──────────────────────────────────────────────────────────────
    /**
     * Reload a job from disk after a process restart.
     *
     * If the job was still running/queued at the time of the crash, it will be
     * returned with status 'failed' (the process died; the job did not complete).
     * The caller can choose to re-submit it.
     *
     * Terminal jobs are returned as-is.
     */
    async reattach(jobId) {
        const persisted = await this.store.load(jobId);
        if (!persisted)
            return null;
        // If interrupted mid-run, mark as failed
        if (persisted.status === 'running' || persisted.status === 'queued' || persisted.status === 'submitted') {
            persisted.status = 'failed';
            persisted.error = 'Process terminated before job completed';
            await this.store.save(persisted);
        }
        // Register in memory so poll() and list() work
        if (!this.jobs.has(jobId)) {
            this.jobs.set(jobId, {
                job: persisted,
                progressListeners: [],
                completionResolvers: [],
            });
        }
        return persisted;
    }
    // ── loadSession ────────────────────────────────────────────────────────────
    /**
     * Load all persisted jobs for this session into memory (e.g. on restart).
     */
    async loadSession() {
        const all = await this.store.loadAll();
        for (const job of all) {
            if (!this.jobs.has(job.jobId)) {
                this.jobs.set(job.jobId, {
                    job,
                    progressListeners: [],
                    completionResolvers: [],
                });
            }
        }
        return all;
    }
    // ── internal helpers ───────────────────────────────────────────────────────
    _transition(jobId, status) {
        const rt = this.jobs.get(jobId);
        if (!rt)
            return;
        rt.job.status = status;
        // Fire-and-forget persist with exponential back-off.
        // Don't await — we're inside an executor callback.
        void this._persistWithRetry(jobId, { ...rt.job });
    }
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
    async _persistWithRetry(jobId, snapshot, attempt = 0) {
        const MAX_RETRIES = 3;
        const BASE_DELAY_MS = 100; // 100 ms, 200 ms, 400 ms
        try {
            await this.store.save(snapshot);
        }
        catch (err) {
            if (attempt < MAX_RETRIES - 1) {
                const delay = BASE_DELAY_MS * 2 ** attempt;
                console.warn(`[JobManager] Persist attempt ${attempt + 1}/${MAX_RETRIES} failed for job ${jobId}; ` +
                    `retrying in ${delay} ms:`, err);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this._persistWithRetry(jobId, snapshot, attempt + 1);
            }
            // All retries exhausted — mark the in-memory job failed so it never
            // appears stuck in a transient status.
            console.error(`[JobManager] All ${MAX_RETRIES} persist attempts failed for job ${jobId}; marking failed:`, err);
            const rt = this.jobs.get(jobId);
            if (rt && !TERMINAL_STATUSES.has(rt.job.status)) {
                rt.job.status = 'failed';
                rt.job.error = `Persist failure: ${err instanceof Error ? err.message : String(err)}`;
                // best-effort final write — don't recurse
                this.store.save(rt.job).catch(() => { });
                // Reject any callers waiting on awaitJob()
                const persistErr = new Error(`Job ${jobId} persist failed after ${MAX_RETRIES} retries`);
                for (const { reject } of rt.completionResolvers)
                    reject(persistErr);
                rt.completionResolvers = [];
            }
        }
    }
}
//# sourceMappingURL=JobManager.js.map