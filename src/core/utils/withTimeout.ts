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

export type AbortableOperation<T> = (signal: AbortSignal) => Promise<T>

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

/**
 * Run an abort-aware operation with a deadline.  Unlike withTimeout(), this
 * actively aborts the operation's signal when the deadline fires so supported
 * SDKs/fetches can release sockets and retry state promptly.
 */
export function withAbortableTimeout<T>(
  operation: AbortableOperation<T>,
  ms: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  let timeoutError: TimeoutError | undefined
  const onParentAbort = (): void => {
    ctrl.abort(parentSignal?.reason ?? 'parent-abort')
  }

  if (parentSignal?.aborted) {
    onParentAbort()
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, { once: true })
  }

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeoutError = new TimeoutError(ms)
      ctrl.abort(timeoutError)
      reject(timeoutError)
    }, ms)
  })

  return Promise.race([operation(ctrl.signal), timeout]).finally(() => {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', onParentAbort)
    if (!ctrl.signal.aborted && timeoutError === undefined) ctrl.abort('operation-complete')
  })
}
