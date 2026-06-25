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
 *   ⚠ Crash-consistency contract: non-terminal transitions persist
 *   fire-and-forget (with retry), so a job killed between running →
 *   completed may be persisted as 'running'.  Hosts MUST call loadSession()
 *   or reattach() after a restart — both normalise interrupted jobs to
 *   'failed' — before trusting list()/poll() results.
 *
 * Progress subscriptions:
 *   await() accepts an optional onProgress callback that is called
 *   synchronously every time the running handler reports progress.
 *   Multiple callers can await() the same job simultaneously — each
 *   gets their own callback stream.
 */

import type {
  JobId,
  JobHandler,
  JobStatus,
  JobResult,
  JobProgress,
  EngineeringJob,
  DimensionalRecord,
  JobFilter,
} from './types.js'
import { makeJobId, TERMINAL_STATUSES } from './types.js'
import { JobStore } from './JobStore.js'
import { LocalExecutor } from './JobExecutor.js'
import type { Executor, ExecutorCallbacks } from './JobExecutor.js'
import { RuntimeEnv } from '../infra/env/RuntimeEnv.js'

// ─────────────────────────────────────────────────────────────────────────────
// Submit options
// ─────────────────────────────────────────────────────────────────────────────

export interface SubmitOptions {
  domain?: string
  fidelityLevel?: number
  agentId?: string
  /**
   * Per-job wall-clock budget (ms) forwarded to the executor watchdog. Omit to
   * use the executor default; `0` disables the watchdog for this job. See
   * {@link JobContext.timeoutMs}.
   */
  timeoutMs?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal runtime record (in-memory augmented view of a persisted job)
// ─────────────────────────────────────────────────────────────────────────────

interface RuntimeJob {
  job: EngineeringJob
  result?: JobResult
  progressListeners: Array<(p: JobProgress) => void>
  completionResolvers: Array<{ resolve: (r: JobResult) => void; reject: (e: Error) => void }>
}

// ─────────────────────────────────────────────────────────────────────────────

export class JobManager {
  private readonly store: JobStore
  private readonly executor: Executor
  private readonly sessionId: string
  private readonly jobs = new Map<JobId, RuntimeJob>()
  /**
   * S2: LRU cap on terminal jobs held in memory.  Active (queued / running)
   * jobs are NEVER evicted regardless of this cap — only completed / failed /
   * cancelled records count toward the limit.  Default keeps the most recent
   * 200 completed records for `list()` / `await()` re-attach; tune via
   * `META_AGENT_KEEP_TERMINAL_JOBS` env var or `setTerminalJobCap()`.
   */
  private _terminalJobCap: number
  private static readonly DEFAULT_TERMINAL_JOB_CAP = 200
  /**
   * S2: insertion-ordered list of terminal job IDs (oldest first) used by the
   * LRU eviction pass.  We can't rely on `jobs.keys()` order because jobs may
   * transition from active → terminal arbitrarily.
   */
  private readonly _terminalOrder: JobId[] = []

  constructor(sessionId: string, executor?: Executor) {
    this.sessionId = sessionId
    this.store = new JobStore(sessionId)
    this.executor = executor ?? new LocalExecutor()
    this._terminalJobCap = RuntimeEnv.keepTerminalJobs(JobManager.DEFAULT_TERMINAL_JOB_CAP)
  }

  /**
   * Override the LRU cap on terminal jobs.  Pass `Infinity` to disable
   * eviction (useful for tests that want to inspect every job afterwards).
   */
  setTerminalJobCap(cap: number): void {
    if (!Number.isFinite(cap) || cap < 0) return
    this._terminalJobCap = cap
    this._evictTerminalIfOverCap()
  }

  /**
   * S2: Forget a single terminal job.  No-op for active jobs (returns false)
   * so callers can't accidentally drop work in flight.
   */
  forgetJob(jobId: JobId): boolean {
    const rt = this.jobs.get(jobId)
    if (!rt) return false
    if (!TERMINAL_STATUSES.has(rt.job.status)) return false
    this._dropFromTerminalOrder(jobId)
    this.jobs.delete(jobId)
    return true
  }

