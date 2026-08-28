/**
 * AutoScheduler — wake claim / retry / terminal handling.
 *
 * There was no test file for this scheduler at all, and the gap cost a real
 * unattended run: a session parked for 55 minutes, arming its follow-up wake
 * failed transiently, and the scheduler's blanket retry then CANCELLED the
 * session outright.
 *
 * The mechanism was:
 *   attempt 1 → the turn runs and persists new history, then arming throws
 *   scheduler → releases the SAME wake back to 'pending' and retries
 *   attempt 2 → history.length !== record.historyMessageCount → 'cancelled'
 *   'cancelled' is terminal → the wake never fires again → session orphaned
 *
 * The retry could never have succeeded: the wake's own execution invalidated
 * the fence it is checked against. These tests pin the distinction between a
 * failure BEFORE the turn ran (safe to retry) and one AFTER (must not).
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AutoContinuationStore,
  AutoWakeConsumedError,
  type AutoContinuationRecord,
} from '../AutoContinuationStore.js'
import { AutoScheduler } from '../AutoScheduler.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'auto-sched-'))
  dirs.push(dir)
  return dir
}

async function scheduleDue(store: AutoContinuationStore, sessionId = 's1'): Promise<AutoContinuationRecord> {
  return store.schedule({
    sessionId,
    fireAt: Date.now() - 1_000,          // already due
    reason: 'test wake',
    historyMessageCount: 10,
  })
}

/** Status of a wake straight off disk. */
async function statusOf(store: AutoContinuationStore, wakeId: string): Promise<string | undefined> {
  return (await store.list()).find(r => r.wakeId === wakeId)?.status
}

describe('a wake CONSUMED by a failed turn is not retried', () => {
  it('releases as done instead of re-queuing', async () => {
    const store = new AutoContinuationStore(await project())
    const record = await scheduleDue(store)
    const events: string[] = []

    const scheduler = new AutoScheduler(
      store,
      async () => { throw new AutoWakeConsumedError('s1', new Error('arming refused')) },
      { onEvent: m => events.push(m), retryBaseMs: 100 },
    )
    await scheduler.tickOnce()

    // 'done', NOT 'pending' (which would retry) and NOT 'cancelled' (terminal loss).
    expect(await statusOf(store, record.wakeId)).toBe('done')
    expect(events.join('\n')).toMatch(/NOT retrying/)
  })

  it('surfaces the underlying cause, not just the wrapper', async () => {
    const store = new AutoContinuationStore(await project())
    await scheduleDue(store)
    const events: string[] = []
    const scheduler = new AutoScheduler(
      store,
      async () => {
        throw new AutoWakeConsumedError('s1', new Error('checkpoint still lists active sub-agents: subtask-ee0265e9'))
      },
      { onEvent: m => events.push(m), retryBaseMs: 100 },
    )
    await scheduler.tickOnce()
    expect(events.join('\n')).toContain('subtask-ee0265e9')
  })

  it('tells the operator how to recover the session', async () => {
    // The history IS persisted — the only thing lost is the wake. Say so.
    const store = new AutoContinuationStore(await project())
    await scheduleDue(store, 'sess-xyz')
    const events: string[] = []
    const scheduler = new AutoScheduler(
      store,
      async () => { throw new AutoWakeConsumedError('sess-xyz', new Error('boom')) },
      { onEvent: m => events.push(m), retryBaseMs: 100 },
    )
    await scheduler.tickOnce()
    expect(events.join('\n')).toMatch(/--resume sess-xyz/)
  })

  it('does not re-run the handler on a later tick', async () => {
    const store = new AutoContinuationStore(await project())
    await scheduleDue(store)
    let calls = 0
    const scheduler = new AutoScheduler(
      store,
      async () => { calls++; throw new AutoWakeConsumedError('s1', new Error('boom')) },
      { retryBaseMs: 1 },
    )
    await scheduler.tickOnce()
    await new Promise(r => setTimeout(r, 20))
    await scheduler.tickOnce()
    expect(calls).toBe(1)
  })
})

