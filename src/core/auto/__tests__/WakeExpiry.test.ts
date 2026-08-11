/**
 * Wake expiry, retention pruning, and scheduler idle exit.
 *
 * All three come from one observed failure: a workspace accumulated 28 wake
 * records — 27 long-finished, 1 `pending` that had come due nine hours earlier
 * and would never run because the scheduler for that project was gone.
 *
 *   - nothing ever expired a wake, so a dead project's queue stayed "live"
 *     forever and would resume a session whose premise had long evaporated
 *   - `prune()` existed but had NO caller, so terminal records piled up and were
 *     re-read under the store lock on every single poll
 *   - `run()` looped forever, so a scheduler sat in an empty workspace holding a
 *     terminal tab open with nothing to do
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AutoContinuationStore,
  isTerminalWakeStatus,
  type AutoContinuationStatus,
} from '../AutoContinuationStore.js'
import { AutoScheduler } from '../AutoScheduler.js'

const DAY = 24 * 60 * 60_000
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wake-expiry-'))
  dirs.push(dir)
  return dir
}

function storeFor(dir: string, staleWakeMs?: number): AutoContinuationStore {
  return new AutoContinuationStore(dir, staleWakeMs === undefined ? {} : { staleWakeMs })
}

/** Schedule a wake whose fireAt is `agoMs` in the past (negative = future). */
async function scheduleAgo(
  store: AutoContinuationStore,
  agoMs: number,
  sessionId = `s-${Math.random().toString(36).slice(2, 8)}`,
) {
  return store.schedule({
    sessionId,
    fireAt: Date.now() - agoMs,
    reason: 'test wake',
    historyMessageCount: 1,
  })
}

const statusOf = async (store: AutoContinuationStore, wakeId: string): Promise<AutoContinuationStatus | undefined> =>
  (await store.list()).find(r => r.wakeId === wakeId)?.status

describe('isTerminalWakeStatus', () => {
  it('treats done / cancelled / expired as terminal', () => {
    expect(isTerminalWakeStatus('done')).toBe(true)
    expect(isTerminalWakeStatus('cancelled')).toBe(true)
    expect(isTerminalWakeStatus('expired')).toBe(true)
  })

  it('does not treat live states as terminal', () => {
    expect(isTerminalWakeStatus('pending')).toBe(false)
    expect(isTerminalWakeStatus('claimed')).toBe(false)
  })
})

describe('expireStale', () => {
  it('retires a wake that came due more than 7 days ago', async () => {
    const store = storeFor(await project())
    const record = await scheduleAgo(store, 8 * DAY)
    const expired = await store.expireStale()
    expect(expired.map(r => r.wakeId)).toEqual([record.wakeId])
    expect(await statusOf(store, record.wakeId)).toBe('expired')
  })

  it('keeps a wake that came due recently', async () => {
    const store = storeFor(await project())
    const record = await scheduleAgo(store, 6 * DAY)
    expect(await store.expireStale()).toEqual([])
    expect(await statusOf(store, record.wakeId)).toBe('pending')
  })

  it('measures from fireAt, not createdAt — a far-future wake is never stale', async () => {
    // Scheduling something two weeks out is legitimate; it must not be retired
    // just because the window is 7 days.
    const store = storeFor(await project())
    const record = await scheduleAgo(store, -14 * DAY)
    expect(await store.expireStale()).toEqual([])
    expect(await statusOf(store, record.wakeId)).toBe('pending')
  })

  it('leaves a CLAIMED record alone however old it looks', async () => {
    // Someone may be mid-flight on it; reconcileOrphans releases a dead claim
    // back to pending first, and only then does expiry apply.
    const dir = await project()
    const store = storeFor(dir)
    const record = await store.schedule(
      { sessionId: 's1', fireAt: Date.now() - 9 * DAY, reason: 'r', historyMessageCount: 1 },
      { claimOwner: 'someone' },
    )
    expect(await store.expireStale()).toEqual([])
    expect(await statusOf(store, record.wakeId)).toBe('claimed')
  })

  it('does nothing when the window is disabled', async () => {
    const store = storeFor(await project(), 0)
    const record = await scheduleAgo(store, 100 * DAY)
    expect(await store.expireStale()).toEqual([])
    expect(await statusOf(store, record.wakeId)).toBe('pending')
  })

  it('retires several stale wakes in one sweep', async () => {
    const store = storeFor(await project())
    await scheduleAgo(store, 8 * DAY, 'a')
    await scheduleAgo(store, 9 * DAY, 'b')
    await scheduleAgo(store, 1 * DAY, 'c')
    expect((await store.expireStale()).map(r => r.sessionId).sort()).toEqual(['a', 'b'])
  })
})

describe('claimDue applies the same rule lazily', () => {
  it('REGRESSION: an ancient due wake is retired, NOT executed', async () => {
    // This is the observed incident: a wake due nine hours ago (here: nine
    // days) that a restarted scheduler would otherwise happily resume.
    const store = storeFor(await project())
    const record = await scheduleAgo(store, 9 * DAY)
    expect(await store.claimDue()).toEqual([])
    expect(await statusOf(store, record.wakeId)).toBe('expired')
  })

  it('still claims a wake that is due but fresh', async () => {
    const store = storeFor(await project())
    const record = await scheduleAgo(store, 60_000)
    const claimed = await store.claimDue()
    expect(claimed.map(r => r.wakeId)).toEqual([record.wakeId])
  })

  it('expires stale records even when the concurrency limit is already reached', async () => {
    // The expiry check runs before the `limit` break, so a backlog cannot hide
    // stale records behind the cap forever.
    const store = storeFor(await project())
    await scheduleAgo(store, 60_000, 'fresh-1')
    const stale = await scheduleAgo(store, 30 * DAY, 'ancient')
    await store.claimDue(Date.now(), undefined, 1)
    expect(await statusOf(store, stale.wakeId)).toBe('expired')
  })
})

