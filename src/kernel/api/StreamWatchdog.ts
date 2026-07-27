/**
 * StreamWatchdog — the only timeout that actually bounds a streaming LLM call.
 *
 * ## The gap this closes
 *
 * Both vendor SDKs implement their `timeout` option as
 *
 * ```js
 * const timeout = setTimeout(() => controller.abort(), ms)
 * try   { return await fetch(url, opts) }
 * finally { clearTimeout(timeout) }          // ← fires when HEADERS arrive
 * ```
 *
 * `fetch` resolves on response headers, which for SSE arrive immediately. From
 * the first byte onward a streaming request has **no timeout at all** — a
 * gateway that holds the connection open but stops emitting events hangs the
 * agent forever. Verified empirically: with `timeout: 2000` against a server
 * that sends three SSE events then stalls, the stream was still open after 12 s.
 *
 * ## Why two budgets rather than one total
 *
 * A total wall-clock cap cannot work here: the default `maxTokens` is 131,072,
 * which at ~20 tok/s is ~109 minutes of *legitimate* generation. Any cap low
 * enough to catch a stall would kill real long-form work.
 *
 * So the watchdog measures the two things that a healthy stream always does:
 *
 *   - **first-token**: the request produces *something* within `firstTokenMs`.
 *     Sized for a long-context prefill (the compaction threshold is the worst
 *     case), not for a warm short call.
 *   - **idle**: consecutive events are never more than `idleMs` apart. At
 *     ~20 tok/s the real gap is sub-second, so a minute of silence is
 *     unambiguous.
 *
 * ## Interaction with the retry path
 *
 * A `StreamTimeoutError` is retryable, but the caller's `yieldedAny` guard
 * decides what that means in practice, and the split is exactly right:
 *
 *   - **first-token timeout** → nothing was yielded, so the client's retry loop
 *     re-issues the request (up to `maxRetries`, default 5).
 *   - **idle timeout mid-stream** → output was already rendered, so replaying
 *     would duplicate it. The error propagates to KernelLoop's stream-error
 *     recovery, which injects `buildStreamErrorRecoveryText` and lets the model
 *     continue the turn.
 *
 * Before this module neither path was reachable: they only trigger on a thrown
 * error, and a stalled stream never threw.
 */

/** Thrown when a stream produces no first event, or goes silent mid-flight. */
export class StreamTimeoutError extends Error {
  constructor(
    readonly phase: 'first_token' | 'idle',
    readonly limitMs: number,
  ) {
    super(
      phase === 'first_token'
        ? `Model stream produced no first event within ${limitMs}ms`
        : `Model stream stalled: no event for ${limitMs}ms`,
    )
    this.name = 'StreamTimeoutError'
  }
}

export interface StreamWatchdogOptions {
  /** Budget from iteration start to the first event. */
  firstTokenMs: number
  /** Maximum silence between consecutive events. */
  idleMs: number
  /**
   * Invoked once, before the error is thrown, so the caller can abort the
   * underlying request and release the socket. Must not throw.
   */
  onTimeout?: (phase: 'first_token' | 'idle') => void
}

/**
 * Wrap an async iterable so each `next()` races a deadline.
 *
 * The deadline is `firstTokenMs` until the first event arrives and `idleMs`
 * thereafter. On expiry `onTimeout` runs (to abort the request) and a
 * `StreamTimeoutError` is thrown from the generator.
 *
 * The source iterator's `return()` is called on every exit path — timeout,
 * downstream `break`, or downstream throw — so the SDK can tear the response
 * down instead of leaking the socket.
 */
export async function* withStreamWatchdog<T>(
  source: AsyncIterable<T>,
  opts: StreamWatchdogOptions,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()
  let sawFirst = false
  let closed = false

  /**
   * Fire-and-forget teardown — deliberately NOT awaited.
   *
   * `return()` on a generator suspended inside an un-resolving `await` returns
   * a promise that never settles: the generator cannot be resumed to run its
   * `finally`. Awaiting it would hang the watchdog on exactly the stalled
   * stream it exists to escape, converting a 60 s timeout into a permanent
   * hang. Invoking it still lets a well-behaved iterator release its socket,
   * and `onTimeout` has already aborted the request by this point.
   */
  const closeSource = (): void => {
    if (closed) return
    closed = true
    try {
      const maybe = iterator.return?.() as Promise<unknown> | undefined
      void maybe?.catch?.(() => { /* teardown is best-effort */ })
    } catch { /* teardown is best-effort */ }
  }

  try {
    for (;;) {
      const limitMs = sawFirst ? opts.idleMs : opts.firstTokenMs
      const phase = sawFirst ? 'idle' as const : 'first_token' as const

      let timer: ReturnType<typeof setTimeout> | undefined
      // A rejected race loser would surface as an unhandledRejection (fatal in
      // the CLI), so the deadline is a resolving sentinel rather than a
      // rejecting promise.
      const deadline = new Promise<'__timeout__'>(resolve => {
        timer = setTimeout(() => resolve('__timeout__'), limitMs)
      })

      const pending = iterator.next()
      let settled: IteratorResult<T> | '__timeout__'
      try {
        settled = await Promise.race([pending, deadline])
      } finally {
        if (timer) clearTimeout(timer)
      }

      if (settled === '__timeout__') {
        // Aborting below makes the losing `next()` reject. `Promise.race` has
        // already attached handlers to it, so that rejection is NOT reported as
        // unhandled today — this explicit catch is insurance, not a fix: it
        // keeps the invariant true if the race is ever replaced with something
        // that does not adopt its losers (the CLI treats unhandledRejection as
        // fatal, so regressing here would kill the process on the very stall
        // this module exists to survive). See the matching test.
        void pending.catch(() => { /* expected: aborted by us */ })

        // Abort FIRST so the in-flight request is cancelled, then tear down the
        // iterator, then surface the error.
        try { opts.onTimeout?.(phase) } catch { /* never mask the timeout */ }
        closeSource()
        throw new StreamTimeoutError(phase, limitMs)
      }

      if (settled.done) return
      sawFirst = true
      yield settled.value
    }
  } finally {
    closeSource()
  }
}

/** True for the watchdog's own error — used by the clients' retry classifier. */
export function isStreamTimeoutError(error: unknown): error is StreamTimeoutError {
  return error instanceof StreamTimeoutError
}
