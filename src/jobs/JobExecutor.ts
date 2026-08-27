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
 *
 * Watchdog (long-running safety):
 *   Cooperative cancellation (abort) only frees a slot if the handler actually
 *   observes the signal. A handler that ignores abort — or is wedged in a
 *   native call that never returns — would otherwise hold its concurrency slot
 *   for the executor's entire lifetime, and once all slots are held the FIFO
 *   queue never drains (a permanent deadlock).
 *
 *   To bound this, every running job gets a wall-clock watchdog. On expiry the
 *   executor aborts the job's signal and reports a terminal failure immediately.
 *   Crucially, the physical concurrency slot remains occupied until the handler
 *   really settles. In-process JavaScript cannot force-kill an arbitrary Promise;
 *   releasing the slot early would make `maxConcurrent` a bookkeeping fiction
 *   and allow timed-out handlers to accumulate without bound behind newly-started
 *   work. Callers that require hard termination must use a subprocess executor.
 *
 *   The budget is `context.timeoutMs` (per job) ?? the executor default
 *   (`META_AGENT_JOB_TIMEOUT_MS` env or 30 min). A value of 0 disables the
 *   watchdog for that job / the whole executor.
 */

import type {
  JobId,
  JobHandler,
  JobContext,
  JobResult,
  JobProgress,
  ProgressReporter,
  DimensionalRecord,
} from './types.js'
import { timeout } from '../core/timeouts.js'

// ─────────────────────────────────────────────────────────────────────────────
// Executor interface (for future swap-in of subprocess / remote backends)
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecutorCallbacks {
  onQueued(jobId: JobId): void
  onStarted(jobId: JobId): void
  onProgress(progress: JobProgress): void
  onCompleted(jobId: JobId, result: Pick<JobResult, 'output' | 'summary' | 'artifacts'>): void
  onFailed(jobId: JobId, error: Error): void
  onCancelled(jobId: JobId): void
}

export interface Executor {
  submit(
    jobId: JobId,
    handler: JobHandler,
    input: DimensionalRecord,
    context: Omit<JobContext, 'abortSignal'>,
    callbacks: ExecutorCallbacks,
  ): void

  cancel(jobId: JobId): void
}

// ─────────────────────────────────────────────────────────────────────────────
// LocalExecutor — runs handlers as async functions in the same process
// ─────────────────────────────────────────────────────────────────────────────

interface PendingJob {
  jobId: JobId
  handler: JobHandler
  input: DimensionalRecord
  context: Omit<JobContext, 'abortSignal'>
  callbacks: ExecutorCallbacks
}

// The default job watchdog now lives in core/timeouts.ts (`timeouts.jobMs`,
// 30 min) so it is settable from the config file as well as
// META_AGENT_JOB_TIMEOUT_MS.

/** Thrown when an executor is constructed with a limit it cannot honour. */
export class ExecutorConfigError extends Error {
  readonly code = 'ERR_INVALID_EXECUTOR_CONFIG'
  constructor(message: string) {
    super(message)
    this.name = 'ExecutorConfigError'
  }
}

function requireInt(value: number, name: string, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ExecutorConfigError(
      `${name} must be a finite number, received ${describeNumber(value)}`,
    )
  }
  if (!Number.isInteger(value)) {
    throw new ExecutorConfigError(`${name} must be an integer, received ${value}`)
  }
  if (value < min) {
    throw new ExecutorConfigError(`${name} must be >= ${min}, received ${value}`)
  }
  return value
}

const requirePositiveInt = (v: number, n: string): number => requireInt(v, n, 1)
const requireNonNegativeInt = (v: number, n: string): number => requireInt(v, n, 0)

/** `String(NaN)` is "NaN", which reads like a typo rather than a diagnosis. */
function describeNumber(value: unknown): string {
  if (typeof value !== 'number') return `${typeof value} (${String(value)})`
  if (Number.isNaN(value)) return 'NaN (check the parse that produced it)'
  return String(value)
}

export class LocalExecutor implements Executor {
  private readonly maxConcurrent: number
  private readonly maxQueued: number
  private readonly defaultTimeoutMs: number
  private running = 0
  private queue: PendingJob[] = []
  private abortControllers = new Map<JobId, AbortController>()

  /**
   * @param maxConcurrent    max jobs running simultaneously (FIFO queue beyond)
   * @param defaultTimeoutMs default watchdog budget in ms. Falls back to the
   *   `META_AGENT_JOB_TIMEOUT_MS` env var, then {@link DEFAULT_JOB_TIMEOUT_MS}.
   *   `0` disables the watchdog by default (a per-job `timeoutMs` can still
   *   re-enable it). Negative / non-finite inputs are ignored.
   */
  constructor(maxConcurrent = 4, defaultTimeoutMs?: number, maxQueued?: number) {
    // P2-2 (review 2026-08-27): `Math.max(1, Math.floor(NaN))` is NaN, and
    // every comparison against NaN is false. That silently disabled BOTH
    // limits at once — `running < maxConcurrent` never admitted a job, so
    // everything queued forever, while `queue.length >= maxQueued` never
    // tripped, so the queue grew without bound. A misconfigured pool that
    // accepts work and never runs it is worse than one that refuses to start,
    // so these throw instead of being clamped into something plausible.
    this.maxConcurrent = requirePositiveInt(maxConcurrent, 'maxConcurrent')
    this.maxQueued = maxQueued === undefined
      ? this.maxConcurrent * 16
      : requireNonNegativeInt(maxQueued, 'maxQueued')
    this.defaultTimeoutMs =
      defaultTimeoutMs !== undefined && Number.isFinite(defaultTimeoutMs) && defaultTimeoutMs >= 0
        ? defaultTimeoutMs
        : timeout('jobMs')
  }

