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
  constructor(ms: number) {
    super(`Timed out after ${ms} ms`)
    this.name = 'TimeoutError'
  }
}

/**
 * Race `promise` against a timeout of `ms` milliseconds.
 * Rejects with TimeoutError if the deadline fires first.
 * Always clears the timer to avoid leaking into the event loop.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
