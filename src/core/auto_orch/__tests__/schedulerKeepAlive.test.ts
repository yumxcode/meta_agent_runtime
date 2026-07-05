/**
 * SchedulerKeepAlive (M5) — quiescence wait, workspace daemon lock, and the
 * persisted-goal plumbing that lets an out-of-process resume judge correctly.
 */
import { describe, it, expect } from 'vitest'
import {
  waitForAutoOrchQuiescence,
  acquireAutoOrchDaemonLock,
} from '../SchedulerKeepAlive.js'
import {
  writeAutoOrchSchedule,
  cancelAutoOrchSchedule,
  listPendingAutoOrchSchedules,
  type AutoOrchScheduledResume,
} from '../AutoOrchScheduleStore.js'
import { AutoOrchScheduler } from '../AutoOrchScheduler.js'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { PlanRunResult } from '../PlanRunner.js'

const noopDispatcher: ISubAgentDispatcher = {
  async spawnSubAgent() { throw new Error('not used') },
  async getStatus() { return null },
  async cancelTask() { return true },
}

function scheduleRecord(overrides: Partial<AutoOrchScheduledResume> = {}): AutoOrchScheduledResume {
  const id = `keepalive-${crypto.randomUUID().slice(0, 8)}`
  return {
    schemaVersion: '1.0',
    scheduleId: id,
    orchestrationTaskId: `orch-${id}`,
    nodeId: 'n1',
    subTaskId: `sub-${id}`,
    agentSessionId: `sess-${id}`,
    runAt: Date.now() + 60_000,
    status: 'scheduled',
    attempts: 0,
    plan: { entry: 'n1', nodes: [{ id: 'n1', kind: 'executor', taskDescription: 'x' }], edges: [] },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('waitForAutoOrchQuiescence', () => {
  it('returns immediately when nothing is pending for the workspace', async () => {
    const { pendingAtExit } = await waitForAutoOrchQuiescence({
      projectDir: '/definitely/empty/workspace',
      pollMs: 500,
    })
    expect(pendingAtExit).toBe(0)
  })

  it('waits until the schedule terminates, reporting status along the way', async () => {
    const rec = scheduleRecord({ projectDir: '/work/keepalive-a' })
    await writeAutoOrchSchedule(rec)
    const statuses: number[] = []
    setTimeout(() => { void cancelAutoOrchSchedule(rec.scheduleId, 'test done') }, 40)
    const { pendingAtExit } = await waitForAutoOrchQuiescence({
      projectDir: '/work/keepalive-a',
      pollMs: 500, // clamped minimum; the cancel above lands within one poll
      onStatus: s => statuses.push(s.pending.length),
    })
    expect(pendingAtExit).toBe(0)
    expect(statuses.length).toBeGreaterThan(0)
    expect(statuses[0]).toBe(1)
  })

  it('an aborted wait reports the schedules still pending', async () => {
    const rec = scheduleRecord({ projectDir: '/work/keepalive-b' })
    await writeAutoOrchSchedule(rec)
    const abort = new AbortController()
    abort.abort()
    const { pendingAtExit } = await waitForAutoOrchQuiescence({
      projectDir: '/work/keepalive-b',
      pollMs: 500,
      signal: abort.signal,
    })
    expect(pendingAtExit).toBe(1)
    await cancelAutoOrchSchedule(rec.scheduleId, 'test done')
  })
})

describe('acquireAutoOrchDaemonLock', () => {
  it('is exclusive per workspace and released cleanly', async () => {
    const release = await acquireAutoOrchDaemonLock('/work/lock-a')
    expect(release).not.toBeNull()
    // Same live pid holds it → second acquire must fail.
    expect(await acquireAutoOrchDaemonLock('/work/lock-a')).toBeNull()
    // Different workspace is independent.
    const other = await acquireAutoOrchDaemonLock('/work/lock-b')
    expect(other).not.toBeNull()
    await other!()
    await release!()
    // Released → acquirable again.
    const again = await acquireAutoOrchDaemonLock('/work/lock-a')
    expect(again).not.toBeNull()
    await again!()
  })
})

describe('persisted goal on schedules (daemon resume correctness)', () => {
  it('schedulePausedRun stamps the frozen goal on the durable record', async () => {
    const sched = new AutoOrchScheduler({
      dispatcher: noopDispatcher,
      projectDir: '/work/goal-a',
      getGoal: () => '把训练指标提升到 0.9',
      pollIntervalMs: 60_000,
    })
    const paused: PlanRunResult = {
      status: 'paused',
      visitedPath: ['n1'],
      steps: [],
      costUsd: 0,
      resumeHandle: {
        orchestrationTaskId: 'orch-goal',
        nodeId: 'n1',
        subTaskId: 'sub-goal',
        agentSessionId: 'agent-sess-goal',
      },
    }
    const record = await sched.schedulePausedRun(
      { entry: 'n1', nodes: [{ id: 'n1', kind: 'executor', taskDescription: 'x' }], edges: [] },
      paused,
    )
    expect(record?.goal).toBe('把训练指标提升到 0.9')
    const pending = await listPendingAutoOrchSchedules({ projectDir: '/work/goal-a' })
    expect(pending.find(r => r.scheduleId === record!.scheduleId)?.goal).toBe('把训练指标提升到 0.9')
    await cancelAutoOrchSchedule(record!.scheduleId, 'test done')
  })
})
