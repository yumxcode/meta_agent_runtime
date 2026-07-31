import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { AutoContinuationStore } from '../AutoContinuationStore.js'
import { AutoScheduler } from '../AutoScheduler.js'
import { AttachedAutoScheduler } from '../AttachedAutoScheduler.js'

const dirs: string[] = []

async function makeStore(claimTtlMs = 1_000): Promise<AutoContinuationStore> {
  const dir = await mkdtemp(join(tmpdir(), 'auto-continuation-'))
  dirs.push(dir)
  return new AutoContinuationStore(dir, { claimTtlMs })
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('AutoContinuationStore', () => {
  it('coalesces pending timers and atomically claims one per session', async () => {
    const store = await makeStore()
    const first = await store.schedule({
      sessionId: 's1',
      fireAt: 100,
      reason: 'first',
      historyMessageCount: 3,
    })
    const replaced = await store.schedule({
      sessionId: 's1',
      fireAt: 200,
      reason: 'replacement',
      historyMessageCount: 5,
    })
    expect(replaced.wakeId).toBe(first.wakeId)
    expect((await store.list()).filter(r => r.status === 'pending')).toHaveLength(1)

    expect(await store.claimDue(199)).toEqual([])
    const claimed = await store.claimDue(200)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.claim?.token).toBeTruthy()
    expect(await store.claimDue(200)).toEqual([])

    const token = claimed[0]!.claim!.token
    expect(await store.release(claimed[0]!.wakeId, token, 'done')).toBe(true)
    expect((await store.list())[0]?.status).toBe('done')
  })

  it('recovers an expired claim after scheduler crash', async () => {
    const store = await makeStore(100)
    await store.schedule({
      sessionId: 's1',
      fireAt: 10,
      reason: 'wake',
      historyMessageCount: 1,
    })
    const [claim] = await store.claimDue(10)
    expect(claim?.status).toBe('claimed')
    const healed = await store.reconcileOrphans(111)
    expect(healed).toHaveLength(1)
    expect(healed[0]?.status).toBe('pending')
  })

  it('can atomically schedule a wake already leased to an attached host', async () => {
    const store = await makeStore()
    const record = await store.schedule({
      sessionId: 's1',
      fireAt: 10,
      reason: 'wake',
      historyMessageCount: 1,
    }, {
      claimOwner: 'attached-owner',
      now: 1,
    })

    expect(record.status).toBe('claimed')
    expect(record.claim?.owner).toBe('attached-owner')
    expect(record.attempts).toBe(1)
    expect(await store.claimDue(10, 'daemon')).toEqual([])

    expect(await store.release(
      record.wakeId,
      record.claim!.token,
      'pending',
    )).toBe(true)
    expect(await store.claimDue(10, 'daemon')).toHaveLength(1)
  })

  it('cancels only the requested wake, not another claim for the session', async () => {
    const store = await makeStore()
    const claimed = await store.schedule({
      sessionId: 's1',
      fireAt: 10,
      reason: 'first',
      historyMessageCount: 1,
    }, { claimOwner: 'attached-owner', now: 1 })
    const pending = await store.schedule({
      sessionId: 's1',
      fireAt: 20,
      reason: 'second',
      historyMessageCount: 2,
    })

    expect(await store.cancel(pending.wakeId)).toBe(true)
    const records = await store.list()
    expect(records.find(record => record.wakeId === pending.wakeId)?.status).toBe('cancelled')
    expect(records.find(record => record.wakeId === claimed.wakeId)?.status).toBe('claimed')
  })
})

