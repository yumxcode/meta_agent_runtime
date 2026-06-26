/**
 * Regression tests for the _state re-hydration fix.
 *
 * Bug: experiment_dispatch / paper_search / progress_note mutate ONLY the
 * on-disk RoboticsProjectStore state; RoboticsSession._state was a snapshot
 * captured at init() and never refreshed. The sync consumers of _state — R3
 * (subagent_tasks), the compact anchor thunks, and dispose() worktree cleanup —
 * therefore observed a stale snapshot, so a dispatched task could vanish from
 * the next turn's context, lose its task_id/on_complete at compaction, and leak
 * its worktree on dispose.
 *
 * Fix: re-hydrate _state from disk (findBySession) at three async checkpoints —
 * submit() start, compact_start, and dispose() start. These tests simulate a
 * tool-only store write and assert each consumer now sees it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'crypto'
import { rm } from 'fs/promises'
import { join } from 'path'
import { META_AGENT_HOME } from '../../core/metaAgentHome.js'
import { RoboticsSession } from '../RoboticsSession.js'
import { RoboticsProjectStore } from '../persistence/RoboticsProjectStore.js'
import type { ActiveSubAgentRecord } from '../types.js'

const cleanup: string[] = []
const sessions: RoboticsSession[] = []

afterEach(async () => {
  // Dispose any sessions first (stops heartbeat timers, frees the bridge).
  await Promise.all(sessions.splice(0).map(s => s.dispose().catch(() => undefined)))
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function bucketFor(projectDir: string): string {
  const hash = createHash('sha1').update(projectDir).digest('hex').slice(0, 16)
  return join(META_AGENT_HOME, 'robotics', 'projects', hash)
}

async function freshSession(): Promise<{ session: RoboticsSession; projectDir: string; storeSessionId: string }> {
  const projectDir = `/tmp/robotics-rehydrate-${randomUUID()}`
  cleanup.push(bucketFor(projectDir))
  const session = new RoboticsSession({ projectDir, robot: 'go2' })
  sessions.push(session)
  await session.init()
  // Fresh (non-resumed) session: _storeSessionId === sessionId.
  const storeSessionId = (session as unknown as { _storeSessionId: string })._storeSessionId
  return { session, projectDir, storeSessionId }
}

function makeRecord(overrides: Partial<ActiveSubAgentRecord> = {}): ActiveSubAgentRecord {
  return {
    taskId: 'TASK_DISPATCHED_1',
    role: 'experiment',
    title: 'Locomotion gait tuning',
    spawnedAt: Date.now(),
    on_complete: 'call get_sub_agent_status and merge if reward improves',
    ...overrides,
  }
}

describe('RoboticsSession _state re-hydration', () => {
  it('R3: a task dispatched after init() (store-only write) becomes visible after _refreshState', async () => {
    const { session, projectDir, storeSessionId } = await freshSession()

    // Simulate experiment_dispatch: it writes ONLY the on-disk store.
    await RoboticsProjectStore.registerSubAgentTask(projectDir, storeSessionId, makeRecord())

    const internal = session as unknown as {
      _state: { activeSubAgentTasks: ActiveSubAgentRecord[] } | null
      _refreshState: () => Promise<void>
    }

    // Before re-hydration the in-memory snapshot is stale — this is the bug.
    expect(internal._state?.activeSubAgentTasks ?? []).toHaveLength(0)

    // submit() calls _refreshState() before building the R3 volatile section.
    await internal._refreshState()

    expect(internal._state?.activeSubAgentTasks).toHaveLength(1)
    expect(internal._state?.activeSubAgentTasks[0]?.taskId).toBe('TASK_DISPATCHED_1')
  })

  it('compact: deterministic anchors preserve task_id and on_complete after re-hydration', async () => {
    const { session, projectDir, storeSessionId } = await freshSession()

    await RoboticsProjectStore.registerSubAgentTask(projectDir, storeSessionId, makeRecord())

    const internal = session as unknown as {
      _refreshState: () => Promise<void>
      _buildDeterministicCompactAnchors: () => string | null
    }

    // Stale snapshot → anchors miss the task (bug condition).
    expect(internal._buildDeterministicCompactAnchors() ?? '').not.toContain('TASK_DISPATCHED_1')

    // compact_start interception re-hydrates _state before the sync thunks fire.
    await internal._refreshState()

    const anchors = internal._buildDeterministicCompactAnchors()
    expect(anchors).not.toBeNull()
    expect(anchors).toContain('TASK_DISPATCHED_1')
    expect(anchors).toContain('call get_sub_agent_status and merge if reward improves')
  })

  it('dispose: removes a worktree registered after init() (store-only write)', async () => {
    const { session, projectDir, storeSessionId } = await freshSession()

    // Simulate a dispatch that created a worktree and registered it on disk only.
    await RoboticsProjectStore.registerSubAgentTask(projectDir, storeSessionId, makeRecord({
      taskId: 'TASK_WITH_WORKTREE',
      branchName: 'exp/gait',
      worktreePath: '/tmp/robotics-rehydrate-worktree',
    }))

    // Spy on the git manager so the test does not depend on real worktrees.
    const removeWorktree = vi.fn().mockResolvedValue(undefined)
    ;(session as unknown as { gitMgr: { removeWorktree: typeof removeWorktree } }).gitMgr.removeWorktree =
      removeWorktree

    // dispose() re-hydrates _state, so it sees the task registered after init().
    await session.dispose()

    expect(removeWorktree).toHaveBeenCalledWith('TASK_WITH_WORKTREE', { deleteBranch: false })
  })
})
