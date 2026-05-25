/**
 * JobManager smoke test — no external dependencies.
 *
 * Covers: submit, poll, await, cancel, list, reattach, concurrency queue.
 *
 * Run: cd packages/meta-agent-runtime && npx tsx examples/smoke-test-job-manager.ts
 */

import { JobManager } from '../src/jobs/JobManager.js'
import type { JobHandler, JobProgress } from '../src/jobs/types.js'
import { TERMINAL_STATUSES } from '../src/jobs/types.js'

// ── Harness ────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ⏳  ${name}`)
  try {
    await fn()
    process.stdout.write(`\r  ✅  ${name}\n`)
    passed++
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stdout.write(`\r  ❌  ${name}\n       ${msg}\n`)
    failed++
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** A handler that completes after a given delay with a fixed output. */
function makeDelayedHandler(delayMs: number, output: Record<string, unknown> = {}): JobHandler {
  return async (_input, _ctx, report) => {
    await sleep(delayMs / 2)
    report({ percent: 50, currentStep: 'halfway' })
    await sleep(delayMs / 2)
    return { output, summary: 'done', artifacts: [] }
  }
}

/** A handler that respects cancellation via AbortSignal. */
const cancellableHandler: JobHandler = async (_input, ctx, report) => {
  for (let i = 0; i < 20; i++) {
    if (ctx.abortSignal.aborted) {
      throw new Error('AbortError')
    }
    report({ percent: i * 5, currentStep: `step ${i}` })
    await sleep(20)
  }
  return { output: {}, summary: 'should not reach', artifacts: [] }
}

/** A handler that always throws. */
const failingHandler: JobHandler = async () => {
  await sleep(10)
  throw new Error('deliberate failure')
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nJobManager smoke tests\n')

  const sessionId = `smoke-${Date.now()}`

  // ── 1: submit + poll + await ─────────────────────────────────────────────
  await test('submit() returns jobId immediately', async () => {
    const mgr = new JobManager(sessionId)
    const id = await mgr.submit('echo', makeDelayedHandler(0), {})
    assert(typeof id === 'string' && id.length > 0, `Expected non-empty jobId, got ${id}`)
  })

  await test('awaitJob() resolves with completed result', async () => {
    const mgr = new JobManager(sessionId)
    const id = await mgr.submit('compute', makeDelayedHandler(50, { x: 42 }), { input: 1 })
    const result = await mgr.awaitJob(id)
    assert(result.status === 'completed', `Expected completed, got ${result.status}`)
    assert((result.output as any)?.x === 42, `Expected output.x=42`)
    assert(result.artifacts.length === 0, 'Expected empty artifacts')
    assert(typeof result.metrics.wallTimeMs === 'number', 'Expected wallTimeMs')
  })

  await test('poll() reflects status transitions', async () => {
    const mgr = new JobManager(sessionId)
    const id = await mgr.submit('sensor', makeDelayedHandler(80), {})
    // Right after submit the job is either submitted or running
    const s0 = await mgr.poll(id)
    assert(['submitted', 'running', 'queued'].includes(s0), `Unexpected initial status: ${s0}`)
    const result = await mgr.awaitJob(id)
    const s1 = await mgr.poll(id)
    assert(s1 === 'completed', `Expected completed after awaitJob, got ${s1}`)
    assert(TERMINAL_STATUSES.has(s1), 'Should be terminal')
  })

  // ── 2: progress callbacks ────────────────────────────────────────────────
  await test('awaitJob() delivers progress events', async () => {
    const mgr = new JobManager(sessionId)
    const id = await mgr.submit('progress-test', makeDelayedHandler(60), {})

    const events: JobProgress[] = []
    const result = await mgr.awaitJob(id, p => events.push(p))

    assert(result.status === 'completed', 'Expected completed')
    assert(events.length >= 1, `Expected at least 1 progress event, got ${events.length}`)
    const fiftyPct = events.find(e => e.percent === 50)
    assert(fiftyPct !== undefined, 'Expected a 50% progress event')
    assert(fiftyPct!.currentStep === 'halfway', 'Expected currentStep = "halfway"')
  })

  // ── 3: failure handling ──────────────────────────────────────────────────
  await test('awaitJob() rejects when handler throws', async () => {
    const mgr = new JobManager(sessionId)
    const id = await mgr.submit('failing-tool', failingHandler, {})

    let rejected = false
    try {
      await mgr.awaitJob(id)
    } catch (err) {
      rejected = true
      assert((err as Error).message === 'deliberate failure', `Unexpected error: ${(err as Error).message}`)
    }
    assert(rejected, 'Expected awaitJob to reject')

    const status = await mgr.poll(id)
    assert(status === 'failed', `Expected failed, got ${status}`)

    const jobs = mgr.list({ status: ['failed'] })
    assert(jobs.some(j => j.jobId === id), 'Failed job should appear in list({ status: ["failed"] })')
  })

  // ── 4: cancellation ──────────────────────────────────────────────────────
  await test('cancel() stops a running job', async () => {
    const mgr = new JobManager(sessionId)
    const id = await mgr.submit('long-sim', cancellableHandler, {})

    // Let it start
    await sleep(30)
    await mgr.cancel(id)

    let threw = false
    try {
      await mgr.awaitJob(id)
    } catch {
      threw = true
    }
    assert(threw, 'Expected awaitJob to reject after cancel')

    const status = await mgr.poll(id)
    assert(status === 'cancelled', `Expected cancelled, got ${status}`)
  })

  await test('cancel() on already-completed job is a no-op', async () => {
    const mgr = new JobManager(sessionId)
    const id = await mgr.submit('quick', makeDelayedHandler(0), {})
    await mgr.awaitJob(id)
    await mgr.cancel(id)  // should not throw
    assert(await mgr.poll(id) === 'completed', 'Status should remain completed')
  })

  // ── 5: list ──────────────────────────────────────────────────────────────
  await test('list() returns all jobs in memory', async () => {
    const mgr = new JobManager(`list-test-${Date.now()}`)
    const id1 = await mgr.submit('tool-a', makeDelayedHandler(0), {}, { domain: 'battery' })
    const id2 = await mgr.submit('tool-b', makeDelayedHandler(0), {}, { domain: 'mechanical' })
    await Promise.all([mgr.awaitJob(id1), mgr.awaitJob(id2)])

    const all = mgr.list()
    assert(all.length === 2, `Expected 2 jobs, got ${all.length}`)

    const battery = mgr.list({ domain: 'battery' })
    assert(battery.length === 1 && battery[0].jobId === id1, 'Domain filter failed')

    const byTool = mgr.list({ toolName: 'tool-b' })
    assert(byTool.length === 1 && byTool[0].jobId === id2, 'toolName filter failed')
  })

  // ── 6: concurrency queue ─────────────────────────────────────────────────
  await test('LocalExecutor queues excess jobs (maxConcurrent=2)', async () => {
    const { LocalExecutor } = await import('../src/jobs/JobExecutor.js')
    const executor = new LocalExecutor(2)  // only 2 concurrent slots
    const mgr = new JobManager(`concurrency-${Date.now()}`, executor)

    // Submit 4 jobs with 60ms delay — slots fill immediately
    const ids = await Promise.all([
      mgr.submit('j1', makeDelayedHandler(60), {}),
      mgr.submit('j2', makeDelayedHandler(60), {}),
      mgr.submit('j3', makeDelayedHandler(60), {}),
      mgr.submit('j4', makeDelayedHandler(60), {}),
    ])

    // After a short wait, j3/j4 should still be queued/submitted (not running yet)
    await sleep(10)
    const statuses = await Promise.all(ids.map(id => mgr.poll(id)))
    const running  = statuses.filter(s => s === 'running').length
    const queued   = statuses.filter(s => s === 'queued' || s === 'submitted').length
    assert(running <= 2, `At most 2 should be running, got ${running}`)
    assert(queued >= 2,  `At least 2 should be queued, got ${queued}`)

    // All should complete eventually
    await Promise.all(ids.map(id => mgr.awaitJob(id)))
    const finalStatuses = await Promise.all(ids.map(id => mgr.poll(id)))
    assert(finalStatuses.every(s => s === 'completed'), `Not all completed: ${finalStatuses}`)
  })

  // ── 7: multiple simultaneous awaiters ────────────────────────────────────
  await test('multiple awaitJob() calls on same job all resolve', async () => {
    const mgr = new JobManager(sessionId)
    const id = await mgr.submit('multi-await', makeDelayedHandler(40, { val: 7 }), {})

    const [r1, r2, r3] = await Promise.all([
      mgr.awaitJob(id),
      mgr.awaitJob(id),
      mgr.awaitJob(id),
    ])
    for (const r of [r1, r2, r3]) {
      assert(r.status === 'completed', `Expected completed, got ${r.status}`)
      assert((r.output as any)?.val === 7, 'Expected val=7')
    }
  })

  // ── 8: reattach ──────────────────────────────────────────────────────────
  await test('reattach() marks interrupted running job as failed', async () => {
    const sid = `reattach-${Date.now()}`
    const { JobStore } = await import('../src/jobs/JobStore.js')

    // Simulate a persisted job that was "running" when process died
    const store = new JobStore(sid)
    const fakeJob = {
      jobId: `generic-sim-deadbeef`,
      toolName: 'sim',
      domain: 'generic',
      fidelityLevel: 0,
      input: {},
      status: 'running' as const,
      metrics: { submittedAt: Date.now() - 5000 },
      agentId: 'agent-1',
      sessionId: sid,
    }
    await store.save(fakeJob)

    // New manager (simulating restart)
    const mgr = new JobManager(sid)
    const reattached = await mgr.reattach(fakeJob.jobId)

    assert(reattached !== null, 'reattach() should return the job')
    assert(reattached!.status === 'failed', `Expected failed, got ${reattached!.status}`)
    assert(reattached!.error?.includes('terminated') ?? false, 'Expected termination error message')
    assert(await mgr.poll(fakeJob.jobId) === 'failed', 'poll() should return failed after reattach')
  })

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