describe('a failure BEFORE the turn ran is still retried', () => {
  it('re-queues the wake as pending with a backoff', async () => {
    const store = new AutoContinuationStore(await project())
    const record = await scheduleDue(store)
    const events: string[] = []

    const scheduler = new AutoScheduler(
      store,
      async () => { throw new Error('transient: session store unreadable') },
      { onEvent: m => events.push(m), retryBaseMs: 5_000 },
    )
    await scheduler.tickOnce()

    expect(await statusOf(store, record.wakeId)).toBe('pending')
    expect(events.join('\n')).toMatch(/retry .* in \d+ms/)
  })

  it('pushes fireAt into the future so it is not immediately due again', async () => {
    const store = new AutoContinuationStore(await project())
    const record = await scheduleDue(store)
    const scheduler = new AutoScheduler(
      store,
      async () => { throw new Error('transient') },
      { retryBaseMs: 60_000 },
    )
    await scheduler.tickOnce()
    const after = (await store.list()).find(r => r.wakeId === record.wakeId)!
    expect(after.fireAt).toBeGreaterThan(Date.now())
  })

  it('the retried wake does run again once due', async () => {
    const store = new AutoContinuationStore(await project())
    await scheduleDue(store)
    let calls = 0
    const scheduler = new AutoScheduler(
      store,
      async () => {
        calls++
        if (calls === 1) throw new Error('transient')
        return 'done'
      },
      { retryBaseMs: 1 },
    )
    await scheduler.tickOnce()
    await new Promise(r => setTimeout(r, 30))
    await scheduler.tickOnce(Date.now() + 10_000)
    expect(calls).toBe(2)
  })
})

/**
 * Second line of defence, added after the 2026-08-27 run.
 *
 * The classification above is correct but it is a judgement the resume path has
 * to make right EVERY time, and it missed one: a turn that ended in
 * `auto_verify_unavailable` returned an error RESULT rather than throwing, so
 * the post-turn check threw a bare Error, the scheduler read that as
 * "failed before the turn ran", retried, and the history fence — 826 loaded vs
 * 818 armed — cancelled a live session permanently.
 *
 * `isWakeStillRunnable` asks the fences directly, so a missed classification
 * costs one wake instead of the whole session.
 */
describe('pre-retry fence probe', () => {
  it('does not retry when the fences no longer pass', async () => {
    const store = new AutoContinuationStore(await project())
    const record = await scheduleDue(store)
    const events: string[] = []

    const scheduler = new AutoScheduler(
      store,
      // A bare Error from a turn that HAS already run — the exact shape of the
      // incident, and the shape the primary classification misses.
      async () => { throw new Error('Stopped (auto mode): completion could not be independently verified.') },
      {
        onEvent: m => events.push(m),
        retryBaseMs: 1,
        isWakeStillRunnable: async () => false,   // history moved on
      },
    )
    await scheduler.tickOnce()

    // 'done', not 'pending' — and emphatically not the terminal 'cancelled'
    // that a retry would have produced.
    expect(await statusOf(store, record.wakeId)).toBe('done')
    // Match the retry-scheduling line specifically; a bare /retry/ also hits
    // the "NOT retrying" explanation this path emits.
    expect(events.join('\n')).not.toMatch(/retry \S+ in \d+ms/)
  })

  it('explains itself and tells the operator how to resume', async () => {
    const store = new AutoContinuationStore(await project())
    await scheduleDue(store, 'sess-abc')
    const events: string[] = []
    const scheduler = new AutoScheduler(
      store,
      async () => { throw new Error('verify unavailable') },
      { onEvent: m => events.push(m), isWakeStillRunnable: async () => false },
    )
    await scheduler.tickOnce()

    const log = events.join('\n')
    expect(log).toMatch(/fences no longer pass/)
    expect(log).toMatch(/NOT retrying/)
    expect(log).toMatch(/--resume sess-abc/)
    expect(log).toMatch(/verify unavailable/)   // the real cause survives
  })

  it('still retries when the fences DO pass', async () => {
    // A genuine pre-turn failure must keep its retry. Suppressing those would
    // strand recoverable wakes — the opposite harm.
    const store = new AutoContinuationStore(await project())
    const record = await scheduleDue(store)
    const scheduler = new AutoScheduler(
      store,
      async () => { throw new Error('transient: session store unreadable') },
      { retryBaseMs: 5_000, isWakeStillRunnable: async () => true },
    )
    await scheduler.tickOnce()
    expect(await statusOf(store, record.wakeId)).toBe('pending')
  })

  it('retries when the probe itself throws', async () => {
    // "Cannot tell" must fall back to the previous behaviour, not to refusing.
    const store = new AutoContinuationStore(await project())
    const record = await scheduleDue(store)
    const scheduler = new AutoScheduler(
      store,
      async () => { throw new Error('transient') },
      {
        retryBaseMs: 5_000,
        isWakeStillRunnable: async () => { throw new Error('probe exploded') },
      },
    )
    await scheduler.tickOnce()
    expect(await statusOf(store, record.wakeId)).toBe('pending')
  })

  it('behaves exactly as before when no probe is injected', async () => {
    const store = new AutoContinuationStore(await project())
    const record = await scheduleDue(store)
    const scheduler = new AutoScheduler(
      store,
      async () => { throw new Error('transient') },
      { retryBaseMs: 5_000 },
    )
    await scheduler.tickOnce()
    expect(await statusOf(store, record.wakeId)).toBe('pending')
  })

  it('does not consult the probe for an already-tagged consumed wake', async () => {
    // AutoWakeConsumedError is conclusive on its own; the probe is a fallback,
    // so a probe outage must not be able to turn that path into a retry.
    const store = new AutoContinuationStore(await project())
    const record = await scheduleDue(store)
    let probed = 0
    const scheduler = new AutoScheduler(
      store,
      async () => { throw new AutoWakeConsumedError('s1', new Error('boom')) },
      {
        retryBaseMs: 1,
        isWakeStillRunnable: async () => { probed++; return true },
      },
    )
    await scheduler.tickOnce()
    expect(probed).toBe(0)
    expect(await statusOf(store, record.wakeId)).toBe('done')
  })
})

