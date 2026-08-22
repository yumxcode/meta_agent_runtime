import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TrajectoryRecorder } from '../recorder.js'
import { readTrajectoryHealth } from '../health.js'

const subject = { kind: 'session', sessionId: 'degraded' } as const

describe('trajectory degradation has one durable surface', () => {
  it('a host-observed canonical failure reaches health.json, not just memory', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'traj-degraded-'))
    const rec = await TrajectoryRecorder.open({ subject, mode: 'agentic' }, { rootDir })
    expect(rec.isCanonicalDegraded()).toBe(false)

    // What a KernelSession sees when its own record()/barrier() rejects.
    rec.markExternalCanonicalFailure(new Error('host could not complete the write'))
    expect(rec.isCanonicalDegraded()).toBe(true)

    await rec.close()
    const health = await readTrajectoryHealth(rec.trajectoryId, { rootDir })
    expect(health.canonicalDegraded).toBe(true)
    expect(health.lastError).toContain('host could not complete the write')
  })

  it('canonical degradation is sticky across a reopen', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'traj-degraded-sticky-'))
    const first = await TrajectoryRecorder.open({ subject, mode: 'agentic' }, { rootDir })
    const trajectoryId = first.trajectoryId
    first.markExternalCanonicalFailure(new Error('lost a line'))
    await first.close()

    const second = await TrajectoryRecorder.open(
      { subject, mode: 'agentic' },
      { rootDir, trajectoryId },
    )
    // A later clean barrier must not erase a known hole in the audit record.
    await second.record({ type: 'run_started', reason: 'after-reopen' })
    await second.barrier('turn')
    expect(second.isCanonicalDegraded()).toBe(true)
    await second.close()
    expect((await readTrajectoryHealth(trajectoryId, { rootDir })).canonicalDegraded).toBe(true)
  })
})
