import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../../subagent/types.js'
import { writeTask } from '../../../subagent/SubAgentTaskStore.js'
import { SessionStore } from '../../SessionStore.js'
import { AutoOrchScheduler } from '../AutoOrchScheduler.js'
import { writeAutoOrchSubAgentSession } from '../AutoOrchSubAgentSessionStore.js'
import {
  readAutoOrchSchedule,
  writeAutoOrchSchedule,
  listDueAutoOrchSchedules,
  claimAutoOrchSchedule,
  releaseAutoOrchScheduleClaim,
  cancelAutoOrchSchedule,
  type AutoOrchScheduledResume,
} from '../AutoOrchScheduleStore.js'
import { saveApprovedAutoOrchPlan } from '../PlanStore.js'
import type { OrchPlan } from '../LoopIR.js'
import type { PlanRunResult } from '../PlanRunner.js'

function completedTask(taskId: string, summary: string, output?: unknown): SubAgentRecord {
  return {
    schemaVersion: '1.0',
    taskId,
    parentSessionId: 'parent',
    status: 'completed',
    config: { taskDescription: summary } as SubAgentRecord['config'],
    createdAt: Date.now(),
    completedAt: Date.now(),
    pendingHumanApproval: false,
    result: {
      success: true,
      summary,
      output,
      turnsUsed: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
      durationMs: 1,
    },
  }
}

function dispatcher(records: SubAgentRecord[], captured: string[]): ISubAgentDispatcher {
  const byId = new Map<string, SubAgentRecord>()
  let i = 0
  return {
    async spawnSubAgent({ config }) {
      captured.push(config.taskDescription)
      const rec = records[i++] ?? completedTask(`subtask-${i}`, 'ok')
      const withConfig = { ...rec, config: { ...rec.config, ...config } }
      byId.set(withConfig.taskId, withConfig)
      return withConfig
    },
    async getStatus(id) {
      return byId.get(id) ?? null
    },
    async cancelTask() {
      return true
    },
  }
}