describe('prune', () => {
  it('deletes terminal records past the retention window', async () => {
    const dir = await project()
    const store = storeFor(dir)
    const record = await scheduleAgo(store, 8 * DAY)
    await store.expireStale()
    expect(await store.prune(DAY, Date.now() + 2 * DAY)).toBe(1)
    expect((await store.list()).find(r => r.wakeId === record.wakeId)).toBeUndefined()
  })

  it('removes the file from disk, not just the record', async () => {
    const dir = await project()
    const store = storeFor(dir)
    await scheduleAgo(store, 8 * DAY)
    await store.expireStale()
    await store.prune(DAY, Date.now() + 2 * DAY)
    const files = await readdir(join(dir, '.meta-agent', 'auto', 'wakes')).catch(() => [])
    expect(files.filter(f => f.endsWith('.json'))).toEqual([])
  })

  it('keeps a LIVE record no matter how old', async () => {
    const store = storeFor(await project(), 0)   // expiry off, so it stays pending
    const record = await scheduleAgo(store, 100 * DAY)
    expect(await store.prune(DAY, Date.now() + 200 * DAY)).toBe(0)
    expect(await statusOf(store, record.wakeId)).toBe('pending')
  })

  it('keeps a terminal record still inside the window', async () => {
    const store = storeFor(await project())
    const record = await scheduleAgo(store, 1 * DAY)
    await store.release(record.wakeId, record.claim?.token, 'done')
      .catch(() => undefined)
    // Freshly settled — the retention window has barely started.
    expect(await store.prune(7 * DAY)).toBe(0)
  })

  it('ages an EXPIRED record from its fireAt, not from the moment it was retired', async () => {
    // expireStale stamps updatedAt = now as it retires the record. An
    // updatedAt-based retention rule therefore reset the clock on exactly the
    // records the sweep exists to remove: the CLI runs expireStale() and then
    // prune(), so prune could never delete anything expireStale had just
    // marked, and the queue this whole feature was built to shrink never
    // shrank. fireAt is the honest "stopped being live" timestamp.
    const store = storeFor(await project())
    await scheduleAgo(store, 30 * DAY)
    const expired = await store.expireStale()
    expect(expired).toHaveLength(1)
    expect(expired[0]!.updatedAt).toBeGreaterThan(Date.now() - 5_000)   // stamped now
    expect(await store.prune(7 * DAY)).toBe(1)                          // pruned anyway
    expect(await store.list()).toEqual([])
  })

  it('an expired record inside the retention window is still kept', async () => {
    const store = storeFor(await project())
    await scheduleAgo(store, 8 * DAY)          // stale enough to expire…
    await store.expireStale()
    expect(await store.prune(30 * DAY)).toBe(0) // …but not old enough to prune
  })
})

describe('scheduler idle exit', () => {
  it('exits once the queue holds no live work', async () => {
    const store = storeFor(await project())
    const scheduler = new AutoScheduler(store, async () => 'done', {
      pollIntervalMs: 50,
      idleExitMs: 60,
    })
    const started = Date.now()
    expect(await scheduler.run(new AbortController().signal)).toBe('idle')
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('announces why it stopped', async () => {
    const store = storeFor(await project())
    const events: string[] = []
    const scheduler = new AutoScheduler(store, async () => 'done', {
      pollIntervalMs: 50, idleExitMs: 60, onEvent: m => events.push(m),
    })
    await scheduler.run(new AbortController().signal)
    expect(events.join('\n')).toMatch(/no wakes left/)
  })

  it('does NOT exit while a future wake is still queued', async () => {
    // "Idle" means the queue is empty, not "nothing is due this second" — a
    // session parked 55 minutes out must keep its scheduler alive.
    const store = storeFor(await project())
    await scheduleAgo(store, -60 * 60_000)          // due in an hour
    const abort = new AbortController()
    const scheduler = new AutoScheduler(store, async () => 'done', {
      pollIntervalMs: 20, idleExitMs: 40,
    })
    const run = scheduler.run(abort.signal)
    await new Promise(r => setTimeout(r, 200))      // well past idleExitMs
    abort.abort()
    expect(await run).toBe('aborted')
  })

  it('exits after the queue drains, not before', async () => {
    const store = storeFor(await project())
    await scheduleAgo(store, 60_000)
    let ran = 0
    const scheduler = new AutoScheduler(store, async () => { ran++; return 'done' }, {
      pollIntervalMs: 20, idleExitMs: 60,
    })
    expect(await scheduler.run(new AbortController().signal)).toBe('idle')
    expect(ran).toBe(1)                              // the due wake still executed
  })

  it('never exits on idle when the feature is disabled', async () => {
    const store = storeFor(await project())
    const abort = new AbortController()
    const scheduler = new AutoScheduler(store, async () => 'done', {
      pollIntervalMs: 20, idleExitMs: 0,
    })
    const run = scheduler.run(abort.signal)
    await new Promise(r => setTimeout(r, 150))
    abort.abort()
    expect(await run).toBe('aborted')
  })

  it('an abort still reports "aborted" even on an empty queue', async () => {
    const store = storeFor(await project())
    const abort = new AbortController()
    abort.abort()
    const scheduler = new AutoScheduler(store, async () => 'done', { idleExitMs: 60 })
    expect(await scheduler.run(abort.signal)).toBe('aborted')
  })
})
