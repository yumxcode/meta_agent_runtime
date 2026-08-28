/**
 * AttachedAutoScheduler — what the operator sees when a wake is rejected.
 *
 * `cancelled` is TERMINAL: the turn never ran and the session will never resume
 * itself. It used to log as `[auto-attached] cancelled <session> (<wake>)` —
 * the same shape as `done` — so a wrongly-rejected wake was indistinguishable
 * from a clean finish, and the ~40 minutes of unattended work behind it looked
 * like it had simply ended. Every terminal rejection must now say why and how
 * to recover.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoContinuationStore, AutoWakeConsumedError } from '../AutoContinuationStore.js'
import { AttachedAutoScheduler } from '../AttachedAutoScheduler.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function claimedWake(store: AutoContinuationStore, sessionId = 'sess-1') {
  return store.schedule(
    {
      sessionId,
      fireAt: Date.now() - 1_000,     // already due
      reason: 'gate check',
      historyMessageCount: 126,
    },
    { claimOwner: 'host#1' },
  )
}

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'attached-auto-'))
  dirs.push(dir)
  return dir
}

describe('a fence rejection is reported, not silently swallowed', () => {
  it('logs the reason and a recovery command on cancelled', async () => {
    const store = new AutoContinuationStore(await project())
    const record = await claimedWake(store)
    const events: string[] = []

    const scheduler = new AttachedAutoScheduler(
      store,
      async () => ({
        outcome: 'cancelled' as const,
        reason: 'history moved on: loaded 125 messages, wake was armed at 126',
      }),
      { onEvent: m => events.push(m), heartbeatIntervalMs: 10 },
    )
    const outcome = await scheduler.run(record, new AbortController().signal)

    expect(outcome).toBe('completed')
    const log = events.join('\n')
    expect(log).toMatch(/history moved on: loaded 125 messages/)
    expect(log).toMatch(/the turn did NOT run/)
    expect(log).toMatch(/--resume sess-1/)
  })

  it('still says something useful when the handler gives no reason', async () => {
    const store = new AutoContinuationStore(await project())
    const record = await claimedWake(store)
    const events: string[] = []

    const scheduler = new AttachedAutoScheduler(
      store,
      async () => ({ outcome: 'cancelled' as const }),
      { onEvent: m => events.push(m), heartbeatIntervalMs: 10 },
    )
    await scheduler.run(record, new AbortController().signal)

    expect(events.join('\n')).toMatch(/no reason given/)
  })

  it('leaves a successful finish unadorned', async () => {
    const store = new AutoContinuationStore(await project())
    const record = await claimedWake(store)
    const events: string[] = []

    const scheduler = new AttachedAutoScheduler(
      store,
      async () => ({ outcome: 'done' as const }),
      { onEvent: m => events.push(m), heartbeatIntervalMs: 10 },
    )
    await scheduler.run(record, new AbortController().signal)

    const done = events.find(m => m.includes('] done '))
    expect(done).toBeDefined()
    expect(done).not.toMatch(/did NOT run|no reason given/)
  })
})

/**
 * The attached path shares `resumeAutoContinuation` with the detached
 * scheduler, so it sees the same AutoWakeConsumedError. Releasing that back to
 * `pending` with its original (already-past) fireAt hands a wake with a dead
 * fence to whichever scheduler claims it next — the 2026-08-27 cancellation,
 * arriving one hop later instead of on the immediate retry.
 */
describe('a wake consumed by a failed turn is retired, not re-queued', () => {
  it('releases as done so no later scheduler can pick it up and cancel the session', async () => {
    const store = new AutoContinuationStore(await project())
    const record = await claimedWake(store)
    const events: string[] = []

    const scheduler = new AttachedAutoScheduler(
      store,
      async () => { throw new AutoWakeConsumedError('sess-1', new Error('verify unavailable')) },
      { onEvent: m => events.push(m), heartbeatIntervalMs: 10 },
    )
    await expect(scheduler.run(record, new AbortController().signal)).rejects.toBeInstanceOf(
      AutoWakeConsumedError,
    )

    const after = (await store.list()).find(r => r.wakeId === record.wakeId)
    expect(after?.status).toBe('done')
  })

  it('explains the retirement and preserves the real cause', async () => {
    const store = new AutoContinuationStore(await project())
    const record = await claimedWake(store)
    const events: string[] = []

    const scheduler = new AttachedAutoScheduler(
      store,
      async () => { throw new AutoWakeConsumedError('sess-1', new Error('verify unavailable')) },
      { onEvent: m => events.push(m), heartbeatIntervalMs: 10 },
    )
    await scheduler.run(record, new AbortController().signal).catch(() => undefined)

    const log = events.join('\n')
    expect(log).toMatch(/wake consumed/)
    expect(log).toMatch(/verify unavailable/)
    expect(log).toMatch(/--resume sess-1/)
  })

  it('still re-queues an ordinary pre-turn failure', async () => {
    // The narrowing must not swallow genuinely retryable failures.
    const store = new AutoContinuationStore(await project())
    const record = await claimedWake(store)

    const scheduler = new AttachedAutoScheduler(
      store,
      async () => { throw new Error('transient: store unreadable') },
      { heartbeatIntervalMs: 10 },
    )
    await scheduler.run(record, new AbortController().signal).catch(() => undefined)

    const after = (await store.list()).find(r => r.wakeId === record.wakeId)
    expect(after?.status).toBe('pending')
  })
})
