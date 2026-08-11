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
import type { MetaAgentTool } from '../../core/types.js'

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

  it('registerTool keeps the robotics sub-agent bridge registry in sync', async () => {
    const { session } = await freshSession()
    const tool: MetaAgentTool = {
      name: 'custom_robotics_tool',
      description: 'test tool',
      inputSchema: { type: 'object', properties: {} },
      call: async () => ({ content: 'ok' }),
    }

    session.registerTool(tool)

    const bridge = (session as unknown as { bridge: { toolRegistry: Map<string, MetaAgentTool> } }).bridge
    expect(bridge.toolRegistry.has('custom_robotics_tool')).toBe(true)
  })

  it('single-agent mode exposes only serial sub-agent tools', async () => {
    const { session } = await freshSession()
    const sessionInternals = session as unknown as {
      inner: { getToolRegistry: () => Map<string, MetaAgentTool> }
      bridge: { toolRegistry: Map<string, MetaAgentTool> }
    }
    const registry = sessionInternals.inner.getToolRegistry()

    for (const name of ['paper_search', 'run_agent']) {
      expect(registry.has(name)).toBe(true)
      expect(sessionInternals.bridge.toolRegistry.has(name)).toBe(true)
    }

    for (const name of ['spawn_sub_agent', 'experiment_dispatch']) {
      expect(registry.has(name)).toBe(false)
      expect(sessionInternals.bridge.toolRegistry.has(name)).toBe(false)
    }
  })

  it('multi-agent mode exposes deferred sub-agent dispatch tools', async () => {
    const { session } = await freshSession()
    const sessionInternals = session as unknown as {
      _agentMode: string
      _flushDeferredMultiAgentTools: () => void
      inner: { getToolRegistry: () => Map<string, MetaAgentTool> }
      bridge: { toolRegistry: Map<string, MetaAgentTool> }
    }

    expect(sessionInternals.inner.getToolRegistry().has('spawn_sub_agent')).toBe(false)

    sessionInternals._agentMode = 'multi'
    sessionInternals._flushDeferredMultiAgentTools()

    for (const name of ['spawn_sub_agent', 'experiment_dispatch']) {
      expect(sessionInternals.inner.getToolRegistry().has(name)).toBe(true)
      expect(sessionInternals.bridge.toolRegistry.has(name)).toBe(true)
    }
  })

  it('dispose preserves completed branch-backed tasks for later merge/discard', async () => {
    const { session, projectDir, storeSessionId } = await freshSession()

    await RoboticsProjectStore.registerSubAgentTask(projectDir, storeSessionId, makeRecord({
      taskId: 'TASK_COMPLETED_BRANCH',
      branchName: 'exp/completed',
      worktreePath: '/tmp/robotics-completed-worktree',
    }))

    const removeWorktree = vi.fn().mockResolvedValue(undefined)
    ;(session as unknown as { gitMgr: { removeWorktree: typeof removeWorktree } }).gitMgr.removeWorktree =
      removeWorktree
    ;(session as unknown as { bridge: { getStatus: typeof vi.fn } }).bridge.getStatus =
      vi.fn().mockResolvedValue({ status: 'completed' })

    await session.dispose()

    expect(removeWorktree).not.toHaveBeenCalled()
    const state = await RoboticsProjectStore.findBySession(projectDir, storeSessionId)
    expect(state?.activeSubAgentTasks.some(t => t.taskId === 'TASK_COMPLETED_BRANCH')).toBe(true)
  })

  it('stale recovery preserves a completed branch-backed task awaiting merge', async () => {
    const { session, projectDir, storeSessionId } = await freshSession()
    const task = makeRecord({
      taskId: 'TASK_AWAITING_MERGE',
      branchName: 'exp/awaiting-merge',
      worktreePath: '/tmp/robotics-awaiting-merge-worktree',
    })
    await RoboticsProjectStore.registerSubAgentTask(projectDir, storeSessionId, task)
    await RoboticsProjectStore.updateGitState(projectDir, storeSessionId, {
      subAgentBranches: { [task.taskId]: task.branchName! },
      forkPoints: { [task.taskId]: 'abc123' },
    })

    const removeWorktree = vi.fn().mockResolvedValue(undefined)
    const sessionInternals = session as unknown as {
      gitMgr: { removeWorktree: typeof removeWorktree }
      bridge: { getStatus: typeof vi.fn }
      _recoverStaleSubAgentTasks: (tasks: ActiveSubAgentRecord[]) => Promise<void>
    }
    sessionInternals.gitMgr.removeWorktree = removeWorktree
    sessionInternals.bridge.getStatus = vi.fn().mockResolvedValue({ status: 'completed' })

    await sessionInternals._recoverStaleSubAgentTasks([task])

    expect(removeWorktree).not.toHaveBeenCalled()
    const state = await RoboticsProjectStore.findBySession(projectDir, storeSessionId)
    expect(state?.activeSubAgentTasks.some(t => t.taskId === task.taskId)).toBe(true)
    expect(state?.git.subAgentBranches[task.taskId]).toBe(task.branchName)
  })
})

/**
 * The robotics tool surface must include a way to WAIT.
 *
 * RoboticsSession builds its tool surface by hand rather than calling
 * createSystemTools(), and `sleep` fell through that gap. Meanwhile
 * `self_timer` — the escape hatch sleep's own prompt points at — is auto-mode
 * only (AgenticBackendFactory registers it behind `wantsGates`) and stays that
 * way, because robotics is interactive and a durable park does not fit it.
 *
 * So a robotics agent waiting on a CI run or a training job had no legal way to
 * wait past a bash command's timeout, and wrote `bash("sleep 180 && …")` —
 * which bash clamps and kills every time. This test pins the tool's presence.
 */
describe('RoboticsSession tool surface', () => {
  function toolNames(session: RoboticsSession): string[] {
    const inner = (session as unknown as { inner: { _registeredTools: MetaAgentTool[] } }).inner
    return inner._registeredTools.map(t => t.name)
  }

  it('registers `sleep`, the only sanctioned long wait in an interactive mode', async () => {
    const { session } = await freshSession()
    expect(toolNames(session)).toContain('sleep')
  })

  it('still does NOT register self_timer — robotics is not scheduler-backed', async () => {
    // Guarding the deliberate absence: a durable park has no meaning in a mode
    // where the user is sitting at the prompt.
    const { session } = await freshSession()
    expect(toolNames(session)).not.toContain('self_timer')
  })

  it('keeps bash alongside it — sleep replaces the shell WAIT, not the shell', async () => {
    const { session } = await freshSession()
    const names = toolNames(session)
    expect(names).toContain('bash')
    expect(names).toContain('read_file')
  })
})
