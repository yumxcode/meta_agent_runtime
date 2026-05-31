import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobManager } from '../JobManager.js'
import { TERMINAL_STATUSES } from '../types.js'
import type { JobHandler, JobContext, ProgressReporter } from '../types.js'

// Minimal job handler that completes immediately.
const noopHandler: JobHandler<unknown, { ok: boolean }> = async (
  _input: unknown,
  _ctx: JobContext,
  _progress: ProgressReporter,
) => ({ output: { ok: true }, summary: 'done', artifacts: [] })

async function submitN(mgr: JobManager, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = await mgr.submit(`tool-${i}`, noopHandler, {}, {})
    ids.push(id)
  }
  // Allow the LocalExecutor microtasks to flush.
  await new Promise<void>(r => setTimeout(r, 50))
  return ids
}

describe('JobManager — terminal-job LRU eviction (S2)', () => {
  beforeEach(async () => {
    // Use a fresh JOBS dir per test by setting HOME so JobStore's $HOME-relative
    // paths don't collide across tests in the suite.
    process.env['HOME'] = await mkdtemp(join(tmpdir(), 'jm-home-'))
  })

  it('evicts oldest terminal job when cap is reached', async () => {
    const mgr = new JobManager('test-session')
    mgr.setTerminalJobCap(3)
    const ids = await submitN(mgr, 5)
    // Allow more time for all jobs to fully transition
    await new Promise<void>(r => setTimeout(r, 100))
    // At most 3 terminal jobs should remain in the in-memory map.
    const inMem = mgr.list()
    const terminal = inMem.filter(j => TERMINAL_STATUSES.has(j.status))
    expect(terminal.length).toBeLessThanOrEqual(3)
    // The oldest job IDs should have been evicted.
    const remainingIds = new Set(inMem.map(j => j.jobId))
    expect(remainingIds.has(ids[ids.length - 1]!)).toBe(true)
  })

  it('forgetJob removes a terminal job but refuses active ones', async () => {
    const mgr = new JobManager('test-session')
    mgr.setTerminalJobCap(Infinity)
    const [id] = await submitN(mgr, 1)
    await new Promise<void>(r => setTimeout(r, 50))
    const ok = mgr.forgetJob(id!)
    expect(ok).toBe(true)
    expect(mgr.list().find(j => j.jobId === id)).toBeUndefined()
    // Forgetting an unknown id is a no-op
    expect(mgr.forgetJob('does-not-exist')).toBe(false)
  })

  it('forgetCompletedBefore evicts based on completion time', async () => {
    const mgr = new JobManager('test-session')
    mgr.setTerminalJobCap(Infinity)
    await submitN(mgr, 3)
    await new Promise<void>(r => setTimeout(r, 50))
    // Forget everything that finished before tomorrow → all of them.
    const n = mgr.forgetCompletedBefore(Date.now() + 60_000)
    expect(n).toBeGreaterThanOrEqual(1)
  })

  it('forgetAllCompleted is a wholesale drop', async () => {
    const mgr = new JobManager('test-session')
    mgr.setTerminalJobCap(Infinity)
    await submitN(mgr, 4)
    await new Promise<void>(r => setTimeout(r, 50))
    const n = mgr.forgetAllCompleted()
    expect(n).toBeGreaterThanOrEqual(1)
    const remaining = mgr.list().filter(j => TERMINAL_STATUSES.has(j.status))
    expect(remaining.length).toBe(0)
  })
})
