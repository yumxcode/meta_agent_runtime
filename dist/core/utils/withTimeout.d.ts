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
export declare class TimeoutError extends Error {
    constructor(ms: number);
}
/**
 * Race `promise` against a timeout of `ms` milliseconds.
 * Rejects with TimeoutError if the deadline fires first.
 * Always clears the timer to avoid leaking into the event loop.
 */
export declare function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>;
//# sourceMappingURL=withTimeout.d.ts.map