async function preparePausedSession(ids: {
  orchestrationTaskId: string
  nodeId: string
  subTaskId: string
  agentSessionId: string
}): Promise<void> {
  await writeTask({
    schemaVersion: '1.0',
    taskId: ids.subTaskId,
    parentSessionId: 'parent',
    status: 'completed',
    config: {
      taskDescription: 'paused before external result',
      maxTurns: 1,
      maxBudgetUsd: 1,
      useEventDriven: false,
      pollIntervalMs: 10,
      requireHumanApproval: false,
      checkpointEveryNTurns: 0,
      autoOrch: {
        resumable: true,
        orchestrationTaskId: ids.orchestrationTaskId,
        nodeId: ids.nodeId,
        agentSessionId: ids.agentSessionId,
      },
    },
    createdAt: Date.now(),
    completedAt: Date.now(),
    pendingHumanApproval: false,
    result: {
      success: true,
      summary: 'paused',
      turnsUsed: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
      durationMs: 1,
    },
  })
  await SessionStore.replace(ids.agentSessionId, {
    mode: 'auto_orch_subagent',
    startTime: Date.now(),
    lastActivity: Date.now(),
    messageCount: 1,
    firstPrompt: 'paused before external result',
  }, [{ role: 'user', content: 'original auto session context' }])
  await writeAutoOrchSubAgentSession({
    schemaVersion: '1.0',
    orchestrationTaskId: ids.orchestrationTaskId,
    nodeId: ids.nodeId,
    subTaskId: ids.subTaskId,
    agentSessionId: ids.agentSessionId,
    status: 'paused_waiting_external',
    pauseReason: 'waiting_training_result',
    externalRunId: 'train-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

describe('AutoOrchScheduler', () => {
  const minimalPlan = (): OrchPlan => ({
    entry: 'auto_dev_train',
    nodes: [
      { id: 'auto_dev_train', kind: 'executor', taskDescription: 'develop and train' },
    ],
    edges: [],
  })

  it('resumes a paused sub-agent session and continues the original graph', async () => {
    const plan: OrchPlan = {
      entry: 'auto_dev_train',
      nodes: [
        { id: 'auto_dev_train', kind: 'executor', taskDescription: 'develop and train' },
        { id: 'verify_final', kind: 'role', role: 'reviewer', taskDescription: 'verify final result' },
      ],
      edges: [
        { from: 'auto_dev_train', to: 'verify_final', when: { on: 'verdictLabel', label: 'ok' } },
      ],
    }
    const orchestrationTaskId = `orch-${crypto.randomUUID()}`
    const nodeId = 'auto_dev_train'
    const subTaskId = `subtask-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
    const agentSessionId = `auto-orch-subagent-${crypto.randomUUID()}`

    await writeTask({
      schemaVersion: '1.0',
      taskId: subTaskId,
      parentSessionId: 'parent',
      status: 'completed',
      config: {
        taskDescription: 'paused before training result',
        maxTurns: 1,
        maxBudgetUsd: 1,
        useEventDriven: false,
        pollIntervalMs: 10,
        requireHumanApproval: false,
        checkpointEveryNTurns: 0,
        autoOrch: { resumable: true, orchestrationTaskId, nodeId, agentSessionId },
      },
      createdAt: Date.now(),
      completedAt: Date.now(),
      pendingHumanApproval: false,
      result: {
        success: true,
        summary: 'paused',
        turnsUsed: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.01,
        durationMs: 1,
      },
    })
    await SessionStore.replace(agentSessionId, {
      mode: 'auto_orch_subagent',
      startTime: Date.now(),
      lastActivity: Date.now(),
      messageCount: 1,
      firstPrompt: 'paused before training result',
    }, [{ role: 'user', content: 'original auto session context' }])
    await writeAutoOrchSubAgentSession({
      schemaVersion: '1.0',
      orchestrationTaskId,
      nodeId,
      subTaskId,
      agentSessionId,
      status: 'paused_waiting_external',
      pauseReason: 'waiting_training_result',
      externalRunId: 'train-1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    const captured: string[] = []
    const sched = new AutoOrchScheduler({
      dispatcher: dispatcher([
        completedTask('subtask-resumed', 'training metrics reached target'),
        completedTask('subtask-reviewer', '{"label":"pass","messages":[]}'),
      ], captured),
      projectDir: '/tmp',
      getGoal: () => 'reach target metric',
      pollIntervalMs: 60_000,
      resumePollMs: 1,
      resumeMaxWaitMs: 100,
      collector: {
        async collect() {
          return { prompt: '训练结果：已完成，指标达标。请继续判断。' }
        },
      },
    })
    const pausedRun: PlanRunResult = {
      status: 'paused',
      visitedPath: [nodeId],
      steps: [{ nodeId, action: 'branch', label: 'paused' }],
      costUsd: 0.01,
      resumeHandle: {
        orchestrationTaskId,
        nodeId,
        subTaskId,
        agentSessionId,
        externalRunId: 'train-1',
        nextCheckAfterMs: 0,
      },
    }
    const schedule = await sched.schedulePausedRun(plan, pausedRun)
    expect(schedule).not.toBeNull()

    await sched.tick()

    expect(captured[0]).toContain('训练结果：已完成')
    expect(captured[1]).toContain('verify final result')
    await expect(readAutoOrchSchedule(schedule!.scheduleId)).resolves.toMatchObject({
      status: 'completed',
    })
  })

  it('appends resumed terminal runs to the approved plan and stores a terminal notice', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'auto-orch-scheduler-planref-'))
    const plan = minimalPlan()
    const planRef = await saveApprovedAutoOrchPlan(projectDir, {
      goal: 'goal',
      plan,
      source: 'planner',
      approvedByUser: true,
    })
    const ids = {
      orchestrationTaskId: `orch-${crypto.randomUUID()}`,
      nodeId: 'auto_dev_train',
      subTaskId: `subtask-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`,
      agentSessionId: `auto-orch-subagent-${crypto.randomUUID()}`,
    }
    await preparePausedSession(ids)
    const sched = new AutoOrchScheduler({
      dispatcher: dispatcher([completedTask('subtask-resumed-planref', 'done')], []),
      projectDir,
      getGoal: () => 'goal',
      pollIntervalMs: 60_000,
      resumePollMs: 1,
      resumeMaxWaitMs: 100,
      collector: { async collect() { return { prompt: 'done' } } },
    })
    const schedule = await sched.schedulePausedRun(plan, {
      status: 'paused',
      visitedPath: [ids.nodeId],
      steps: [{ nodeId: ids.nodeId, action: 'branch', label: 'paused' }],
      costUsd: 0.01,
      resumeHandle: { ...ids, nextCheckAfterMs: 0 },
    }, undefined, planRef)

    await sched.tick()

    await expect(readAutoOrchSchedule(schedule!.scheduleId)).resolves.toMatchObject({
      status: 'completed',
      terminalNotice: expect.stringContaining('auto_orch resumed run completed'),
    })
    await expect(readFile(join(planRef.dir, 'runs.jsonl'), 'utf-8')).resolves.toContain('"status":"completed"')
  })

  it('backs off failed resume attempts before marking the schedule failed', async () => {
    const ids = {
      orchestrationTaskId: `orch-${crypto.randomUUID()}`,
      nodeId: 'auto_dev_train',
      subTaskId: `subtask-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`,
      agentSessionId: `auto-orch-subagent-${crypto.randomUUID()}`,
    }
    await preparePausedSession(ids)
    const sched = new AutoOrchScheduler({
      dispatcher: dispatcher([], []),
      projectDir: '/tmp',
      getGoal: () => 'goal',
      pollIntervalMs: 60_000,
      resumePollMs: 1,
      resumeMaxWaitMs: 1,
      collector: { async collect() { throw new Error('collector unavailable') } },
    })
    const schedule = await sched.schedulePausedRun(minimalPlan(), {
      status: 'paused',
      visitedPath: [ids.nodeId],
      steps: [{ nodeId: ids.nodeId, action: 'branch', label: 'paused' }],
      costUsd: 0.01,
      resumeHandle: { ...ids, nextCheckAfterMs: 0 },
    })

    await sched.tick()

    const retried = await readAutoOrchSchedule(schedule!.scheduleId)
    expect(retried).toMatchObject({
      status: 'scheduled',
      attempts: 1,
      lastError: expect.stringContaining('retrying in'),
    })
    expect(retried!.runAt).toBeGreaterThan(Date.now())
  })

  it('does not execute a cancelled schedule', async () => {
    const captured: string[] = []
    const sched = new AutoOrchScheduler({
      dispatcher: dispatcher([completedTask('subtask-resumed-cancelled', 'should not run')], captured),
      projectDir: '/tmp',
      getGoal: () => 'goal',
      pollIntervalMs: 60_000,
      resumePollMs: 1,
      resumeMaxWaitMs: 100,
    })
    const orchestrationTaskId = `orch-${crypto.randomUUID()}`
    const schedule = await sched.schedulePausedRun(minimalPlan(), {
      status: 'paused',
      visitedPath: ['auto_dev_train'],
      steps: [{ nodeId: 'auto_dev_train', action: 'branch', label: 'paused' }],
      costUsd: 0,
      resumeHandle: {
        orchestrationTaskId,
        nodeId: 'auto_dev_train',
        subTaskId: 'subtask-cancelled',
        agentSessionId: 'auto-orch-subagent-cancelled',
        nextCheckAfterMs: 0,
      },
    })
    expect(schedule).not.toBeNull()
    await expect(sched.cancelSchedule(schedule!.scheduleId, 'user cancelled')).resolves.toBe(true)

    await sched.tick()

    expect(captured).toEqual([])
    await expect(readAutoOrchSchedule(schedule!.scheduleId)).resolves.toMatchObject({
      status: 'cancelled',
      lastError: 'user cancelled',
    })
  })

  it('stop(true) cancels durable schedules created by this scheduler', async () => {
    const sched = new AutoOrchScheduler({
      dispatcher: dispatcher([], []),
      projectDir: '/tmp',
      getGoal: () => 'goal',
      pollIntervalMs: 60_000,
    })
    const schedule = await sched.schedulePausedRun(minimalPlan(), {
      status: 'paused',
      visitedPath: ['auto_dev_train'],
      steps: [{ nodeId: 'auto_dev_train', action: 'branch', label: 'paused' }],
      costUsd: 0,
      resumeHandle: {
        orchestrationTaskId: `orch-${crypto.randomUUID()}`,
        nodeId: 'auto_dev_train',
        subTaskId: 'subtask-stop',
        agentSessionId: 'auto-orch-subagent-stop',
        nextCheckAfterMs: 60_000,
      },
    })
    expect(schedule).not.toBeNull()

    sched.stop(true)
    await new Promise(resolve => setTimeout(resolve, 10))

    await expect(readAutoOrchSchedule(schedule!.scheduleId)).resolves.toMatchObject({
      status: 'cancelled',
      lastError: 'auto_orch session disposed',
    })
  })
})

// ── M4 regression: workspace-scoped pickup + cross-process atomic claim ─────────
describe('schedule store scoping + claims (M4)', () => {
  function scheduleRecord(overrides: Partial<AutoOrchScheduledResume> = {}): AutoOrchScheduledResume {
    const id = `auto-orch-schedule-test-${crypto.randomUUID().slice(0, 8)}`
    return {
      schemaVersion: '1.0',
      scheduleId: id,
      orchestrationTaskId: `orch-${id}`,
      nodeId: 'n1',
      subTaskId: `sub-${id}`,
      agentSessionId: `sess-${id}`,
      runAt: Date.now() - 1_000,
      status: 'scheduled',
      attempts: 0,
      plan: { entry: 'n1', nodes: [{ id: 'n1', kind: 'executor', taskDescription: 'x' }], edges: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    }
  }

  it('listDue filters by projectDir but keeps legacy records claimable', async () => {
    const mine = scheduleRecord({ projectDir: '/work/project-a' })
    const other = scheduleRecord({ projectDir: '/work/project-b' })
    const legacy = scheduleRecord() // no projectDir (pre-scoping record)
    await writeAutoOrchSchedule(mine)
    await writeAutoOrchSchedule(other)
    await writeAutoOrchSchedule(legacy)

    const due = await listDueAutoOrchSchedules(Date.now(), { projectDir: '/work/project-a' })
    const ids = due.map(d => d.scheduleId)
    expect(ids).toContain(mine.scheduleId)
    expect(ids).not.toContain(other.scheduleId)
    expect(ids).toContain(legacy.scheduleId)
    // Unscoped listing (no filter) still sees everything.
    const all = await listDueAutoOrchSchedules()
    expect(all.map(d => d.scheduleId)).toEqual(expect.arrayContaining([
      mine.scheduleId, other.scheduleId, legacy.scheduleId,
    ]))
  })

  it('claim is exclusive; release makes it claimable again', async () => {
    const rec = scheduleRecord()
    await writeAutoOrchSchedule(rec)
    expect(await claimAutoOrchSchedule(rec.scheduleId, 'proc-a')).toBe(true)
    expect(await claimAutoOrchSchedule(rec.scheduleId, 'proc-b')).toBe(false)
    await releaseAutoOrchScheduleClaim(rec.scheduleId)
    expect(await claimAutoOrchSchedule(rec.scheduleId, 'proc-b')).toBe(true)
    await releaseAutoOrchScheduleClaim(rec.scheduleId)
  })

  it('a stale claim can be stolen after the TTL', async () => {
    const rec = scheduleRecord()
    await writeAutoOrchSchedule(rec)
    expect(await claimAutoOrchSchedule(rec.scheduleId, 'crashed-proc')).toBe(true)
    // Fresh: not stealable.
    expect(await claimAutoOrchSchedule(rec.scheduleId, 'proc-b', 60_000)).toBe(false)
    // Past TTL: stealable, and exactly one create wins.
    await new Promise(r => setTimeout(r, 5))
    expect(await claimAutoOrchSchedule(rec.scheduleId, 'proc-b', 1)).toBe(true)
    await releaseAutoOrchScheduleClaim(rec.scheduleId)
  })

  it('tick skips a schedule already claimed by another process', async () => {
    const rec = scheduleRecord({ projectDir: '/tmp' })
    await writeAutoOrchSchedule(rec)
    expect(await claimAutoOrchSchedule(rec.scheduleId, 'another-process')).toBe(true)

    const captured: string[] = []
    const sched = new AutoOrchScheduler({
      dispatcher: dispatcher([], captured),
      projectDir: '/tmp',
      getGoal: () => 'goal',
      pollIntervalMs: 60_000,
    })
    await sched.tick()
    // Untouched: not resumed, still scheduled for the claim owner to handle.
    expect(captured).toHaveLength(0)
    expect((await readAutoOrchSchedule(rec.scheduleId))?.status).toBe('scheduled')
    await releaseAutoOrchScheduleClaim(rec.scheduleId)
    await cancelAutoOrchSchedule(rec.scheduleId, 'test done')
  })

  it('tick never picks up another workspace\'s schedule', async () => {
    const foreign = scheduleRecord({ projectDir: '/somewhere/else' })
    await writeAutoOrchSchedule(foreign)
    const captured: string[] = []
    const sched = new AutoOrchScheduler({
      dispatcher: dispatcher([], captured),
      projectDir: '/tmp',
      getGoal: () => 'goal',
      pollIntervalMs: 60_000,
    })
    await sched.tick()
    expect(captured).toHaveLength(0)
    expect((await readAutoOrchSchedule(foreign.scheduleId))?.status).toBe('scheduled')
    await cancelAutoOrchSchedule(foreign.scheduleId, 'test done')
  })

  it('schedulePausedRun stamps the workspace on the durable record', async () => {
    const sched = new AutoOrchScheduler({
      dispatcher: dispatcher([], []),
      projectDir: '/work/project-a',
      getGoal: () => 'goal',
      pollIntervalMs: 60_000,
      getSessionId: () => 'session-42',
    })
    const paused: PlanRunResult = {
      status: 'paused',
      visitedPath: ['n1'],
      steps: [],
      costUsd: 0,
      resumeHandle: {
        orchestrationTaskId: 'orch-1',
        nodeId: 'n1',
        subTaskId: 'sub-1',
        agentSessionId: 'agent-sess-1',
      },
    }
    const record = await sched.schedulePausedRun(
      { entry: 'n1', nodes: [{ id: 'n1', kind: 'executor', taskDescription: 'x' }], edges: [] },
      paused,
    )
    expect(record?.projectDir).toBe('/work/project-a')
    expect(record?.createdBySessionId).toBe('session-42')
    await cancelAutoOrchSchedule(record!.scheduleId, 'test done')
  })
})
