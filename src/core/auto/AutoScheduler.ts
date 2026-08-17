import {
  AutoContinuationStore,
  AutoWakeConsumedError,
  type AutoContinuationRecord,
} from './AutoContinuationStore.js'

export interface AutoSchedulerOptions {
  pollIntervalMs?: number
  maxConcurrent?: number
  retryBaseMs?: number
  onEvent?: (message: string) => void
  /**
   * Exit once the queue has held no live work (no pending, no claimed, nothing
   * running) for this long. 0 disables it and the scheduler polls forever.
   *
   * "Idle" deliberately means EMPTY, not "nothing due right now": a wake parked
   * 55 minutes out is still live work and keeps the scheduler alive. Only a
   * queue with nothing left in it counts, which is precisely the case where the
   * process was otherwise sitting in an empty workspace burning a terminal tab
   * for no reason.
   */
  idleExitMs?: number
  /**
   * Called once per poll iteration of `run()`.
   *
   * Used for the scheduler's liveness heartbeat. Deliberately driven by the
   * poll tick rather than its own timer: a wedged or blocked loop then STOPS
   * beating, which is exactly the condition a monitor needs to see. An
   * independent `setInterval` would keep reporting health while nothing was
   * being scheduled.
   *
   * Failures are swallowed — a monitoring side-channel must never take the
   * scheduler down with it.
   */
  onTick?: (now: number) => void | Promise<void>
}

/** Why `run()` returned. */
export type AutoSchedulerExitReason = 'aborted' | 'idle'

export type AutoResumeOutcome = 'done' | 'cancelled'
export type AutoResumeHandler = (
  record: AutoContinuationRecord,
  signal: AbortSignal,
) => Promise<AutoResumeOutcome>

/**
 * One scheduler services every Auto timer in a workspace. It never sleeps
 * inside an Agent session; it polls the durable queue and resumes due records.
 */
export class AutoScheduler {
  private readonly pollIntervalMs: number
  private readonly maxConcurrent: number
  private readonly retryBaseMs: number
  private readonly idleExitMs: number
  private readonly active = new Set<Promise<void>>()