  /**
   * S2: Forget every terminal job whose completion time is older than `ts`.
   * Returns the number evicted.  Falls back to submittedAt when completedAt
   * is unavailable.
   */
  forgetCompletedBefore(ts: number): number {
    let n = 0
    for (const [id, rt] of this.jobs) {
      if (!TERMINAL_STATUSES.has(rt.job.status)) continue
      const t = rt.job.metrics.completedAt ?? rt.job.metrics.submittedAt
      if (t < ts) {
        this._dropFromTerminalOrder(id)
        this.jobs.delete(id)
        n++
      }
    }
    return n
  }

  /** S2: drop in-memory state for every terminal job. Used by host shutdown. */
  forgetAllCompleted(): number {
    let n = 0
    for (const [id, rt] of this.jobs) {
      if (TERMINAL_STATUSES.has(rt.job.status)) {
        this.jobs.delete(id)
        n++
      }
    }
    this._terminalOrder.length = 0
    return n
  }

  // ── submit ───────────────────────────────────────────────────────────────

  /**
   * Submit a new job and return its ID immediately.
   *
   * The handler runs asynchronously; use await() to block until completion.
   */
  async submit(
    toolName: string,
    handler: JobHandler,
    input: DimensionalRecord,
    opts: SubmitOptions = {},
  ): Promise<JobId> {
    const jobId = makeJobId(opts.domain ?? 'generic', toolName)
    const now   = Date.now()

    const job: EngineeringJob = {
      jobId,
      toolName,
      domain: opts.domain ?? 'generic',
      fidelityLevel: opts.fidelityLevel ?? 0,
      input,
      status: 'submitted',
      metrics: { submittedAt: now },
      agentId: opts.agentId ?? 'unknown',
      sessionId: this.sessionId,
    }

    const rt: RuntimeJob = {
      job,
      progressListeners: [],
      completionResolvers: [],
    }

    this.jobs.set(jobId, rt)
    await this.store.save(job)

    const callbacks: ExecutorCallbacks = {
      onQueued: (id) => this._transition(id, 'queued'),
      onStarted: (id) => {
        const rj = this.jobs.get(id)
        if (rj) {
          rj.job.metrics.startedAt = Date.now()
          this._transition(id, 'running')
        }
      },
      onProgress: (p) => {
        const rj = this.jobs.get(p.jobId)
        if (rj) {
          for (const listener of rj.progressListeners) listener(p)
        }
      },
      onCompleted: async (id, partial) => {
        const rj = this.jobs.get(id)
        if (!rj) return
        const now = Date.now()
        rj.job.metrics.completedAt = now
        rj.job.metrics.wallTimeMs  = now - rj.job.metrics.submittedAt
        const result: JobResult = {
          jobId: id,
          status: 'completed',
          output: partial.output,
          summary: partial.summary,
          artifacts: partial.artifacts ?? [],
          metrics: { ...rj.job.metrics },
        }
        rj.result = result
        const persisted = await this._transition(id, 'completed')
        if (!persisted) {
          const err = new Error(`Job ${id} completed but terminal state could not be persisted`)
          for (const { reject } of rj.completionResolvers) reject(err)
          rj.completionResolvers = []
          return
        }
        for (const { resolve } of rj.completionResolvers) resolve(result)
        rj.completionResolvers = []
      },
      onFailed: async (id, err) => {
        const rj = this.jobs.get(id)
        if (!rj) return
        const now = Date.now()
        rj.job.error = err.message
        rj.job.metrics.completedAt = now
        rj.job.metrics.wallTimeMs  = now - rj.job.metrics.submittedAt
        const result: JobResult = {
          jobId: id,
          status: 'failed',
          artifacts: [],
          metrics: { ...rj.job.metrics },
          error: err.message,
        }
        rj.result = result
        await this._transition(id, 'failed')
        for (const { reject } of rj.completionResolvers) reject(err)
        rj.completionResolvers = []
      },
      onCancelled: async (id) => {
        const rj = this.jobs.get(id)
        if (!rj) return
        const now = Date.now()
        rj.job.metrics.completedAt = now
        rj.job.metrics.wallTimeMs  = now - rj.job.metrics.submittedAt
        const result: JobResult = {
          jobId: id,
          status: 'cancelled',
          artifacts: [],
          metrics: { ...rj.job.metrics },
        }
        rj.result = result
        await this._transition(id, 'cancelled')
        const err = new Error(`Job ${id} was cancelled`)
        for (const { reject } of rj.completionResolvers) reject(err)
        rj.completionResolvers = []
      },
    }

    const executorCtx = {
      jobId,
      sessionId: this.sessionId,
      agentId: opts.agentId ?? 'unknown',
      domain: opts.domain ?? 'generic',
      fidelityLevel: opts.fidelityLevel ?? 0,
      ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
    }

    this.executor.submit(jobId, handler, input, executorCtx, callbacks)

    return jobId
  }