describe('AutoScheduler', () => {
  it('runs a due continuation and releases its claim', async () => {
    const store = await makeStore()
    await store.schedule({
      sessionId: 's1',
      fireAt: 10,
      reason: 'wake',
      historyMessageCount: 1,
    })
    const seen: string[] = []
    const scheduler = new AutoScheduler(store, async record => {
      seen.push(record.sessionId)
      return 'done'
    })
    expect(await scheduler.tickOnce(10)).toBe(1)
    expect(seen).toEqual(['s1'])
    expect((await store.list())[0]?.status).toBe('done')
  })

  it('requeues failures with bounded backoff', async () => {
    const store = await makeStore()
    await store.schedule({
      sessionId: 's1',
      fireAt: 10,
      reason: 'wake',
      historyMessageCount: 1,
    })
    const scheduler = new AutoScheduler(
      store,
      async () => { throw new Error('provider down') },
      { retryBaseMs: 100 },
    )
    expect(await scheduler.tickOnce(10)).toBe(1)
    const [record] = await store.list()
    expect(record?.status).toBe('pending')
    expect(record?.fireAt).toBeGreaterThan(Date.now())
  })
})

describe('AttachedAutoScheduler', () => {
  it('keeps the same host attached across repeated timer wakes', async () => {
    const store = await makeStore()
    const first = await store.schedule({
      sessionId: 's1',
      fireAt: 0,
      reason: 'first',
      historyMessageCount: 1,
    }, { claimOwner: 'attached-owner', now: 0 })
    const seen: string[] = []
    const scheduler = new AttachedAutoScheduler(
      store,
      async record => {
        seen.push(record.reason)
        if (record.reason === 'first') {
          const next = await store.schedule({
            sessionId: 's1',
            fireAt: 0,
            reason: 'second',
            historyMessageCount: 2,
          }, { claimOwner: 'attached-owner', now: 0 })
          return { outcome: 'done', next }
        }
        return { outcome: 'done' }
      },
      { heartbeatIntervalMs: 10 },
    )

    await expect(scheduler.run(first, new AbortController().signal))
      .resolves.toBe('completed')
    expect(seen).toEqual(['first', 'second'])
    expect((await store.list()).map(record => record.status)).toEqual(['done', 'done'])
  })

  it('detaches on abort and leaves the wake available to a daemon', async () => {
    const store = await makeStore()
    const record = await store.schedule({
      sessionId: 's1',
      fireAt: Date.now() + 60_000,
      reason: 'later',
      historyMessageCount: 1,
    }, { claimOwner: 'attached-owner' })
    const abort = new AbortController()
    const scheduler = new AttachedAutoScheduler(
      store,
      async () => ({ outcome: 'done' }),
      { heartbeatIntervalMs: 10 },
    )

    const running = scheduler.run(record, abort.signal)
    abort.abort('test detach')
    await expect(running).resolves.toBe('detached')
    const [released] = await store.list()
    expect(released?.status).toBe('pending')
    expect(released?.claim).toBeUndefined()
  })

  it('cancels a wake when Ctrl+C abandons an active resumed turn', async () => {
    const store = await makeStore()
    const record = await store.schedule({
      sessionId: 's1',
      fireAt: 0,
      reason: 'now',
      historyMessageCount: 1,
    }, { claimOwner: 'attached-owner' })
    const abort = new AbortController()
    const scheduler = new AttachedAutoScheduler(
      store,
      async (_record, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('interrupted')), {
          once: true,
        })
      }),
      {
        heartbeatIntervalMs: 10,
        cancelActiveAbort: reason => reason === 'user-cancel',
      },
    )

    const running = scheduler.run(record, abort.signal)
    await new Promise(resolve => setTimeout(resolve, 10))
    abort.abort('user-cancel')
    await expect(running).resolves.toBe('cancelled')
    const [cancelled] = await store.list()
    expect(cancelled?.status).toBe('cancelled')
    expect(await store.claimDue(Date.now(), 'daemon')).toEqual([])
  })

  it('renews the wake lease while the resumed model turn is running', async () => {
    const store = await makeStore(30)
    const record = await store.schedule({
      sessionId: 's1',
      fireAt: 0,
      reason: 'now',
      historyMessageCount: 1,
    }, { claimOwner: 'attached-owner' })
    const scheduler = new AttachedAutoScheduler(
      store,
      async () => {
        await new Promise(resolve => setTimeout(resolve, 70))
        return { outcome: 'done' }
      },
      { heartbeatIntervalMs: 10 },
    )

    const running = scheduler.run(record, new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 45))
    expect(await store.reconcileOrphans()).toEqual([])
    await expect(running).resolves.toBe('completed')
  })
})
