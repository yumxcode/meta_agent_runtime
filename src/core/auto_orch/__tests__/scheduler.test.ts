import { describe, expect, it } from 'vitest'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../../subagent/types.js'
import { writeTask } from '../../../subagent/SubAgentTaskStore.js'
import { SessionStore } from '../../SessionStore.js'
import { AutoOrchScheduler } from '../AutoOrchScheduler.js'
import { writeAutoOrchSubAgentSession } from '../AutoOrchSubAgentSessionStore.js'
import { readAutoOrchSchedule } from '../AutoOrchScheduleStore.js'
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
