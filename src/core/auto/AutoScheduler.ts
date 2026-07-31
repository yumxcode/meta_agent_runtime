import {
  AutoContinuationStore,
  type AutoContinuationRecord,
} from './AutoContinuationStore.js'

export interface AutoSchedulerOptions {
  pollIntervalMs?: number
  maxConcurrent?: number
  retryBaseMs?: number
  onEvent?: (message: string) => void
}

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
  private readonly active = new Set<Promise<void>>()

  constructor(
    private readonly store: AutoContinuationStore,
    private readonly resume: AutoResumeHandler,
    private readonly options: AutoSchedulerOptions = {},
  ) {
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1_000)
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1)
    this.retryBaseMs = Math.max(100, options.retryBaseMs ?? 5_000)
  }

  async tickOnce(now = Date.now(), signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) return 0
    await this.store.reconcileOrphans(now)
    const capacity = Math.max(0, this.maxConcurrent - this.active.size)
    if (capacity === 0) return 0
    const records = await this.store.claimDue(now, undefined, capacity)
    for (const record of records) {
      const task = this.runClaim(record, signal).finally(() => this.active.delete(task))
      this.active.add(task)
    }
    if (records.length > 0) await Promise.all([...this.active])
    return records.length
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.store.reconcileOrphans()
    while (!signal.aborted) {
      await this.tickOnce(Date.now(), signal)
      if (signal.aborted) break
      await abortableDelay(this.pollIntervalMs, signal)
    }
    await Promise.allSettled([...this.active])
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
