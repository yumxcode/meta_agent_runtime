/**
 * Regression tests for P2-1 and P2-2 (review 2026-08-27).
 *
 *   P2-1  an observer that throws must not change the observed job's outcome.
 *   P2-2  a non-finite / non-integer concurrency limit must be rejected, not
 *         silently turned into NaN — which disabled BOTH the concurrency gate
 *         and the queue bound at once.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { LocalExecutor, ExecutorConfigError } from '../JobExecutor.js'
import { JobManager } from '../JobManager.js'
import type { JobId } from '../types.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LocalExecutor configuration validation (P2-2)', () => {
  it('rejects NaN concurrency instead of accepting it as a limit', () => {
    // The original defect: Math.max(1, Math.floor(NaN)) === NaN, and every
    // comparison against NaN is false — so `running < maxConcurrent` never
    // admitted a job and `queue.length >= maxQueued` never rejected one.
    expect(() => new LocalExecutor(NaN)).toThrow(ExecutorConfigError)
    expect(() => new LocalExecutor(NaN)).toThrow(/maxConcurrent/)
  })

  it('names NaN specifically so the message points at the parse that produced it', () => {
    expect(() => new LocalExecutor(NaN)).toThrow(/NaN/)
  })

  it('rejects the other non-finite and non-integer forms', () => {
    expect(() => new LocalExecutor(Infinity)).toThrow(ExecutorConfigError)
    expect(() => new LocalExecutor(-Infinity)).toThrow(ExecutorConfigError)
    expect(() => new LocalExecutor(2.5)).toThrow(ExecutorConfigError)
    expect(() => new LocalExecutor(0)).toThrow(ExecutorConfigError)
    expect(() => new LocalExecutor(-1)).toThrow(ExecutorConfigError)
  })

  it('rejects an invalid queue bound as well', () => {
    expect(() => new LocalExecutor(4, undefined, NaN)).toThrow(/maxQueued/)
    expect(() => new LocalExecutor(4, undefined, -1)).toThrow(/maxQueued/)
    expect(() => new LocalExecutor(4, undefined, 1.5)).toThrow(/maxQueued/)
  })

  it('accepts valid limits, including a zero-length queue', () => {
    expect(() => new LocalExecutor(1)).not.toThrow()
    expect(() => new LocalExecutor(8)).not.toThrow()
    expect(() => new LocalExecutor(4, undefined, 0)).not.toThrow()
  })

  it('still admits and runs work under a valid configuration', async () => {
    // Guards against "fixed the validation, broke the executor": with the NaN
    // bug present this job would have queued forever instead of running.
    const executor = new LocalExecutor(2)
    const manager = new JobManager('executor-config-session', executor)
    const jobId = await manager.submit('test_tool', async () => ({ output: { ran: true } }), {})
    const result = await manager.awaitJob(jobId)
    expect(result.status).toBe('completed')
  })
})

describe('progress listener isolation (P2-1)', () => {
  it('does not fail a job when a progress listener throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manager = new JobManager('listener-isolation-session', new LocalExecutor(2))
    const jobId = await manager.submit(
      'test_tool',
      async (_input, _ctx, report) => {
        report({ percent: 50, currentStep: 'halfway' })
        return { output: { ok: true } }
      },
      {},
    )

    // The exact reproduction from the review: one exploding observer.
    const result = await manager.awaitJob(jobId, () => {
      throw new Error('observer exploded')
    })

    expect(result.status).toBe('completed')
    expect(await manager.poll(jobId)).toBe('completed')
  })

  it('still delivers progress to the other listeners', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manager = new JobManager('listener-isolation-session-2', new LocalExecutor(2))
    const seen: number[] = []

    // The handler starts as soon as submit() returns, so it has to wait for the
    // test to attach its observers — otherwise progress fires before anyone is
    // listening and the assertion below would pass vacuously.
    let openGate: () => void = () => {}
    const gate = new Promise<void>(resolve => { openGate = resolve })

    const jobId = await manager.submit(
      'test_tool',
      async (_input, _ctx, report) => {
        await gate
        report({ percent: 25, currentStep: 'quarter' })
        report({ percent: 75, currentStep: 'three-quarters' })
        return { output: {} }
      },
      {},
    )

    // Register the throwing listener FIRST, so a naive `for…of` without
    // per-listener isolation would never reach the healthy one.
    const rt = (manager as unknown as {
      jobs: Map<JobId, { progressListeners: Array<(p: { percent?: number }) => void> }>
    }).jobs.get(jobId)
    rt?.progressListeners.push(() => { throw new Error('observer exploded') })

    const settled = manager.awaitJob(jobId, p => {
      if (p.percent !== undefined) seen.push(p.percent)
    })
    openGate()

    const result = await settled
    expect(result.status).toBe('completed')
    expect(seen).toEqual([25, 75])
  })

  it('reports the listener failure to diagnostics rather than swallowing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manager = new JobManager('listener-isolation-session-3', new LocalExecutor(2))

    let openGate: () => void = () => {}
    const gate = new Promise<void>(resolve => { openGate = resolve })

    const jobId = await manager.submit(
      'test_tool',
      async (_input, _ctx, report) => {
        await gate
        report({ percent: 10, currentStep: 'start' })
        return { output: {} }
      },
      {},
    )

    const settled = manager.awaitJob(jobId, () => { throw new Error('observer exploded') })
    openGate()
    await settled

    // Isolation must not mean silence — a broken observer should be findable.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Progress listener'),
      expect.anything(),
    )
  })
})
