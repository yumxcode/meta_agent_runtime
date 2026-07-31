import {
  AutoContinuationStore,
  type AutoContinuationRecord,
} from './AutoContinuationStore.js'
import type { AutoResumeOutcome } from './AutoScheduler.js'

export interface AttachedAutoResumeResult {
  outcome: AutoResumeOutcome
  /** A later self_timer wake, already atomically leased to this host. */
  next?: AutoContinuationRecord
}

export type AttachedAutoResumeHandler = (
  record: AutoContinuationRecord,
  signal: AbortSignal,
) => Promise<AttachedAutoResumeResult>

export type AttachedAutoRunOutcome = 'completed' | 'detached'

export interface AttachedAutoSchedulerOptions {
  heartbeatIntervalMs?: number
  onEvent?: (message: string) => void
}

/**
 * Keeps one CLI process attached across any number of durable self_timer
 * boundaries. The wake still lives in the shared store: this host merely holds
 * a renewable claim, so a crash can be recovered by the normal scheduler.
 */
export class AttachedAutoScheduler {
  private readonly heartbeatIntervalMs: number

  constructor(
    private readonly store: AutoContinuationStore,
    private readonly resume: AttachedAutoResumeHandler,
    private readonly options: AttachedAutoSchedulerOptions = {},
  ) {
    this.heartbeatIntervalMs = Math.max(
      10,
      options.heartbeatIntervalMs ?? 30_000,
    )
  }

  async run(
    initialRecord: AutoContinuationRecord,
    signal: AbortSignal,
  ): Promise<AttachedAutoRunOutcome> {
    let record: AutoContinuationRecord | undefined = initialRecord

    while (record) {
      const current = record
      const token = current.claim?.token
      if (current.status !== 'claimed' || !token) {
        throw new Error(`Attached wake ${current.wakeId} does not hold a claim.`)
      }

      this.options.onEvent?.(
        `[auto-attached] waiting ${current.sessionId} until ` +
        `${new Date(current.fireAt).toISOString()} (${current.wakeId})`,
      )
      const ownedAtDeadline = await this.waitUntilDue(current, token, signal)
      if (!ownedAtDeadline) {
        if (signal.aborted) {
          await this.store.release(current.wakeId, token, 'pending', current.fireAt)
          this.options.onEvent?.(
            `[auto-attached] detached ${current.sessionId}; wake remains durable (${current.wakeId})`,
          )
          return 'detached'
        }
        throw new Error(`Attached wake claim lost: ${current.wakeId}`)
      }

      this.options.onEvent?.(
        `[auto-attached] resume ${current.sessionId} (${current.wakeId}, attempt ${current.attempts})`,
      )
      const resumeAbort = new AbortController()
      const forwardAbort = () => resumeAbort.abort(signal.reason)
      signal.addEventListener('abort', forwardAbort, { once: true })
      let claimLost = false
      const heartbeat = setInterval(() => {
        void this.store.heartbeat(current.wakeId, token).then(
          owned => {
            if (owned) return
            claimLost = true
            resumeAbort.abort('attached auto continuation claim lost')
          },
          () => {
            claimLost = true
            resumeAbort.abort('attached auto continuation heartbeat failed')
          },
        )
      }, this.heartbeatIntervalMs)
      heartbeat.unref?.()
      try {
        const result = await this.resume(current, resumeAbort.signal)
        if (claimLost) {
          throw new Error(`Attached wake claim lost: ${current.wakeId}`)
        }
        if (signal.aborted) {
          await this.store.release(current.wakeId, token, result.outcome)
          if (result.next?.claim?.token) {
            await this.store.release(
              result.next.wakeId,
              result.next.claim.token,
              'pending',
              result.next.fireAt,
            )
          }
          this.options.onEvent?.(
            `[auto-attached] detached ${current.sessionId}; wake remains durable (${current.wakeId})`,
          )
          return 'detached'
        }

        if (result.outcome === 'done' && result.next) {
          this.assertNextRecord(current, result.next)
        }
        const released = await this.store.release(current.wakeId, token, result.outcome)
        if (!released) throw new Error(`Attached wake claim lost: ${current.wakeId}`)
        this.options.onEvent?.(
          `[auto-attached] ${result.outcome} ${current.sessionId} (${current.wakeId})`,
        )
        if (result.outcome !== 'done' || !result.next) return 'completed'
        record = result.next
      } catch (error) {
        await this.store.release(current.wakeId, token, 'pending', current.fireAt)
        if (signal.aborted) {
          this.options.onEvent?.(
            `[auto-attached] detached ${current.sessionId}; wake remains durable (${current.wakeId})`,
          )
          return 'detached'
        }
        throw error
      } finally {
        clearInterval(heartbeat)
        signal.removeEventListener('abort', forwardAbort)
      }
    }
    return 'completed'
  }

  private async waitUntilDue(
    record: AutoContinuationRecord,
    token: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    while (!signal.aborted) {
      const remaining = record.fireAt - Date.now()
      if (remaining <= 0) return true
      await abortableDelay(Math.min(remaining, this.heartbeatIntervalMs), signal)
      if (signal.aborted) return false
      if (!await this.store.heartbeat(record.wakeId, token)) return false
    }
    return false
  }

  private assertNextRecord(
    prior: AutoContinuationRecord,
    next: AutoContinuationRecord,
  ): void {
    if (
      next.sessionId !== prior.sessionId ||
      next.projectDir !== prior.projectDir ||
      next.status !== 'claimed' ||
      !next.claim?.token
    ) {
      throw new Error(
        `Attached resume returned an invalid successor wake for ${prior.wakeId}.`,
      )
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
