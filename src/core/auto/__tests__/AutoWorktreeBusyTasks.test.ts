/**
 * AutoWorktreeCoordinator — "which tasks are actually busy?"
 *
 * `activeTasks()` returns every record the coordinator still holds, and a record
 * survives until its branch is merged and removed. That is the right answer for
 * lifecycle sweeps, and the WRONG answer for "may this session park?".
 *
 * Using it for the latter produced a session-destroying deadlock in production:
 * a sub-agent finished cleanly and moved to `awaiting_merge`; the bridge no
 * longer listed it, so `self_timer` allowed the park; but the checkpoint
 * snapshot unioned in `activeTasks()`, so `armAutoContinuation` refused to arm
 * the wake ("checkpoint still lists active sub-agents"). The scheduler then
 * retried the already-consumed wake and cancelled the session.
 *
 * `busyTasks()` is the in-flight-only view both callers now share.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AutoWorktreeCoordinator,
  type AutoWorktreePhase,
  type AutoWorktreeRecord,
} from '../AutoWorktreeCoordinator.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Build a coordinator whose registry already contains one record per phase. */
function coordinatorWith(phases: Record<string, AutoWorktreePhase>): AutoWorktreeCoordinator {
  const dir = mkdtempSync(join(tmpdir(), 'wt-busy-'))
  dirs.push(dir)
  const registryPath = join(dir, 'registry.json')
  mkdirSync(join(dir, 'sub'), { recursive: true })

  const tasks: Record<string, AutoWorktreeRecord> = {}
  for (const [taskId, phase] of Object.entries(phases)) {
    tasks[taskId] = {
      taskId,
      sessionId: 'sess-1',
      branchName: `auto/${taskId}`,
      worktreePath: join(dir, 'sub', taskId),
      forkPoint: 'abc1234',
      phase,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
  }
  writeFileSync(registryPath, JSON.stringify({ schemaVersion: '1.0', tasks }), 'utf-8')
  return new AutoWorktreeCoordinator(dir, { registryPath })
}

describe('busyTasks — phases that BLOCK a park', () => {
  it.each<AutoWorktreePhase>(['allocated', 'running', 'finalizing'])(
    'counts %s (the sub-agent is or may still be writing)',
    phase => {
      const c = coordinatorWith({ t1: phase })
      expect(c.busyTasks()).toEqual(['t1'])
    },
  )

  it('counts merging (the PRIMARY tree is being mutated right now)', () => {
    expect(coordinatorWith({ t1: 'merging' }).busyTasks()).toEqual(['t1'])
  })
})

describe('busyTasks — phases that must NOT block a park', () => {
  it('REGRESSION: awaiting_merge is not busy — its work is already committed', () => {
    // This is the exact phase that deadlocked a 55-minute unattended run.
    const c = coordinatorWith({ t1: 'awaiting_merge' })
    expect(c.busyTasks()).toEqual([])
    // …but the record still exists, because the merge has not happened yet.
    expect(c.activeTasks()).toEqual(['t1'])
  })

  it('conflicted is not busy — it needs a decision, not a wait', () => {
    expect(coordinatorWith({ t1: 'conflicted' }).busyTasks()).toEqual([])
  })

  it('failed is not busy', () => {
    expect(coordinatorWith({ t1: 'failed' }).busyTasks()).toEqual([])
  })

  it('no_changes is not busy', () => {
    expect(coordinatorWith({ t1: 'no_changes' }).busyTasks()).toEqual([])
  })

  it('merged is not busy', () => {
    expect(coordinatorWith({ t1: 'merged' }).busyTasks()).toEqual([])
  })
})

describe('busyTasks vs activeTasks', () => {
  it('separates in-flight work from finished-but-unmerged work', () => {
    const c = coordinatorWith({
      running: 'running',
      waiting: 'awaiting_merge',
      broken: 'failed',
      done: 'merged',
    })
    expect(c.busyTasks().sort()).toEqual(['running'])
    // Lifecycle sweeps still need to see everything.
    expect(c.activeTasks().sort()).toEqual(['broken', 'done', 'running', 'waiting'])
  })

  it('a session with ONLY awaiting_merge work is parkable', () => {
    // The whole point of the fix: this must be an empty busy set.
    const c = coordinatorWith({ a: 'awaiting_merge', b: 'awaiting_merge' })
    expect(c.busyTasks()).toEqual([])
  })

  it('one busy task among finished ones still blocks', () => {
    const c = coordinatorWith({ a: 'awaiting_merge', b: 'running', c: 'merged' })
    expect(c.busyTasks()).toEqual(['b'])
  })

  it('an empty registry is not busy', () => {
    expect(coordinatorWith({}).busyTasks()).toEqual([])
  })
})
