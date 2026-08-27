/**
 * Regression test for P0-1 (review 2026-08-27).
 *
 * Reproduction from the review, verbatim:
 *
 *   new JobStore('..').save({ jobId: 'config', ... })
 *
 * overwrote `$META_AGENT_HOME/config.json` with a job record. This test asserts
 * the whole class is closed at both the constructor and the per-record entry
 * points, and — critically — that a real neighbouring file survives the attempt.
 *
 * The ambient META_AGENT_HOME is already an isolated per-run temp directory
 * (see vitest.config.ts), so the "victim" files written here never go near a
 * developer's real ~/.meta-agent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { META_AGENT_HOME } from '../../core/metaAgentHome.js'
import { JobStore } from '../JobStore.js'
import type { EngineeringJob, JobId } from '../types.js'

const JOBS_ROOT = join(META_AGENT_HOME, 'jobs')

function job(jobId: string, sessionId = 'session-1'): EngineeringJob {
  return {
    jobId: jobId as JobId,
    toolName: 'test_tool',
    domain: 'generic',
    fidelityLevel: 0,
    input: {},
    status: 'running',
    metrics: { submittedAt: Date.now() },
    agentId: 'agent-1',
    sessionId,
  } as EngineeringJob
}

beforeEach(async () => {
  await mkdir(JOBS_ROOT, { recursive: true })
})

afterEach(async () => {
  await rm(JOBS_ROOT, { recursive: true, force: true })
  await rm(join(META_AGENT_HOME, 'p0-victim.json'), { force: true })
})

describe('JobStore path containment (P0-1)', () => {
  it('refuses a traversal sessionId at construction time', () => {
    expect(() => new JobStore('..')).toThrow(/sessionId/)
    expect(() => new JobStore('../..')).toThrow(/sessionId/)
    expect(() => new JobStore('a/b')).toThrow(/sessionId/)
    expect(() => new JobStore('')).toThrow(/sessionId/)
  })

  it('leaves a neighbouring file untouched when traversal is attempted', async () => {
    const victim = join(META_AGENT_HOME, 'p0-victim.json')
    const original = '{"original":true}'
    await writeFile(victim, original, 'utf-8')

    // The exact call shape from the review's reproduction.
    expect(() => new JobStore('..')).toThrow()

    // The assertion that matters: the file is byte-for-byte intact.
    expect(await readFile(victim, 'utf-8')).toBe(original)
  })

  it('refuses a traversal jobId on save/load/delete', async () => {
    const store = new JobStore('session-1')

    await expect(store.save(job('../config'))).rejects.toThrow(/jobId/)
    await expect(store.load('../config' as JobId)).rejects.toThrow(/jobId/)
    await expect(store.delete('../config' as JobId)).rejects.toThrow(/jobId/)
    await expect(store.save(job('a/b'))).rejects.toThrow(/jobId/)
    await expect(store.save(job('..'))).rejects.toThrow(/jobId/)
  })

  it('does not let a traversal jobId reach delete() and remove real data', async () => {
    const store = new JobStore('session-1')
    const victim = join(JOBS_ROOT, 'keepme.json')
    await writeFile(victim, '{"keep":true}', 'utf-8')

    await expect(store.delete('../keepme' as JobId)).rejects.toThrow()

    expect(await readFile(victim, 'utf-8')).toBe('{"keep":true}')
  })

  it('still round-trips well-formed ids', async () => {
    const store = new JobStore('3f2504e0-4f89-11d3-9a0c-0305e82c3301')
    await store.save(job('generic-bash_tool-a1b2c3d4'))

    const loaded = await store.load('generic-bash_tool-a1b2c3d4' as JobId)
    expect(loaded?.jobId).toBe('generic-bash_tool-a1b2c3d4')
    expect(await store.exists('generic-bash_tool-a1b2c3d4' as JobId)).toBe(true)
  })

  it('skips unsafe directory entries in loadAll instead of failing the listing', async () => {
    const store = new JobStore('session-2')
    await store.save(job('good-job-00000001'))

    // A stray file whose stem is not a valid id must not abort recovery.
    await writeFile(join(JOBS_ROOT, 'session-2', 'not a valid id.json'), '{}', 'utf-8')

    const all = await store.loadAll()
    expect(all.map(j => j.jobId)).toEqual(['good-job-00000001'])
  })
})
