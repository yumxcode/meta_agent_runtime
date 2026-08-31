/**
 * A failing claim heartbeat must not take the process down.
 *
 * The CLI installs `process.once('unhandledRejection', … disposeAndExit(1))`, so
 * an unhandled rejection anywhere is fatal to the whole run. The scheduler's
 * heartbeat used to call `store.heartbeat()` inside a bare `setInterval` with no
 * rejection handler — and that call genuinely rejects: it takes the queue lock,
 * which `withFileLock` abandons after 10s, and the same lock is taken every poll
 * by reconcileOrphans and claimDue. So one bout of lock contention could kill an
 * unattended run mid-turn.
 *
 * The contract these tests pin down:
 *   • a rejecting heartbeat produces no unhandled rejection, and
 *   • it does not abort the in-flight turn either — a lock timeout is not
 *     evidence the claim was lost, only a definitive "not owned" is.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AutoScheduler } from '../AutoScheduler.js'
import type { AutoContinuationRecord } from '../AutoContinuationStore.js'

function record(): AutoContinuationRecord {
  return {
    schemaVersion: '1.0',
    wakeId: 'auto-wake-test',
    sessionId: 'session-1',
    projectDir: '/tmp/project',
    fireAt: Date.now() - 1,
    status: 'claimed',
    claim: { owner: 'test', token: 'token-1', claimedAt: Date.now(), expiresAt: Date.now() + 600_000 },
    attempts: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as AutoContinuationRecord
}

/** Minimal store: claimDue hands out one record, heartbeat always rejects. */
function makeStore(heartbeat: () => Promise<boolean>) {
  let handedOut = false
  return {
    reconcileOrphans: async () => 0,
    claimDue: async () => (handedOut ? [] : (handedOut = true, [record()])),
    list: async () => [],
    heartbeat,
    release: async () => true,
  } as never
}

describe('AutoScheduler heartbeat failure handling', () => {
  afterEach(() => vi.useRealTimers())

  it('does not emit an unhandled rejection when the heartbeat rejects', async () => {
    vi.useFakeTimers()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)

    try {
      const store = makeStore(async () => {
        throw new Error('withFileLock: timed out after 10000ms waiting for /tmp/queue.lock')
      })
      let turnAborted = false
      const scheduler = new AutoScheduler(
        store,
        async (_rec, signal) => {
          // Two beats: enough to prove the rejections are handled, and still
          // below HEARTBEAT_FAILURE_TOLERANCE.
          for (let i = 0; i < 2; i++) {
            await vi.advanceTimersByTimeAsync(30_000)
            if (signal.aborted) { turnAborted = true; break }
          }
          return 'done'
        },
        { maxConcurrent: 1 },
      )

      const dispatch = scheduler.dispatchDue(Date.now())
      await vi.advanceTimersByTimeAsync(0)
      await dispatch
      await scheduler.drain()

      // Let any stray rejection reach the process handler.
      vi.useRealTimers()
      await new Promise(resolve => setImmediate(resolve))

      expect(unhandled).toEqual([])
      // Two consecutive I/O failures are below the tolerance, so the turn keeps
      // running rather than being discarded over transient lock contention.
      expect(turnAborted).toBe(false)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('gives up once heartbeat failures are sustained rather than transient', async () => {
    vi.useFakeTimers()
    const store = makeStore(async () => { throw new Error('EIO') })
    let abortReason: unknown
    const scheduler = new AutoScheduler(
      store,
      async (_rec, signal) => {
        // Past HEARTBEAT_FAILURE_TOLERANCE beats: this is no longer contention,
        // so the claim really is presumed lost.
        for (let i = 0; i < 4; i++) {
          await vi.advanceTimersByTimeAsync(30_000)
          if (signal.aborted) { abortReason = signal.reason; break }
        }
        return 'done'
      },
      { maxConcurrent: 1 },
    )

    const dispatch = scheduler.dispatchDue(Date.now())
    await vi.advanceTimersByTimeAsync(0)
    await dispatch
    await scheduler.drain()

    expect(String(abortReason)).toContain('heartbeat failed')
  })

  it('still aborts the turn on a definitive "claim not owned" answer', async () => {
    vi.useFakeTimers()
    // Resolving false is authoritative: someone else holds the claim now.
    const store = makeStore(async () => false)
    let abortReason: unknown
    const scheduler = new AutoScheduler(
      store,
      async (_rec, signal) => {
        await vi.advanceTimersByTimeAsync(30_000)
        await vi.advanceTimersByTimeAsync(0)
        if (signal.aborted) abortReason = signal.reason
        return 'done'
      },
      { maxConcurrent: 1 },
    )

    const dispatch = scheduler.dispatchDue(Date.now())
    await vi.advanceTimersByTimeAsync(0)
    await dispatch
    await scheduler.drain()

    expect(abortReason).toBe('auto continuation claim lost')
  })
})
