/**
 * AutoScheduler — `maxConcurrent` must be a CONCURRENCY CEILING, not a batch size.
 *
 * The bug these tests pin: `tickOnce` used to `await Promise.all([...active])`
 * before returning, and `run()` awaited `tickOnce`. So `this.active` was always
 * empty at the top of a poll, `maxConcurrent - active.size` was a constant, and
 * — the part that actually hurt — a wake that came due while an earlier one was
 * still running could not start until the whole batch drained. Measured on the
 * pre-fix code: an URGENT wake armed 300ms into a 2s claim did not start until
 * 2081ms, with three of four slots idle the entire time.
 *
 * That matters because an auto wake is a whole agent turn. Minutes, not
 * milliseconds. One long-running session in a workspace stalled every other
 * session's timer behind it.
 *
 * `src/loop/daemon.ts` implements the same pattern correctly (non-blocking
 * `inFlight` map); these tests hold AutoScheduler to that same contract.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoContinuationStore } from '../AutoContinuationStore.js'
import { AutoScheduler } from '../AutoScheduler.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'auto-sched-conc-'))
  dirs.push(dir)
  return dir
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function scheduleDue(
  store: AutoContinuationStore,
  sessionId: string,
  fireAt = Date.now() - 1_000,
): Promise<void> {
  await store.schedule({ sessionId, fireAt, reason: `wake for ${sessionId}`, historyMessageCount: 1 })
}

describe('AutoScheduler concurrency', () => {
  it('starts a newly-due wake while an earlier one is still running', async () => {
    const store = new AutoContinuationStore(await project())
    await scheduleDue(store, 'SLOW')

    const started: Array<{ id: string; at: number }> = []
    const t0 = Date.now()
    const scheduler = new AutoScheduler(
      store,
      async record => {
        started.push({ id: record.sessionId, at: Date.now() - t0 })
        await sleep(record.sessionId === 'SLOW' ? 600 : 5)
        return 'done'
      },
      { pollIntervalMs: 20, maxConcurrent: 4, idleExitMs: 150 },
    )

    // Arm URGENT well INSIDE the SLOW claim's runtime.
    const armed = sleep(120).then(() => scheduleDue(store, 'URGENT'))

    const abort = new AbortController()
    const guard = setTimeout(() => abort.abort(), 10_000)
    const reason = await scheduler.run(abort.signal)
    clearTimeout(guard)
    await armed

    expect(reason).toBe('idle')
    const slow = started.find(s => s.id === 'SLOW')
    const urgent = started.find(s => s.id === 'URGENT')
    expect(slow).toBeDefined()
    expect(urgent).toBeDefined()

    // THE ASSERTION. Pre-fix this was ~600ms (it waited out the whole SLOW
    // claim); the fix makes it one poll interval after the wake was armed.
    // 400ms leaves generous slack for a loaded CI box while still failing
    // loudly if the drain-before-return behaviour ever comes back.
    expect(urgent!.at).toBeLessThan(400)
    expect(slow!.at).toBeLessThan(100)
  })

  it('never runs more than maxConcurrent claims at once', async () => {
    const store = new AutoContinuationStore(await project())
    for (let i = 0; i < 6; i++) await scheduleDue(store, `s${i}`)

    let inFlight = 0
    let peak = 0
    const scheduler = new AutoScheduler(
      store,
      async () => {
        peak = Math.max(peak, ++inFlight)
        await sleep(40)
        inFlight--
        return 'done'
      },
      { pollIntervalMs: 10, maxConcurrent: 2, idleExitMs: 120 },
    )

    const abort = new AbortController()
    const guard = setTimeout(() => abort.abort(), 10_000)
    await scheduler.run(abort.signal)
    clearTimeout(guard)

    expect(peak).toBe(2)
    expect(peak).toBeLessThanOrEqual(2)
    // All six still got their turn — a ceiling, not a cap on total work.
    const records = await store.list()
    expect(records.filter(r => r.status === 'done')).toHaveLength(6)
  })

  it('claims within one batch run in parallel, not serially', async () => {
    const store = new AutoContinuationStore(await project())
    await scheduleDue(store, 'a')
    await scheduleDue(store, 'b')
    await scheduleDue(store, 'c')

    // Assert on when each claim STARTED rather than on total wall time: total
    // time also contains the idle-exit window and the poll interval, which made
    // the bound flaky on a loaded box for no diagnostic gain.
    const starts: number[] = []
    const t0 = Date.now()
    const scheduler = new AutoScheduler(
      store,
      async () => { starts.push(Date.now() - t0); await sleep(120); return 'done' },
      { pollIntervalMs: 10, maxConcurrent: 3, idleExitMs: 100 },
    )
    const abort = new AbortController()
    const guard = setTimeout(() => abort.abort(), 10_000)
    await scheduler.run(abort.signal)
    clearTimeout(guard)

    expect(starts).toHaveLength(3)
    // Serialised execution would start them ~120ms apart. Parallel dispatch
    // starts all three in the same tick.
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(60)
  })

  it('tickOnce still WAITS for its batch — `--once` must not fire-and-forget', async () => {
    const store = new AutoContinuationStore(await project())
    await scheduleDue(store, 'x')
    let finished = false

    const scheduler = new AutoScheduler(
      store,
      async () => { await sleep(60); finished = true; return 'done' },
      { maxConcurrent: 2 },
    )
    const claimed = await scheduler.tickOnce()

    expect(claimed).toBe(1)
    // If tickOnce had become non-blocking, `--once` would exit here mid-turn.
    expect(finished).toBe(true)
    expect((await store.list())[0]?.status).toBe('done')
  })

  it('drains in-flight claims on abort instead of orphaning them as `claimed`', async () => {
    const store = new AutoContinuationStore(await project())
    await scheduleDue(store, 'slow')

    const abort = new AbortController()
    const scheduler = new AutoScheduler(
      store,
      async () => { await sleep(150); return 'done' },
      { pollIntervalMs: 10, maxConcurrent: 2 },
    )
    const running = scheduler.run(abort.signal)
    await sleep(60)          // let the claim start
    abort.abort()
    expect(await running).toBe('aborted')

    // The claim was released, not left mid-flight for reconcileOrphans to
    // time out ten minutes later.
    expect((await store.list())[0]?.status).toBe('done')
  })

  it('a throwing release() cannot escape as an unhandled rejection', async () => {
    const store = new AutoContinuationStore(await project())
    await scheduleDue(store, 'boom')

    // runClaim already funnels a throwing HANDLER into its retry path, so the
    // only way out of runClaim is a throw from the release itself — a full
    // disk, a permissions change, a lock timeout. Before dispatchDue stopped
    // awaiting these promises that rejection was surfaced by Promise.all; now
    // nothing awaits them, so an unterminated chain becomes unhandledRejection,
    // which the CLI treats as fatal (process.once → disposeAndExit(1)).
    store.release = async () => { throw new Error('disk full during release') }

    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)

    const events: string[] = []
    const scheduler = new AutoScheduler(
      store,
      async () => 'done',
      { pollIntervalMs: 10, maxConcurrent: 1, onEvent: m => events.push(m) },
    )
    try {
      const claimed = await scheduler.dispatchDue()
      expect(claimed).toBe(1)
      await scheduler.drain()
      // Give the microtask queue a beat so a genuinely unhandled rejection
      // would have been reported by now.
      await sleep(50)
    } finally {
      process.off('unhandledRejection', onRejection)
    }

    expect(rejections).toEqual([])
    expect(events.join('\n')).toMatch(/claim handler crashed.*disk full during release/s)
  })
})