  constructor(
    private readonly store: AutoContinuationStore,
    private readonly resume: AutoResumeHandler,
    private readonly options: AutoSchedulerOptions = {},
  ) {
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1_000)
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1)
    this.retryBaseMs = Math.max(100, options.retryBaseMs ?? 5_000)
    this.idleExitMs = Math.max(0, options.idleExitMs ?? 0)
  }

  /**
   * Is there any work left that this scheduler could ever run?
   *
   * `pending` counts even when its fireAt is far in the future — that is a wake
   * we are legitimately waiting for. `claimed` counts because someone (possibly
   * another process) is mid-flight. Terminal records are just an audit trail.
   */
  private async hasLiveWork(): Promise<boolean> {
    if (this.active.size > 0) return true
    const records = await this.store.list()
    return records.some(r => r.status === 'pending' || r.status === 'claimed')
  }

  /**
   * Claim every due wake that fits in the free capacity and START it.
   * Returns immediately — the claims keep running in `this.active`.
   *
   * This is the piece `run()` needs. `tickOnce` below adds the drain because
   * its one-shot callers (`--once`, unit tests) want "this batch finished".
   *
   * `maxConcurrent` is a genuine CONCURRENCY CEILING here, which is what the
   * flag has always been named. It used not to be: tickOnce awaited every
   * in-flight claim before returning, so `active` was empty at the top of each
   * poll and `maxConcurrent - active.size` was a constant. The effect was that
   * one slow wake blocked every wake that came due while it ran — measured at
   * 1.78s for a 2s claim with 3 slots free, and an auto turn is minutes, not
   * seconds. `loop/daemon.ts` had this right all along; this now matches it.
   */
  async dispatchDue(now = Date.now(), signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) return 0
    await this.store.reconcileOrphans(now)
    // Only claims whose lease has actually EXPIRED are reclaimed, and runClaim
    // heartbeats every 30s against a 10min TTL, so sweeping on every poll can
    // never steal a claim this process is still working on.
    const capacity = Math.max(0, this.maxConcurrent - this.active.size)
    if (capacity === 0) return 0
    const records = await this.store.claimDue(now, undefined, capacity)
    for (const record of records) {
      // runClaim already funnels every failure into a release + onEvent, but a
      // throw from the release itself would now escape as an UNHANDLED
      // rejection (nothing awaits this promise any more), and the CLI treats
      // unhandledRejection as fatal. Terminate the chain here.
      const task = this.runClaim(record, signal)
        .catch(error => {
          this.options.onEvent?.(
            `[auto-scheduler] claim handler crashed for ${record.sessionId} ` +
            `(${record.wakeId}): ${error instanceof Error ? error.message : String(error)}`,
          )
        })
        .finally(() => this.active.delete(task))
      this.active.add(task)
    }
    return records.length
  }

  /** Wait for every in-flight claim to settle. */
  async drain(): Promise<void> {
    // Re-read after each wait: a settling claim cannot add work, but draining
    // twice is cheap and makes the method safe to call from anywhere.
    while (this.active.size > 0) await Promise.allSettled([...this.active])
  }

  /**
   * Claim due wakes and wait for that batch to finish.
   *
   * Kept blocking on purpose: `--once` means "do the due work and exit", and a
   * non-blocking version would turn it into fire-and-forget.
   */
  async tickOnce(now = Date.now(), signal?: AbortSignal): Promise<number> {
    const claimed = await this.dispatchDue(now, signal)
    if (claimed > 0) await this.drain()
    return claimed
  }

  async run(signal: AbortSignal): Promise<AutoSchedulerExitReason> {
    await this.store.reconcileOrphans()
    // Timestamp of the moment the queue first went empty; null while it holds
    // live work. Tracked rather than counted so a single long poll interval
    // cannot skip past the threshold.
    let emptySince: number | null = null

    while (!signal.aborted) {
      try {
        await this.options.onTick?.(Date.now())
      } catch {
        // See onTick's contract: monitoring never breaks scheduling.
      }
      // dispatchDue, NOT tickOnce: the polling loop must stay responsive to
      // newly-due wakes while earlier ones are still running.
      await this.dispatchDue(Date.now(), signal)
      if (signal.aborted) break

      if (this.idleExitMs > 0) {
        if (await this.hasLiveWork()) {
          emptySince = null
        } else {
          emptySince ??= Date.now()
          if (Date.now() - emptySince >= this.idleExitMs) {
            this.options.onEvent?.(
              `[auto-scheduler] no wakes left in this workspace — exiting after ` +
              `${Math.round(this.idleExitMs / 1000)}s idle.`,
            )
            await this.drain()
            return 'idle'
          }
        }
      }

      await abortableDelay(this.pollIntervalMs, signal)
    }
    // An abort does NOT abandon in-flight claims: runClaim forwards the signal
    // to each turn and then releases its wake, so draining is what turns a
    // Ctrl-C into a clean queue rather than a pile of orphaned `claimed`
    // records waiting on reconcileOrphans to time out.
    await this.drain()
    return 'aborted'
  }

  private async runClaim(
    record: AutoContinuationRecord,
    parentSignal?: AbortSignal,
  ): Promise<void> {
    const token = record.claim?.token
    if (!token) return
    const controller = new AbortController()
    const onAbort = () => controller.abort(parentSignal?.reason)
    parentSignal?.addEventListener('abort', onAbort, { once: true })
    const heartbeat = setInterval(() => {
      void this.store.heartbeat(record.wakeId, token).then(owned => {
        if (!owned) controller.abort('auto continuation claim lost')
      })
    }, 30_000)
    heartbeat.unref?.()
    try {
      this.options.onEvent?.(
        `[auto-scheduler] resume ${record.sessionId} (${record.wakeId}, attempt ${record.attempts})`,
      )
      const outcome = await this.resume(record, controller.signal)
      await this.store.release(record.wakeId, token, outcome)
      this.options.onEvent?.(
        `[auto-scheduler] ${outcome} ${record.sessionId} (${record.wakeId})`,
      )
    } catch (error) {
      // A CONSUMED wake must never be retried. The turn already ran and grew the
      // session history, so this record's historyMessageCount fence no longer
      // matches — a retry would fail that fence and mark the wake `cancelled`,
      // which is terminal, silently destroying a live session. (That is exactly
      // how a transient "cannot arm while sub-agents are active" turned into a
      // lost 55-minute run.) Release it as done and report the real cause.
      if (error instanceof AutoWakeConsumedError) {
        await this.store.release(record.wakeId, token, 'done')
        this.options.onEvent?.(
          `[auto-scheduler] wake consumed for ${record.sessionId} (${record.wakeId}) but the ` +
          `turn failed afterwards — NOT retrying (a retry would cancel the session). ` +
          `Cause: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}. ` +
          `Session history is persisted; resume it with: ` +
          `meta-agent --mode auto --resume ${record.sessionId} "继续"`,
        )
        return
      }

      // Everything else failed BEFORE the turn ran, so the wake is still
      // unconsumed and safe to retry.
      const backoff = Math.min(
        5 * 60_000,
        this.retryBaseMs * (2 ** Math.min(8, Math.max(0, record.attempts - 1))),
      )
      await this.store.release(
        record.wakeId,
        token,
        'pending',
        Date.now() + backoff,
      )
      this.options.onEvent?.(
        `[auto-scheduler] retry ${record.sessionId} in ${backoff}ms: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearInterval(heartbeat)
      parentSignal?.removeEventListener('abort', onAbort)
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    const onAbort = () => done()
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