  // ── poll ─────────────────────────────────────────────────────────────────

  /**
   * Returns the current status of a job.
   * Checks in-memory first; falls back to disk for reattached jobs.
   */
  async poll(jobId: JobId): Promise<JobStatus> {
    const rt = this.jobs.get(jobId)
    if (rt) return rt.job.status

    const persisted = await this.store.load(jobId)
    if (persisted) return persisted.status

    throw new Error(`Unknown job: ${jobId}`)
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
  awaitJob(jobId: JobId, onProgress?: (p: JobProgress) => void): Promise<JobResult> {
    const rt = this.jobs.get(jobId)
    if (!rt) return Promise.reject(new Error(`Unknown job: ${jobId}`))

    // Already done (executor callback populated rt.result)?
    if (rt.result) return Promise.resolve(rt.result)

    // Terminal status but no result — reattached or loadSession() job that
    // never passed through executor callbacks.  Return immediately to prevent
    // a permanent hang.
    if (TERMINAL_STATUSES.has(rt.job.status)) {
      const errMsg = rt.job.error ?? `Job ${jobId} ended with status "${rt.job.status}"`
      return Promise.reject(new Error(errMsg))
    }

    return new Promise<JobResult>((resolve, reject) => {
      if (onProgress) rt.progressListeners.push(onProgress)
      rt.completionResolvers.push({ resolve, reject })
    })
  }

  // ── cancel ───────────────────────────────────────────────────────────────

  /**
   * Request cancellation of a job. No-op for terminal jobs.
   */
  async cancel(jobId: JobId): Promise<void> {
    const rt = this.jobs.get(jobId)
    if (!rt) throw new Error(`Unknown job: ${jobId}`)

    if (TERMINAL_STATUSES.has(rt.job.status)) return

    this.executor.cancel(jobId)
    // Actual status transition happens via onCancelled callback
  }

  // ── list ─────────────────────────────────────────────────────────────────

  /**
   * Return all in-memory jobs (optionally filtered).
   */
  list(filter?: JobFilter): EngineeringJob[] {
    const all = [...this.jobs.values()].map(rt => rt.job)
    if (!filter) return all

    return all.filter(job => {
      if (filter.agentId && job.agentId !== filter.agentId) return false
      if (filter.sessionId && job.sessionId !== filter.sessionId) return false
      if (filter.domain && job.domain !== filter.domain) return false
      if (filter.toolName && job.toolName !== filter.toolName) return false
      if (filter.status && !filter.status.includes(job.status)) return false
      return true
    })
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
  async reattach(jobId: JobId): Promise<EngineeringJob | null> {
    const persisted = await this.store.load(jobId)
    if (!persisted) return null

    // If interrupted mid-run, mark as failed
    if (persisted.status === 'running' || persisted.status === 'queued' || persisted.status === 'submitted') {
      persisted.status = 'failed'
      persisted.error  = 'Process terminated before job completed'
      await this.store.save(persisted)
    }

    // Register in memory so poll() and list() work
    if (!this.jobs.has(jobId)) {
      this.jobs.set(jobId, {
        job: persisted,
        progressListeners: [],
        completionResolvers: [],
      })
    }

    return persisted
  }

  // ── loadSession ────────────────────────────────────────────────────────────

  /**
   * Load all persisted jobs for this session into memory (e.g. on restart).
   */
  async loadSession(): Promise<EngineeringJob[]> {
    const all = await this.store.loadAll()
    for (const job of all) {
      if (!this.jobs.has(job.jobId)) {
        this.jobs.set(job.jobId, {
          job,
          progressListeners: [],
          completionResolvers: [],
        })
        if (TERMINAL_STATUSES.has(job.status)) {
          this._dropFromTerminalOrder(job.jobId)
          this._terminalOrder.push(job.jobId)
        }
      }
    }
    this._evictTerminalIfOverCap()
    return all
  }

  // ── internal helpers ───────────────────────────────────────────────────────

  private async _transition(jobId: JobId, status: JobStatus): Promise<boolean> {
    const rt = this.jobs.get(jobId)
    if (!rt) return false
    rt.job.status = status
    // Fire-and-forget persist with exponential back-off.
    // Active transitions remain non-blocking; terminal transitions are awaited
    // by their callbacks before resolving/rejecting awaitJob() callers.
    const persistPromise = this._persistWithRetry(jobId, { ...rt.job })

    // S2: When a job enters a terminal status, drop progress / completion
    // closures (they're already drained by the executor callback) and put the
    // job at the back of the LRU queue.  This is the only place jobs become
    // eligible for eviction — active jobs stay in the Map regardless of cap.
    if (TERMINAL_STATUSES.has(status)) {
      rt.progressListeners.length = 0
      this._dropFromTerminalOrder(jobId)
      this._terminalOrder.push(jobId)
      this._evictTerminalIfOverCap()
      return persistPromise
    }
    void persistPromise
    return true
  }

  /** S2: drop oldest terminal jobs until size ≤ _terminalJobCap. */
  private _evictTerminalIfOverCap(): void {
    if (!Number.isFinite(this._terminalJobCap)) return
    while (this._terminalOrder.length > this._terminalJobCap) {
      const id = this._terminalOrder.shift()
      if (id === undefined) break
      const rt = this.jobs.get(id)
      if (rt && TERMINAL_STATUSES.has(rt.job.status)) {
        this.jobs.delete(id)
      }
    }
  }

  private _dropFromTerminalOrder(jobId: JobId): void {
    const idx = this._terminalOrder.indexOf(jobId)
    if (idx >= 0) this._terminalOrder.splice(idx, 1)
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
  private async _persistWithRetry(
    jobId: JobId,
    snapshot: EngineeringJob,
    attempt = 0,
  ): Promise<boolean> {
    const MAX_RETRIES  = 3
    const BASE_DELAY_MS = 100   // 100 ms, 200 ms, 400 ms

    try {
      await this.store.save(snapshot)
      return true
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * 2 ** attempt
        console.warn(
          `[JobManager] Persist attempt ${attempt + 1}/${MAX_RETRIES} failed for job ${jobId}; ` +
          `retrying in ${delay} ms:`, err,
        )
        await new Promise<void>(resolve => setTimeout(resolve, delay))
        return this._persistWithRetry(jobId, snapshot, attempt + 1)
      }

      // All retries exhausted — mark the in-memory job failed so it never
      // appears stuck in a transient status.
      console.error(
        `[JobManager] All ${MAX_RETRIES} persist attempts failed for job ${jobId}; marking failed:`, err,
      )
      const rt = this.jobs.get(jobId)
      if (rt && !TERMINAL_STATUSES.has(rt.job.status)) {
        rt.job.status = 'failed'
        rt.job.error  = `Persist failure: ${err instanceof Error ? err.message : String(err)}`
        // best-effort final write — don't recurse
        this.store.save(rt.job).catch(() => {})
        // Reject any callers waiting on awaitJob()
        const persistErr = new Error(`Job ${jobId} persist failed after ${MAX_RETRIES} retries`)
        for (const { reject } of rt.completionResolvers) reject(persistErr)
        rt.completionResolvers = []
      }
      return false
    }
  }
}
