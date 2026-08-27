/**
 * Regression tests for P1-1 and P1-2 (review 2026-08-27).
 *
 * Both are ordering/lifecycle defects, so both are exercised with *injected*
 * timing rather than by hoping the scheduler cooperates:
 *
 *   P1-1  a delayed `running` write must not overwrite an already-persisted
 *         terminal status. The delay is injected into JobStore.save().
 *   P1-2  a record left `running` on disk by a killed process must be
 *         normalised to `failed` by loadSession(), so awaitJob() resolves
 *         deterministically instead of hanging.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { META_AGENT_HOME } from '../../core/metaAgentHome.js'
import { JobManager } from '../JobManager.js'
import { JobStore } from '../JobStore.js'
import { LocalExecutor } from '../JobExecutor.js'
import type { EngineeringJob, JobId } from '../types.js'

const JOBS_ROOT = join(META_AGENT_HOME, 'jobs')
const SESSION = 'recovery-session'

async function readPersisted(sessionId: string, jobId: string): Promise<EngineeringJob> {
  const raw = await readFile(join(JOBS_ROOT, sessionId, `${jobId}.json`), 'utf-8')
  return JSON.parse(raw) as EngineeringJob
}

beforeEach(async () => {
  await mkdir(JOBS_ROOT, { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(JOBS_ROOT, { recursive: true, force: true })
})

describe('JobManager persist ordering (P1-1)', () => {
  it('never lets a delayed active write overwrite a terminal status', async () => {
    const writes: string[] = []
    const original = JobStore.prototype.save

    // Inject the exact skew from the review's reproduction: the `running`
    // write is slow, the `completed` write is fast. Without a per-job chain
    // the two race and `running` wins by landing last.
    vi.spyOn(JobStore.prototype, 'save').mockImplementation(async function (
      this: JobStore,
      job: EngineeringJob,
    ) {
      if (job.status === 'running') {
        await new Promise(r => setTimeout(r, 60))
      }
      writes.push(job.status)
      return original.call(this, job)
    })

    const manager = new JobManager(SESSION, new LocalExecutor(2))
    const jobId = await manager.submit('test_tool', async () => ({ output: { ok: true } }), {})
    await manager.awaitJob(jobId)

    // The chain forces transition order regardless of per-write latency.
    // (No 'queued' here: with a free slot the executor starts the job directly.)
    expect(writes).toEqual(['submitted', 'running', 'completed'])
    // The specific inversion from the review — 'running' landing last — is gone.
    expect(writes.indexOf('running')).toBeLessThan(writes.indexOf('completed'))

    const persisted = await readPersisted(SESSION, jobId)
    expect(persisted.status).toBe('completed')
  })

  it('keeps terminal state on disk when an active write is slower than the whole job', async () => {
    // Same inversion, wider skew: the active write outlives the handler by an
    // order of magnitude. Only ordering — not luck — can keep this correct.
    const original = JobStore.prototype.save
    vi.spyOn(JobStore.prototype, 'save').mockImplementation(async function (
      this: JobStore,
      job: EngineeringJob,
    ) {
      if (job.status === 'running') await new Promise(r => setTimeout(r, 150))
      return original.call(this, job)
    })

    const manager = new JobManager(SESSION, new LocalExecutor(2))
    const jobId = await manager.submit('slow_write_tool', async () => ({ output: {} }), {})
    await manager.awaitJob(jobId)

    expect((await readPersisted(SESSION, jobId)).status).toBe('completed')
  })

  it('has drained every earlier write by the time awaitJob resolves', async () => {
    // The original bug also meant awaitJob() could resolve while an older
    // write was still queued behind it — so "read the file right after await"
    // was not safe. It is now.
    const manager = new JobManager(SESSION, new LocalExecutor(2))
    const jobId = await manager.submit('test_tool', async () => ({ output: {} }), {})
    await manager.awaitJob(jobId)

    const persisted = await readPersisted(SESSION, jobId)
    expect(persisted.status).toBe('completed')
    expect(persisted.metrics.completedAt).toBeGreaterThan(0)
  })

  it('assigns strictly increasing revisions across transitions', async () => {
    const revisions: number[] = []
    const original = JobStore.prototype.save
    vi.spyOn(JobStore.prototype, 'save').mockImplementation(async function (
      this: JobStore,
      job: EngineeringJob,
    ) {
      revisions.push(job.revision ?? 0)
      return original.call(this, job)
    })

    const manager = new JobManager(SESSION, new LocalExecutor(2))
    const jobId = await manager.submit('test_tool', async () => ({ output: {} }), {})
    await manager.awaitJob(jobId)

    for (let i = 1; i < revisions.length; i++) {
      expect(revisions[i]).toBeGreaterThan(revisions[i - 1]!)
    }
  })

  it('keeps ordering across a retried write instead of wedging the chain', async () => {
    // Retry back-off is precisely what made the original race observable: the
    // 100ms sleep inside _persistWithRetry pushed the 'running' write past the
    // terminal one. With the chain, the terminal write simply waits.
    const original = JobStore.prototype.save
    let failedOnce = false
    const writes: string[] = []
    vi.spyOn(JobStore.prototype, 'save').mockImplementation(async function (
      this: JobStore,
      job: EngineeringJob,
    ) {
      if (job.status === 'running' && !failedOnce) {
        failedOnce = true
        throw new Error('injected transient I/O failure')
      }
      writes.push(job.status)
      return original.call(this, job)
    })

    const manager = new JobManager(SESSION, new LocalExecutor(2))
    const jobId = await manager.submit('test_tool', async () => ({ output: {} }), {})
    await manager.awaitJob(jobId)

    expect(failedOnce).toBe(true)
    expect(writes.indexOf('running')).toBeLessThan(writes.indexOf('completed'))
    expect((await readPersisted(SESSION, jobId)).status).toBe('completed')
  })

  it('ignores a stale snapshot whose revision is below what is already durable', async () => {
    // Directly exercises the revision guard, independent of the chain: an
    // out-of-band write carrying an older revision must be dropped.
    const manager = new JobManager(SESSION, new LocalExecutor(2))
    const jobId = await manager.submit('test_tool', async () => ({ output: {} }), {})
    await manager.awaitJob(jobId)

    const terminal = await readPersisted(SESSION, jobId)
    expect(terminal.status).toBe('completed')

    const stale: EngineeringJob = { ...terminal, status: 'running', revision: 0 }
    await (manager as unknown as {
      _persistSnapshot(id: JobId, snap: EngineeringJob): Promise<boolean>
    })._persistSnapshot(jobId, stale)

    expect((await readPersisted(SESSION, jobId)).status).toBe('completed')
  })
})

describe('JobManager interrupted-job normalisation (P1-2)', () => {
  /** Write a record that looks like a process died mid-run. */
  async function seedInterrupted(status: 'submitted' | 'queued' | 'running', jobId: string): Promise<void> {
    const dir = join(JOBS_ROOT, SESSION)
    await mkdir(dir, { recursive: true })
    const record: EngineeringJob = {
      jobId: jobId as JobId,
      toolName: 'test_tool',
      domain: 'generic',
      fidelityLevel: 0,
      input: {},
      status,
      metrics: { submittedAt: Date.now() - 5_000, startedAt: Date.now() - 4_000 },
      agentId: 'agent-1',
      sessionId: SESSION,
      revision: 3,
    }
    await writeFile(join(dir, `${jobId}.json`), JSON.stringify(record), 'utf-8')
  }

  for (const status of ['submitted', 'queued', 'running'] as const) {
    it(`loadSession normalises an interrupted "${status}" job to failed`, async () => {
      await seedInterrupted(status, `stuck-${status}-0001`)

      const manager = new JobManager(SESSION, new LocalExecutor(2))
      const loaded = await manager.loadSession()

      expect(loaded).toHaveLength(1)
      expect(loaded[0]!.status).toBe('failed')
      expect(loaded[0]!.error).toMatch(/terminated before job completed/)

      // Normalisation is durable, not just in-memory.
      const persisted = await readPersisted(SESSION, `stuck-${status}-0001`)
      expect(persisted.status).toBe('failed')
      expect(persisted.revision).toBeGreaterThan(3)
    })
  }

  it('awaitJob rejects immediately for a recovered job instead of hanging', async () => {
    await seedInterrupted('running', 'stuck-await-0001')

    const manager = new JobManager(SESSION, new LocalExecutor(2))
    await manager.loadSession()

    // The defect: this promise never settled. Race it against a timer so a
    // regression fails the test rather than hanging the suite.
    const outcome = await Promise.race([
      manager.awaitJob('stuck-await-0001' as JobId).then(() => 'resolved', () => 'rejected'),
      new Promise<string>(r => setTimeout(() => r('still-pending'), 500)),
    ])
    expect(outcome).toBe('rejected')
  })

  it('poll reports the normalised status after loadSession', async () => {
    await seedInterrupted('running', 'stuck-poll-0001')

    const manager = new JobManager(SESSION, new LocalExecutor(2))
    await manager.loadSession()

    expect(await manager.poll('stuck-poll-0001' as JobId)).toBe('failed')
  })

  it('records a completion timestamp and wall time on normalisation', async () => {
    await seedInterrupted('running', 'stuck-metrics-001')

    const manager = new JobManager(SESSION, new LocalExecutor(2))
    const [job] = await manager.loadSession()

    expect(job!.metrics.completedAt).toBeGreaterThan(0)
    expect(job!.metrics.wallTimeMs).toBeGreaterThan(0)
  })

  it('leaves already-terminal records untouched', async () => {
    const dir = join(JOBS_ROOT, SESSION)
    await mkdir(dir, { recursive: true })
    const record: EngineeringJob = {
      jobId: 'done-job-00000001' as JobId,
      toolName: 'test_tool',
      domain: 'generic',
      fidelityLevel: 0,
      input: {},
      status: 'completed',
      metrics: { submittedAt: 1, completedAt: 2, wallTimeMs: 1 },
      agentId: 'agent-1',
      sessionId: SESSION,
      revision: 7,
    }
    await writeFile(join(dir, 'done-job-00000001.json'), JSON.stringify(record), 'utf-8')

    const manager = new JobManager(SESSION, new LocalExecutor(2))
    const [job] = await manager.loadSession()

    expect(job!.status).toBe('completed')
    expect(job!.revision).toBe(7)
    expect((await readPersisted(SESSION, 'done-job-00000001')).revision).toBe(7)
  })

  it('reattach and loadSession agree on the normalised outcome', async () => {
    // The two paths having drifted apart IS the bug. Pin them together.
    await seedInterrupted('running', 'stuck-parity-a01')
    await seedInterrupted('running', 'stuck-parity-b01')

    const viaReattach = new JobManager(SESSION, new LocalExecutor(2))
    const reattached = await viaReattach.reattach('stuck-parity-a01' as JobId)

    const viaLoad = new JobManager(SESSION, new LocalExecutor(2))
    const loaded = (await viaLoad.loadSession()).find(j => j.jobId === 'stuck-parity-b01')

    expect(reattached!.status).toBe(loaded!.status)
    expect(reattached!.error).toBe(loaded!.error)
  })
})
