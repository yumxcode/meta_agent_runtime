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
import { RuntimeEnv } from '../infra/env/RuntimeEnv.js'

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

/** Default wall-clock watchdog applied to every job that doesn't override it. */
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60_000   // 30 minutes

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
  constructor(maxConcurrent = 4, defaultTimeoutMs?: number, maxQueued = Math.max(1, maxConcurrent) * 16) {
    this.maxConcurrent = Math.max(1, Math.floor(maxConcurrent))
    this.maxQueued = Math.max(0, Math.floor(maxQueued))
    this.defaultTimeoutMs =
      defaultTimeoutMs !== undefined && Number.isFinite(defaultTimeoutMs) && defaultTimeoutMs >= 0
        ? defaultTimeoutMs
        : RuntimeEnv.jobTimeoutMs(DEFAULT_JOB_TIMEOUT_MS)
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

    callbacks.onStarted(jobId)

    const fullContext: JobContext = { ...context, abortSignal: ctrl.signal }

    const reporter: ProgressReporter = (progress) => {
      callbacks.onProgress({ jobId, ...progress })
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
