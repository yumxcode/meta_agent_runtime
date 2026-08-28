/**
 * The consumption boundary in `resumeAutoContinuation`.
 *
 * Incident (2026-08-27): a turn ended with `auto_verify_unavailable`. That maps
 * to `error_during_execution`, and the post-turn check for it threw a BARE
 * Error. AutoScheduler documents plain errors as "failed BEFORE the turn ran,
 * safe to retry", so it retried — and the retry hit the history fence
 * (826 loaded vs 818 armed) and marked the wake `cancelled`, which is terminal.
 * A recoverable "verify could not run" became a permanently dead session, after
 * $23.73 and 290k input tokens.
 *
 * The guard for this already existed — AutoWakeConsumedError — but only wrapped
 * the `runSingleTurn` CALL, so it caught exceptions FROM the turn and missed
 * error results RETURNED by it. Both happen at the same point in time: after
 * the turn has run and grown the session history.
 *
 * These tests pin the wrapper's contract. The scheduler-side consequences of
 * getting it wrong are covered in core/auto/__tests__/AutoScheduler.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { withConsumedWakeGuard } from '../singleTurn.js'
import { AutoWakeConsumedError } from '../../core/auto/AutoContinuationStore.js'

describe('withConsumedWakeGuard', () => {
  it('passes a successful result straight through', async () => {
    const out = await withConsumedWakeGuard('s1', async () => ({ outcome: 'done' as const }))
    expect(out).toEqual({ outcome: 'done' })
  })

  it('tags a thrown exception as a consumed wake', async () => {
    // The case the old narrower guard already handled.
    await expect(
      withConsumedWakeGuard('s1', async () => { throw new Error('turn blew up') }),
    ).rejects.toBeInstanceOf(AutoWakeConsumedError)
  })

  it('tags the error-RESULT path too — the case that caused the incident', async () => {
    // Verbatim shape of what `resumeAutoContinuation` throws when the turn
    // returns `error_during_execution`. Before the fix this escaped untagged.
    const thrown = await withConsumedWakeGuard('s1', async () => {
      throw new Error(
        'Stopped (auto mode): completion could not be independently verified. ' +
        'Reason: verify skipped: 无法解析 judge 裁决 JSON',
      )
    }).catch((e: unknown) => e)

    expect(thrown).toBeInstanceOf(AutoWakeConsumedError)
  })

  it('preserves the original cause so the operator still sees the real reason', async () => {
    const cause = new Error('verify skipped: 无法解析 judge 裁决 JSON')
    const thrown = await withConsumedWakeGuard('s1', async () => { throw cause })
      .catch((e: unknown) => e) as AutoWakeConsumedError

    expect(thrown.cause).toBe(cause)
    // The scheduler logs `error.cause.message`; a wrapper that swallowed it
    // would leave the operator with no idea why the run stopped.
    expect(thrown.message).toContain('无法解析 judge 裁决 JSON')
  })

  it('carries the session id, which the resume hint is built from', async () => {
    const thrown = await withConsumedWakeGuard('sess-abc', async () => { throw new Error('x') })
      .catch((e: unknown) => e) as AutoWakeConsumedError

    expect(thrown.sessionId).toBe('sess-abc')
  })

  it('does not double-wrap an error that is already tagged', async () => {
    // Nested guards must not bury the original cause under a second wrapper.
    const inner = new AutoWakeConsumedError('s1', new Error('root cause'))
    const thrown = await withConsumedWakeGuard('s1', async () => { throw inner })
      .catch((e: unknown) => e)

    expect(thrown).toBe(inner)
  })

  it('tags non-Error throws as well', async () => {
    // A bare string or object must not slip through as "retryable".
    for (const value of ['plain string', { code: 'ODD' }, null, undefined]) {
      const thrown = await withConsumedWakeGuard('s1', async () => { throw value })
        .catch((e: unknown) => e)
      expect(thrown).toBeInstanceOf(AutoWakeConsumedError)
    }
  })

  it('tags a rejection from anywhere in the region, not just the first call', async () => {
    // The region wraps the whole post-turn sequence — the turn, the result
    // checks, and the checkpoint update. A failure in the LAST of those is
    // just as consumed as one in the first.
    const thrown = await withConsumedWakeGuard('s1', async () => {
      await Promise.resolve()                       // turn ran
      await Promise.resolve()                       // result checks passed
      throw new Error('updateAutoCheckpointWithStatus failed')  // late failure
    }).catch((e: unknown) => e) as AutoWakeConsumedError

    expect(thrown).toBeInstanceOf(AutoWakeConsumedError)
    expect(thrown.message).toContain('updateAutoCheckpointWithStatus failed')
  })
})