describe('normal outcomes', () => {
  it('a done resume marks the wake done', async () => {
    const store = new AutoContinuationStore(await project())
    const record = await scheduleDue(store)
    const scheduler = new AutoScheduler(store, async () => 'done', {})
    await scheduler.tickOnce()
    expect(await statusOf(store, record.wakeId)).toBe('done')
  })

  it('a cancelled resume marks the wake cancelled', async () => {
    // Cancellation from the RESUME path is legitimate (stale fence detected
    // before running anything); only the retry-driven cancel was the bug.
    const store = new AutoContinuationStore(await project())
    const record = await scheduleDue(store)
    const scheduler = new AutoScheduler(store, async () => 'cancelled', {})
    await scheduler.tickOnce()
    expect(await statusOf(store, record.wakeId)).toBe('cancelled')
  })

  it('does not claim a wake that is not yet due', async () => {
    const store = new AutoContinuationStore(await project())
    await store.schedule({
      sessionId: 's1',
      fireAt: Date.now() + 60_000,
      reason: 'later',
      historyMessageCount: 1,
    })
    let calls = 0
    const scheduler = new AutoScheduler(store, async () => { calls++; return 'done' }, {})
    expect(await scheduler.tickOnce()).toBe(0)
    expect(calls).toBe(0)
  })

  it('respects maxConcurrent', async () => {
    const store = new AutoContinuationStore(await project())
    await scheduleDue(store, 'a')
    await scheduleDue(store, 'b')
    await scheduleDue(store, 'c')
    let inFlight = 0
    let peak = 0
    const scheduler = new AutoScheduler(
      store,
      async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise(r => setTimeout(r, 15))
        inFlight--
        return 'done'
      },
      { maxConcurrent: 2 },
    )
    await scheduler.tickOnce()
    expect(peak).toBeLessThanOrEqual(2)
  })
})

describe('AutoWakeConsumedError', () => {
  it('carries the session id and the original cause', () => {
    const cause = new Error('original failure')
    const err = new AutoWakeConsumedError('sess-1', cause)
    expect(err.sessionId).toBe('sess-1')
    expect(err.cause).toBe(cause)
    expect(err.name).toBe('AutoWakeConsumedError')
    expect(err.message).toContain('sess-1')
    expect(err.message).toContain('original failure')
  })

  it('tolerates a non-Error cause', () => {
    expect(new AutoWakeConsumedError('s', 'plain string').message).toContain('plain string')
  })
})