  submit(
    jobId: JobId,
    handler: JobHandler,
    input: DimensionalRecord,
    context: Omit<JobContext, 'abortSignal'>,
    callbacks: ExecutorCallbacks,
  ): void {
    const job: PendingJob = { jobId, handler, input, context, callbacks }

    if (this.running < this.maxConcurrent) {
      this._run(job)
    } else {
      if (this.queue.length >= this.maxQueued) {
        callbacks.onFailed(
          jobId,
          new Error(
            `LocalExecutor queue is full (${this.queue.length}/${this.maxQueued}); ` +
            'refusing work while all physical slots are occupied.',
          ),
        )
        return
      }
      callbacks.onQueued(jobId)
      this.queue.push(job)
    }
  }

  cancel(jobId: JobId): void {
    const ctrl = this.abortControllers.get(jobId)
    if (ctrl) {
      ctrl.abort()
      // Callbacks will be fired from within _run() when the handler observes abort
      return
    }
    // Job is still queued — remove it from the queue and fire cancelled
    const idx = this.queue.findIndex(j => j.jobId === jobId)
    if (idx !== -1) {
      const [job] = this.queue.splice(idx, 1)
      job.callbacks.onCancelled(jobId)
    }
  }

  /** How many slots are currently available */
  get freeSlots(): number {
    return this.maxConcurrent - this.running
  }

  /** Total jobs: running + queued */
  get totalPending(): number {
    return this.running + this.queue.length
  }

  private _run(job: PendingJob): void {
    const { jobId, handler, input, context, callbacks } = job

    const ctrl = new AbortController()
    this.abortControllers.set(jobId, ctrl)
    this.running++

    // P2-1: `onStarted` runs after `this.running++`, so letting it throw would
    // escape `_run()` into `submit()` and permanently leak the slot we just
    // took. Notification failure must not corrupt the executor's accounting.
    try {
      callbacks.onStarted(jobId)
    } catch (err) {
      console.warn(`[LocalExecutor] onStarted callback for job ${jobId} threw:`, err)
    }

    const fullContext: JobContext = { ...context, abortSignal: ctrl.signal }

    const reporter: ProgressReporter = (progress) => {
      // P2-1 (review 2026-08-27): `reportProgress()` is called from inside the
      // handler, so an exception here surfaced as a handler rejection and
      // turned a successful job into a failed one. Progress reporting is an
      // observation channel — it can go wrong without the work going wrong.
      // JobManager isolates individual listeners too; this is the second layer,
      // covering any other ExecutorCallbacks implementation.
      try {
        callbacks.onProgress({ jobId, ...progress })
      } catch (err) {
        console.warn(`[LocalExecutor] onProgress callback for job ${jobId} threw:`, err)
      }
    }

    // Reporting and resource settlement are deliberately separate. The
    // watchdog may report failure before an uncooperative handler settles, but
    // only REAL settlement releases the physical concurrency slot.
    let terminalReported = false
    let resourcesReleased = false
    let watchdog: ReturnType<typeof setTimeout> | undefined

    const releaseResources = (): void => {
      if (resourcesReleased) return
      resourcesReleased = true
      if (watchdog) { clearTimeout(watchdog); watchdog = undefined }
      this.abortControllers.delete(jobId)
      this.running--
      this._drainQueue()
    }

    const reportTerminal = (fireTerminal: () => void): void => {
      if (terminalReported) return
      terminalReported = true
      fireTerminal()
    }

    // ── Wall-clock watchdog ─────────────────────────────────────────────────
    // Bounds the caller-visible job lifetime. A handler that ignores abort may
    // still hold its physical slot indefinitely, intentionally applying
    // backpressure instead of starting unbounded replacement work.
    const timeoutMs = context.timeoutMs ?? this.defaultTimeoutMs
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      watchdog = setTimeout(() => {
        reportTerminal(() => {
          // Best-effort cooperative cancel. The slot intentionally remains held
          // until the handler really settles; see the class-level safety note.
          ctrl.abort()
          callbacks.onFailed(
            jobId,
            new Error(`Job ${jobId} exceeded ${timeoutMs}ms executor timeout (watchdog)`),
          )
        })
      }, timeoutMs)
      // Never keep the event loop alive solely for the watchdog.
      watchdog.unref?.()
    }

    // Start on a microtask so a synchronously-throwing handler follows the same
    // terminal path as a rejected Promise instead of escaping submit().
    Promise.resolve()
      .then(() => handler(input, fullContext, reporter))
      .then((result) => {
        releaseResources()
        reportTerminal(() => {
          if (ctrl.signal.aborted) {
            callbacks.onCancelled(jobId)
          } else {
            callbacks.onCompleted(jobId, result)
          }
        })
      })
      .catch((err: unknown) => {
        releaseResources()
        reportTerminal(() => {
          if (
            ctrl.signal.aborted ||
            (err instanceof Error && err.name === 'AbortError')
          ) {
            callbacks.onCancelled(jobId)
          } else {
            callbacks.onFailed(jobId, err instanceof Error ? err : new Error(String(err)))
          }
        })
      })
  }

  private _drainQueue(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!
      this._run(next)
    }
  }
}
