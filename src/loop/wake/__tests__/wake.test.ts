import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { WakeStore } from '../WakeStore.js'

async function freshStore(claimTtlMs = 60_000) {
  const dir = await mkdtemp(join(tmpdir(), 'loop-wake-'))
  return new WakeStore(dir, { claimTtlMs })
}

describe('WakeStore', () => {
  it('schedules and claims due wakes; future wakes stay pending', async () => {
    const store = await freshStore()
    await store.schedule({ loopId: 'L1', kind: 'timer', fireAt: 100 })
    await store.schedule({ loopId: 'L2', kind: 'timer', fireAt: 9_999_999 })
    const claimed = await store.claimDue(200)
    expect(claimed.map(w => w.loopId)).toEqual(['L1'])
    const all = await store.list()
    expect(all.find(w => w.loopId === 'L2')!.status).toBe('pending')
  })

  it('coalesces pending timers per loop (missed ticks merge)', async () => {
    const store = await freshStore()
    const a = await store.schedule({ loopId: 'L1', kind: 'timer', fireAt: 100 })
    const b = await store.schedule({ loopId: 'L1', kind: 'timer', fireAt: 500 })
    expect(b.wakeId).toBe(a.wakeId)          // replaced, not queued
    expect((await store.list()).filter(w => w.status === 'pending')).toHaveLength(1)
    // Manual wakes never coalesce.
    await store.schedule({ loopId: 'L1', kind: 'manual', fireAt: 100 })
    await store.schedule({ loopId: 'L1', kind: 'manual', fireAt: 100 })
    expect((await store.list()).filter(w => w.kind === 'manual')).toHaveLength(2)
  })

  it('enforces at-most-one live claim per loop', async () => {
    const store = await freshStore()
    await store.schedule({ loopId: 'L1', kind: 'manual', fireAt: 100 })
    await store.schedule({ loopId: 'L1', kind: 'manual', fireAt: 100 })
    const first = await store.claimDue(200)
    expect(first).toHaveLength(1)
    // Second sweep: loop already has a live claim → nothing claimable.
    expect(await store.claimDue(200)).toHaveLength(0)
    await store.release(first[0]!.wakeId, 'done', { claimToken: first[0]!.claim!.token })
    expect(await store.claimDue(200)).toHaveLength(1)
  })

  it('reconcileOrphans returns expired claims to pending', async () => {
    const store = await freshStore(1_000)
    await store.schedule({ loopId: 'L1', kind: 'timer', fireAt: 0 })
    const [claimed] = await store.claimDue(100)
    expect(claimed!.status).toBe('claimed')
    // TTL 1s — at t=5000 the claim is orphaned (simulated kill -9).
    const healed = await store.reconcileOrphans(5_000)
    expect(healed).toHaveLength(1)
    expect(healed[0]!.status).toBe('pending')
    expect((await store.claimDue(5_001)).length).toBe(1)
    expect(healed[0]!.attempts).toBe(1) // attempts survive the heal (audit)
  })

  it('heartbeat extends a live claim so it is NOT reconciled', async () => {
    const store = await freshStore(1_000)
    await store.schedule({ loopId: 'L1', kind: 'timer', fireAt: 0 })
    const [claimed] = await store.claimDue(100)
    await store.heartbeat(claimed!.wakeId, 900, claimed!.claim!.token)
    expect(await store.reconcileOrphans(1_500)).toHaveLength(0)   // extended to 1900
    expect((await store.reconcileOrphans(2_000)).length).toBe(1)  // expired now
  })

  it('release(pending) re-queues for retry; cancelForLoop sweeps everything live', async () => {
    const store = await freshStore()
    await store.schedule({ loopId: 'L1', kind: 'timer', fireAt: 0 })
    const [claimed] = await store.claimDue(100)
    await store.release(claimed!.wakeId, 'pending', { claimToken: claimed!.claim!.token })
    expect((await store.list())[0]!.status).toBe('pending')
    expect(await store.cancelForLoop('L1')).toBe(1)
    expect(await store.claimDue(200)).toHaveLength(0)
  })

  it('prune removes old terminal records only', async () => {
    const store = await freshStore()
    await store.schedule({ loopId: 'L1', kind: 'timer', fireAt: 0 })
    const [claimed] = await store.claimDue(100)
    await store.release(claimed!.wakeId, 'done', { claimToken: claimed!.claim!.token })
    await store.schedule({ loopId: 'L2', kind: 'timer', fireAt: 0 })
    expect(await store.prune(0)).toBe(1)
    expect(await store.list()).toHaveLength(1) // L2 pending survives
  })

  it('concurrent claimDue sweeps never double-claim (lock contention)', async () => {
    const store = await freshStore()
    for (let i = 0; i < 5; i++) {
      await store.schedule({ loopId: `L${i}`, kind: 'manual', fireAt: 0 })
    }
    const sweeps = await Promise.all([
      store.claimDue(100, 'owner-a'),
      store.claimDue(100, 'owner-b'),
      store.claimDue(100, 'owner-c'),
    ])
    const claimedIds = sweeps.flat().map(w => w.wakeId)
    expect(new Set(claimedIds).size).toBe(claimedIds.length) // no duplicates
    expect(claimedIds).toHaveLength(5)                        // and none lost
  })

  it('fences a stale owner after an expired wake is reclaimed', async () => {
    const store = await freshStore(1_000)
    await store.schedule({ loopId: 'L1', kind: 'timer', fireAt: 0 })
    const [first] = await store.claimDue(100, 'owner-a')
    await store.reconcileOrphans(2_000)
    const [second] = await store.claimDue(2_001, 'owner-b')
    expect(second!.claim!.token).not.toBe(first!.claim!.token)
    expect(await store.heartbeat(first!.wakeId, 2_100, first!.claim!.token)).toBe(false)
    expect(await store.release(first!.wakeId, 'done', { claimToken: first!.claim!.token })).toBe(false)
    await expect(store.cancelForLoop('L1', {
      wakeId: first!.wakeId, claimToken: first!.claim!.token!,
    })).rejects.toThrow(/no longer owned/)
    expect((await store.list())[0]).toMatchObject({
      status: 'claimed', claim: { owner: 'owner-b', token: second!.claim!.token },
    })
  })
})
