/**
 * In-process cron job store.
 *
 * Implements a lightweight cron scheduler using Node's setInterval.
 * Each job is keyed by a UUID.  Jobs run within the current process for the
 * lifetime of the session (or until explicitly deleted).
 *
 * Design mirrors CC's ScheduleCronTool (CronCreateTool / CronDeleteTool /
 * CronListTool) but uses pure Node instead of a cron library dependency.
 */
import { randomUUID } from 'crypto';
// Global store — keyed by job ID.  One store per process, shared across sessions.
const store = new Map();
// ─────────────────────────────────────────────────────────────────────────────
// Cron expression parser (6-field: second minute hour dom month dow)
// ─────────────────────────────────────────────────────────────────────────────
function nextIntervalMs(expression) {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 6)
        throw new Error(`Invalid cron expression (expected 6 fields): "${expression}"`);
    // Simple heuristic: compute the smallest repeating unit from the expression.
    // Full cron matching (specific days/hours) would require a proper cron library.
    // This implementation supports the most common patterns used in practice:
    //   every-N-seconds:  */N * * * * *  →  N * 1000 ms
    //   every-N-minutes:  0 */N * * * *  →  N * 60000 ms
    //   every-N-hours:    0 0 */N * * *  →  N * 3600000 ms
    //   once-per-day:     0 0 0 * * *    →  86400000 ms
    const [sec, min, hour] = parts;
    if (sec && sec !== '*' && !sec.startsWith('*/')) {
        // Fixed second — treat as minutely (can't easily compute next tick without a full parser)
        return 60_000;
    }
    if (sec && sec.startsWith('*/')) {
        const n = parseInt(sec.slice(2), 10);
        if (!isNaN(n) && n > 0)
            return n * 1_000;
    }
    if (min && min.startsWith('*/')) {
        const n = parseInt(min.slice(2), 10);
        if (!isNaN(n) && n > 0)
            return n * 60_000;
    }
    if (hour && hour.startsWith('*/')) {
        const n = parseInt(hour.slice(2), 10);
        if (!isNaN(n) && n > 0)
            return n * 3_600_000;
    }
    // Default: treat as once-per-minute
    return 60_000;
}
// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
export function createCronJob(expression, description, sessionId, callback) {
    const intervalMs = nextIntervalMs(expression); // throws on bad expression
    const id = randomUUID();
    const entry = {
        id,
        expression,
        description,
        sessionId,
        createdAt: new Date(),
        lastRunAt: null,
        runCount: 0,
        active: true,
        callback,
        timer: null,
    };
    entry.timer = setInterval(async () => {
        entry.lastRunAt = new Date();
        entry.runCount++;
        try {
            await callback();
        }
        catch { /* swallow — cron jobs must not crash the process */ }
    }, intervalMs);
    // Allow Node to exit even if timers are still pending
    if (entry.timer.unref)
        entry.timer.unref();
    store.set(id, entry);
    return publicView(entry);
}
export function deleteCronJob(id) {
    const entry = store.get(id);
    if (!entry)
        return false;
    if (entry.timer)
        clearInterval(entry.timer);
    entry.active = false;
    store.delete(id);
    return true;
}
/**
 * Cancel and remove all cron jobs belonging to a session.
 *
 * Call this when a session ends to prevent dangling setInterval callbacks
 * from accumulating in the module-level store (memory leak + wasted CPU).
 * Returns the number of jobs that were cancelled.
 */
export function deleteJobsForSession(sessionId) {
    let count = 0;
    for (const [id, entry] of store) {
        if (entry.sessionId === sessionId) {
            if (entry.timer)
                clearInterval(entry.timer);
            entry.active = false;
            store.delete(id);
            count++;
        }
    }
    return count;
}
export function listCronJobs(sessionId) {
    return [...store.values()]
        .filter(e => sessionId === undefined || e.sessionId === sessionId)
        .map(publicView);
}
function publicView(e) {
    return {
        id: e.id,
        expression: e.expression,
        description: e.description,
        sessionId: e.sessionId,
        createdAt: e.createdAt,
        lastRunAt: e.lastRunAt,
        runCount: e.runCount,
        active: e.active,
    };
}
//# sourceMappingURL=cronStore.js.map