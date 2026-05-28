/**
 * withTimeout — race a promise against a hard deadline.
 *
 * Extracted from core/memory/findRelevantMemories.ts so all flash-model
 * side-calls share the same timeout primitive.
 *
 * Usage:
 *   const result = await withTimeout(fetchSomething(), 3_000)
 *   // throws TimeoutError if fetchSomething() takes > 3 s
 */
export class TimeoutError extends Error {
    constructor(ms) {
        super(`Timed out after ${ms} ms`);
        this.name = 'TimeoutError';
    }
}
/**
 * Race `promise` against a timeout of `ms` milliseconds.
 * Rejects with TimeoutError if the deadline fires first.
 * Always clears the timer to avoid leaking into the event loop.
 */
export function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
//# sourceMappingURL=withTimeout.js.map