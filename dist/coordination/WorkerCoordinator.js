/**
 * WorkerCoordinator — parallel design-point evaluation engine.
 *
 * Responsibilities:
 *   1. Register all task IDs with CampaignStateStore BEFORE starting
 *      (so CampaignMonitor's poll loop sees them as "pending").
 *   2. Execute evaluation handler for each design point in parallel,
 *      bounded by maxConcurrent (default: 4).
 *   3. Write each result to store.evaluations.jsonl on completion.
 *   4. Mark tasks complete or failed in state.json after each finishes.
 *   5. Resolve (or never reject) when all tasks have settled.
 *
 * The EvaluationHandler is a pure function: given a DesignPoint + fidelity,
 * it returns the objective values, constraint satisfaction, and feasibility.
 * The WorkerCoordinator wraps timing, provenance ID generation, and
 * persistence around it.
 *
 * Design notes:
 *   • Uses a semaphore-style concurrency limiter (no external dependency).
 *   • Each task failure is isolated — one failure does not abort the batch.
 *   • Stable task IDs are derived from workerId + point index + point ID hash
 *     so the same points + same workerId always produce the same task IDs
 *     (safe for idempotent retry).
 */
import { randomUUID } from 'crypto';
// ── Concurrency helpers ───────────────────────────────────────────────────────
/**
 * Run an array of async tasks with bounded concurrency.
 * Resolves when all tasks have settled (never rejects — errors surface
 * inside the task functions themselves).
 */
async function runWithConcurrencyLimit(tasks, maxConcurrent) {
    let index = 0;
    async function worker() {
        while (index < tasks.length) {
            const i = index++;
            try {
                await tasks[i]();
            }
            catch {
                // Individual task errors are handled inside the task function.
                // We continue processing remaining tasks.
            }
        }
    }
    const slots = Math.min(maxConcurrent, tasks.length);
    await Promise.all(Array.from({ length: slots }, () => worker()));
}
export class WorkerCoordinator {
    store;
    workerId;
    maxConcurrent;
    constructor(store, opts = {}) {
        this.store = store;
        this.workerId = opts.workerId ?? `w_${randomUUID().slice(0, 8)}`;
        this.maxConcurrent = opts.maxConcurrent ?? 4;
    }
    get id() {
        return this.workerId;
    }
    /**
     * Run all design points through the evaluation handler in parallel.
     *
     * Returns the list of task IDs.  Each ID is either in completedTaskIds
     * or failedTaskIds in the store after this resolves.
     */
    async runParallel(points, fidelity, handler) {
        if (points.length === 0)
            return [];
        const { objectives, constraints } = this.store.designSpace;
        // 1. Assign stable task IDs (deterministic: workerId + index + point hash)
        const tasks = points.map((pt, i) => ({
            taskId: `${this.workerId}_${String(i).padStart(4, '0')}_${pt.id.slice(0, 8)}`,
            point: pt,
        }));
        // 2. Register ALL task IDs before any work starts.
        //    CampaignMonitor checks pendingTaskIds to decide if the phase is done.
        await this.store.registerPendingTasks(tasks.map(t => t.taskId));
        await this.store.appendWorkerLog(this.workerId, `Starting ${tasks.length} evaluations at fidelity=${fidelity}, concurrency=${this.maxConcurrent}`);
        // 3. Build per-point evaluation closures
        const jobs = tasks.map(({ taskId, point }) => async () => {
            const startMs = Date.now();
            try {
                const partial = await handler(point, fidelity, objectives, constraints);
                const result = {
                    designPoint: point,
                    fidelity,
                    evaluatedBy: this.workerId,
                    durationMs: Date.now() - startMs,
                    ...partial,
                };
                // Append result before marking task complete (order matters)
                await this.store.submitResult(result);
                await this.store.completeTask(taskId);
                await this.store.appendWorkerLog(this.workerId, `✓ ${taskId} | fidelity=${fidelity} | feasible=${result.feasible} | ${Date.now() - startMs}ms`);
            }
            catch (err) {
                await this.store.failTask(taskId, String(err));
                await this.store.appendWorkerLog(this.workerId, `✗ ${taskId} failed: ${String(err).slice(0, 200)}`);
            }
        });
        // 4. Execute with bounded concurrency
        await runWithConcurrencyLimit(jobs, this.maxConcurrent);
        await this.store.appendWorkerLog(this.workerId, `Batch complete. ${tasks.length} tasks dispatched.`);
        return tasks.map(t => t.taskId);
    }
    /**
     * Run a single design point and return the full EvaluationResult.
     * Convenience wrapper around runParallel for one-shot evaluations.
     */
    async runSingle(point, fidelity, handler) {
        const { objectives, constraints } = this.store.designSpace;
        const startMs = Date.now();
        try {
            const partial = await handler(point, fidelity, objectives, constraints);
            return {
                designPoint: point,
                fidelity,
                evaluatedBy: this.workerId,
                durationMs: Date.now() - startMs,
                ...partial,
            };
        }
        catch {
            // Evaluation handler threw; null signals the coordinator to skip this
            // design point so other workers can continue processing the queue.
            return null;
        }
    }
}
//# sourceMappingURL=WorkerCoordinator.js.map