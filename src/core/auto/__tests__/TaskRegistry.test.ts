/**
 * TaskRegistry — can the system tell a live task from a dead one.
 *
 * The anchor case is the 2026-08-17 incident, reproduced here from the exact
 * file shapes it left on disk: a checkpoint saying `stopReason: parked` beside
 * a wake queue holding nothing but a terminal `cancelled` record. Every log
 * line that day read like a clean finish, and nothing in the system could say
 * otherwise. `orphaned` is that missing sentence, so it gets a test that
 * describes the incident rather than the code.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoContinuationStore } from '../AutoContinuationStore.js'
import { writeAutoCheckpoint, AUTO_CHECKPOINT_SCHEMA_VERSION } from '../AutoCheckpointStore.js'
import {
  collectTasks,
  deriveTaskStatus,
  sortTasks,
  summarize,
  isUnhealthy,
  DEFAULT_OVERDUE_GRACE_MS,
  type TaskView,
} from '../TaskRegistry.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'task-registry-'))
  dirs.push(dir)
  return dir
}

const GOAL = '持续推进X1 AMP训练'

async function parkedCheckpoint(ws: string, sessionId: string): Promise<void> {
  await writeAutoCheckpoint(ws, {
    schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
    sessionId,
    updatedAt: Date.now(),
    goal: GOAL,
    stopReason: 'parked',
    turnCount: 209,
    estimatedCostUsd: 12.69,
    pendingTodos: ['v19 训练监控'],
    compactions: 1,
  })
}

async function only(ws: string): Promise<TaskView> {
  const tasks = await collectTasks({ workspaces: [ws] })
  expect(tasks).toHaveLength(1)
  return tasks[0]!
}

describe('the 2026-08-17 incident state is reported as ORPHANED', () => {
  it('flags a session parked with nothing left in the queue', async () => {
    const ws = await workspace()
    const store = new AutoContinuationStore(ws)
    const sessionId = '9bf2297f-800e-47fc-bde8-a6266593909c'
    await parkedCheckpoint(ws, sessionId)

    // The wake the fence wrongly rejected: claimed, then released as cancelled.
    const record = await store.schedule({
      sessionId,
      fireAt: Date.now() - 60_000,
      reason: 'check gate VERDICT ~13:23',
      historyMessageCount: 126,
    })
    const [claimed] = await store.claimDue()
    await store.release(claimed!.wakeId, claimed!.claim!.token, 'cancelled')
    expect((await store.list()).find(r => r.wakeId === record.wakeId)?.status).toBe('cancelled')

    const task = await only(ws)
    expect(task.status).toBe('orphaned')
    expect(isUnhealthy(task.status)).toBe(true)
    // The row must carry enough to act on without opening anything else.
    expect(task.goal).toBe(GOAL)
    expect(task.lastOutcome).toBe('cancelled')
    expect(task.progress.estimatedCostUsd).toBe(12.69)
    expect(task.health.compactions).toBe(1)
  })

  it('does not flag a session that simply finished', async () => {
    const ws = await workspace()
    await writeAutoCheckpoint(ws, {
      schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'done-1',
      updatedAt: Date.now(),
      goal: GOAL,
      stopReason: 'completed',
    })
    expect((await only(ws)).status).toBe('finished')
  })

  it('does not flag a healthy park — the wake is still there', async () => {
    const ws = await workspace()
    const store = new AutoContinuationStore(ws)
    await parkedCheckpoint(ws, 'live-1')
    await store.schedule({
      sessionId: 'live-1',
      fireAt: Date.now() + 30 * 60_000,
      reason: 'gate ~16:05',
      historyMessageCount: 10,
    })

    const task = await only(ws)
    expect(task.status).toBe('parked')
    expect(task.wake?.reason).toBe('gate ~16:05')
  })
})

describe('status derivation', () => {
  const now = 1_700_000_000_000
  const wake = (over: Record<string, unknown> = {}) =>
    ({ wakeId: 'w', sessionId: 's', fireAt: now, attempts: 1, ...over }) as never

  it('an unexpired claim outranks everything else', () => {
    expect(deriveTaskStatus({
      now,
      claimed: wake({ claim: { expiresAt: now + 60_000 } }),
      checkpointStopReason: 'parked',
    })).toBe('running')
  })

  it('an expired claim means the executing process died', () => {
    expect(deriveTaskStatus({
      now,
      claimed: wake({ claim: { expiresAt: now - 1 } }),
    })).toBe('stale-claim')
  })

  it('a future wake is a healthy park', () => {
    expect(deriveTaskStatus({ now, pending: wake({ fireAt: now + 1_000 }) })).toBe('parked')
  })

  it('tolerates a wake that just came due — claiming takes a moment', () => {
    expect(deriveTaskStatus({
      now,
      pending: wake({ fireAt: now - DEFAULT_OVERDUE_GRACE_MS + 1_000 }),
    })).toBe('parked')
  })

  it('calls a long-unclaimed due wake OVERDUE', () => {
    expect(deriveTaskStatus({
      now,
      pending: wake({ fireAt: now - DEFAULT_OVERDUE_GRACE_MS - 1_000 }),
    })).toBe('overdue')
  })

  it('splits orphaned from finished only when no wake is live', () => {
    expect(deriveTaskStatus({ now, checkpointStopReason: 'parked' })).toBe('orphaned')
    expect(deriveTaskStatus({ now, checkpointStopReason: 'completed' })).toBe('finished')
    expect(deriveTaskStatus({ now })).toBe('finished')
  })
})

describe('presentation invariants', () => {
  it('puts broken tasks first — a view you must scroll has failed', () => {
    const make = (status: TaskView['status']): TaskView => ({
      workspace: '/w', sessionId: status, status,
      progress: { completedSteps: [], pendingTodos: [] },
      health: {}, scheduler: { alive: true }, pendingSteerCount: 0,
    })
    const order = sortTasks([
      make('finished'), make('parked'), make('running'), make('orphaned'), make('overdue'),
    ]).map(t => t.status)
    expect(order[0]).toBe('orphaned')
    expect(order.indexOf('overdue')).toBeLessThan(order.indexOf('running'))
    expect(order[order.length - 1]).toBe('finished')
  })

  it('counts every status for the header line', () => {
    const counts = summarize([
      { status: 'running' }, { status: 'parked' }, { status: 'orphaned' },
    ] as TaskView[])
    expect(counts.running).toBe(1)
    expect(counts.orphaned).toBe(1)
    expect(counts.finished).toBe(0)
  })
})

describe('workspace scanning', () => {
  it('finds tasks that have a checkpoint but no wake record at all', async () => {
    // The orphan case in its purest form: the queue is empty, so a
    // wake-driven scan would report the workspace as having nothing.
    const ws = await workspace()
    await parkedCheckpoint(ws, 'ghost-1')
    const tasks = await collectTasks({ workspaces: [ws] })
    expect(tasks.map(t => t.sessionId)).toEqual(['ghost-1'])
  })

  it('returns nothing for a workspace that never ran auto', async () => {
    expect(await collectTasks({ workspaces: [await workspace()] })).toEqual([])
  })

  it('reports the scheduler as down when none is registered', async () => {
    const ws = await workspace()
    await parkedCheckpoint(ws, 'no-sched')
    expect((await only(ws)).scheduler.alive).toBe(false)
  })
})
