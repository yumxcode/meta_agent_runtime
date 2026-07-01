import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../subagent/types.js'
import { DEFAULT_SUB_AGENT_MAX_DURATION_MS, TERMINAL_STATUSES } from '../../subagent/types.js'
import type { OrchPlan, OrchNode } from './LoopIR.js'
import { KernelNodeRunner, type KernelNodeRunnerOptions } from './KernelNodeRunner.js'
import { PlanRunner, type NodeRunner, type PlanRunResult, type PlanRunContext } from './PlanRunner.js'
import type { OrchVerdict } from './Verdict.js'
import {
  isAutoOrchPauseOutput,
  type AutoOrchPausePayload,
} from './AutoOrchPauseTool.js'
import {
  makeAutoOrchScheduleId,
  writeAutoOrchSchedule,
  readAutoOrchSchedule,
  listDueAutoOrchSchedules,
  cancelAutoOrchSchedule,
  cancelAutoOrchSchedulesForOrchestration,
  type AutoOrchScheduledResume,
} from './AutoOrchScheduleStore.js'
import {
  readAutoOrchSubAgentSession,
  writeAutoOrchSubAgentSession,
} from './AutoOrchSubAgentSessionStore.js'
import { resumeAutoOrchSubAgentSession } from './AutoOrchSubAgentResume.js'
import {
  notifyAutoOrchObserver,
  type AutoOrchObserver,
} from './Observer.js'

export interface AutoOrchObservation {
  prompt: string
  data?: unknown
}

export interface AutoOrchObservationCollector {
  collect(record: AutoOrchScheduledResume, signal: AbortSignal): Promise<AutoOrchObservation>
}

export interface AutoOrchSchedulerOptions {
  dispatcher: ISubAgentDispatcher
  projectDir: string
  getGoal: () => string | null
  nodeRunnerOptions?: KernelNodeRunnerOptions
  collector?: AutoOrchObservationCollector
  pollIntervalMs?: number
  resumePollMs?: number
  resumeMaxWaitMs?: number
  observer?: AutoOrchObserver
}

const DEFAULT_POLL_MS = 5_000
const DEFAULT_RESUME_POLL_MS = 1_000
const DEFAULT_RESUME_MAX_WAIT_MS = DEFAULT_SUB_AGENT_MAX_DURATION_MS + 60_000
const DEFAULT_NEXT_CHECK_MS = 30 * 60 * 1000

export class AutoOrchScheduler {
  private readonly collector: AutoOrchObservationCollector
  private readonly pollIntervalMs: number
  private readonly resumePollMs: number
  private readonly resumeMaxWaitMs: number
  private readonly nodeRunner: KernelNodeRunner
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private ticking = false
  private readonly active = new Set<string>()
  private readonly orchestrationTaskIds = new Set<string>()
  private readonly scheduleIds = new Set<string>()

  constructor(private readonly opts: AutoOrchSchedulerOptions) {
    this.collector = opts.collector ?? new DefaultAutoOrchObservationCollector()
    this.pollIntervalMs = Math.max(250, opts.pollIntervalMs ?? DEFAULT_POLL_MS)
    this.resumePollMs = Math.max(100, opts.resumePollMs ?? DEFAULT_RESUME_POLL_MS)
    this.resumeMaxWaitMs = Math.max(this.resumePollMs, opts.resumeMaxWaitMs ?? DEFAULT_RESUME_MAX_WAIT_MS)
    this.nodeRunner = new KernelNodeRunner(opts.dispatcher, {
      projectDir: opts.projectDir,
      getGoal: opts.getGoal,
      ...opts.nodeRunnerOptions,
    })
  }

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => { void this.tick().catch(() => undefined) }, this.pollIntervalMs)
    if (this.timer.unref) this.timer.unref()
    void this.tick().catch(() => undefined)
  }

  stop(cancelDurable = false): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (cancelDurable) void this.cancelAll('auto_orch session disposed').catch(() => undefined)
  }

  async cancelSchedule(scheduleId: string, reason?: string): Promise<boolean> {
    return cancelAutoOrchSchedule(scheduleId, reason)
  }

  async cancelOrchestration(orchestrationTaskId: string, reason?: string): Promise<number> {
    this.orchestrationTaskIds.delete(orchestrationTaskId)
    return cancelAutoOrchSchedulesForOrchestration(orchestrationTaskId, reason)
  }

  async cancelAll(reason?: string): Promise<number> {
    let n = 0
    for (const id of [...this.scheduleIds]) {
      if (await cancelAutoOrchSchedule(id, reason)) n++
    }
    for (const id of [...this.orchestrationTaskIds]) {
      n += await cancelAutoOrchSchedulesForOrchestration(id, reason)
    }
    this.scheduleIds.clear()
    this.orchestrationTaskIds.clear()
    return n
  }

  async schedulePausedRun(plan: OrchPlan, run: PlanRunResult): Promise<AutoOrchScheduledResume | null> {
    if (run.status !== 'paused' || !run.resumeHandle) return null
    const nodeId = stringOf(run.resumeHandle['nodeId']) ?? run.visitedPath.at(-1)
    const subTaskId = stringOf(run.resumeHandle['subTaskId'])
    const agentSessionId = stringOf(run.resumeHandle['agentSessionId'])
    const orchestrationTaskId = stringOf(run.resumeHandle['orchestrationTaskId'])
    if (!nodeId || !subTaskId || !agentSessionId || !orchestrationTaskId) return null

    const nextCheckAfterMs = numberOf(run.resumeHandle['nextCheckAfterMs']) ?? DEFAULT_NEXT_CHECK_MS
    const now = Date.now()
    const record: AutoOrchScheduledResume = {
      schemaVersion: '1.0',
      scheduleId: makeAutoOrchScheduleId(),
      orchestrationTaskId,
      nodeId,
      subTaskId,
      agentSessionId,
      externalRunId: stringOf(run.resumeHandle['externalRunId']),
      resumeInstruction: stringOf(run.resumeHandle['resumeInstruction']),
      runAt: now + Math.max(0, nextCheckAfterMs),
      status: 'scheduled',
      attempts: 0,
      plan,
      createdAt: now,
      updatedAt: now,
    }
    await writeAutoOrchSchedule(record)
    this.scheduleIds.add(record.scheduleId)
    this.orchestrationTaskIds.add(record.orchestrationTaskId)
    return record
  }

  async tick(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      const due = await listDueAutoOrchSchedules()
      for (const record of due) {
        if (this.stopped || signal.aborted) break
        if (this.active.has(record.scheduleId)) continue
        this.active.add(record.scheduleId)
        try {
          await this.runDue(record, signal)
        } finally {
          this.active.delete(record.scheduleId)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  private async runDue(record: AutoOrchScheduledResume, signal: AbortSignal): Promise<void> {
    const latest = await readAutoOrchSchedule(record.scheduleId)
    if (!latest || latest.status !== 'scheduled') return
    record = latest
    this.scheduleIds.add(record.scheduleId)
    this.orchestrationTaskIds.add(record.orchestrationTaskId)
    const running = { ...record, status: 'running' as const, attempts: record.attempts + 1, updatedAt: Date.now() }
    await writeAutoOrchSchedule(running)
    try {
      const stillRunning = await readAutoOrchSchedule(running.scheduleId)
      if (!stillRunning || stillRunning.status !== 'running') return
      const observation = await this.collector.collect(running, signal)
      await notifyAutoOrchObserver(this.opts.observer, {
        type: 'run_resumed',
        scheduleId: running.scheduleId,
        orchestrationTaskId: running.orchestrationTaskId,
        nodeId: running.nodeId,
        subTaskId: running.subTaskId,
        externalRunId: running.externalRunId,
      })
      const { task } = await resumeAutoOrchSubAgentSession({
        dispatcher: this.opts.dispatcher,
        orchestrationTaskId: running.orchestrationTaskId,
        nodeId: running.nodeId,
        observationPrompt: observation.prompt,
      })
      const finalTask = await this.waitForTerminal(task.taskId, signal)
      if (!finalTask) throw new Error(`resumed sub-agent did not finish: ${task.taskId}`)

      if (finalTask.result?.success && isAutoOrchPauseOutput(finalTask.result.output)) {
        await this.handleRepaused(running, finalTask, finalTask.result.output.auto_orch_pause)
        return
      }

      await this.markResumedSessionSettled(running, finalTask)
      const continuation = await this.continuePlanFromResumedNode(running.plan, running.nodeId, finalTask, signal)
      if (continuation.status === 'paused') {
        await this.schedulePausedRun(running.plan, continuation)
      }
      if (continuation.status !== 'paused') {
        await this.cancelOrchestration(running.orchestrationTaskId, 'auto_orch run reached a terminal non-paused state')
      }
      await writeAutoOrchSchedule({
        ...running,
        status: continuation.status === 'failed' || continuation.status === 'invalid' || continuation.status === 'bounds_exceeded'
          ? 'failed'
          : 'completed',
        updatedAt: Date.now(),
        lastError: continuation.status === 'completed' || continuation.status === 'paused'
          ? undefined
          : continuation.note,
      })
    } catch (err) {
      await this.cancelOrchestration(running.orchestrationTaskId, 'auto_orch scheduled resume failed')
      await writeAutoOrchSchedule({
        ...running,
        status: 'failed',
        updatedAt: Date.now(),
        lastError: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async handleRepaused(
    schedule: AutoOrchScheduledResume,
    task: SubAgentRecord,
    pause: AutoOrchPausePayload,
  ): Promise<void> {
    const now = Date.now()
    const session = await readAutoOrchSubAgentSession(schedule.orchestrationTaskId, schedule.nodeId)
    await writeAutoOrchSubAgentSession({
      schemaVersion: '1.0',
      orchestrationTaskId: schedule.orchestrationTaskId,
      nodeId: schedule.nodeId,
      subTaskId: task.taskId,
      agentSessionId: schedule.agentSessionId,
      status: 'paused_waiting_external',
      pauseReason: pause.reason,
      externalRunId: pause.externalRunId ?? schedule.externalRunId,
      resumeInstruction: pause.resumeInstruction ?? schedule.resumeInstruction,
      lastHistoryMessageCount: session?.lastHistoryMessageCount,
      createdAt: session?.createdAt ?? now,
      updatedAt: now,
    })
    await writeAutoOrchSchedule({
      ...schedule,
      status: 'scheduled',
      subTaskId: task.taskId,
      externalRunId: pause.externalRunId ?? schedule.externalRunId,
      resumeInstruction: pause.resumeInstruction ?? schedule.resumeInstruction,
      runAt: now + Math.max(0, pause.nextCheckAfterMs ?? DEFAULT_NEXT_CHECK_MS),
      updatedAt: now,
    })
  }

  private async markResumedSessionSettled(
    schedule: AutoOrchScheduledResume,
    task: SubAgentRecord,
  ): Promise<void> {
    const session = await readAutoOrchSubAgentSession(schedule.orchestrationTaskId, schedule.nodeId)
    if (!session) return
    await writeAutoOrchSubAgentSession({
      ...session,
      subTaskId: task.taskId,
      status: task.status === 'completed' && task.result?.success ? 'completed' : 'failed',
      updatedAt: Date.now(),
    })
  }

  private async continuePlanFromResumedNode(
    plan: OrchPlan,
    pausedNodeId: string,
    task: SubAgentRecord,
    signal: AbortSignal,
  ): Promise<PlanRunResult> {
    const runner = new ResumeContinuationNodeRunner(pausedNodeId, task, this.nodeRunner)
    return new PlanRunner(
      { ...plan, entry: pausedNodeId },
      runner,
      { observer: this.opts.observer },
    ).run(signal)
  }

  private async waitForTerminal(taskId: string, signal: AbortSignal): Promise<SubAgentRecord | null> {
    const started = Date.now()
    while (!signal.aborted && Date.now() - started <= this.resumeMaxWaitMs) {
      const record = await this.opts.dispatcher.getStatus(taskId)
      if (record && TERMINAL_STATUSES.has(record.status)) return record
      await sleep(this.resumePollMs)
    }
    return null
  }
}

class ResumeContinuationNodeRunner implements NodeRunner {
  private consumed = false

  constructor(
    private readonly pausedNodeId: string,
    private readonly resumedTask: SubAgentRecord,
    private readonly delegate: NodeRunner,
  ) {}

  async run(node: OrchNode, ctx: PlanRunContext): Promise<OrchVerdict> {
    if (!this.consumed && node.id === this.pausedNodeId) {
      this.consumed = true
      const costUsd = this.resumedTask.result?.costUsd ?? 0
      if (this.resumedTask.status === 'completed' && this.resumedTask.result?.success) {
        return {
          action: 'branch',
          label: 'ok',
          note: this.resumedTask.result.summary,
          data: { costUsd },
        }
      }
      return {
        action: 'branch',
        label: 'error',
        note: this.resumedTask.result?.error ?? `resumed sub-agent ${this.resumedTask.taskId} failed`,
        data: { costUsd },
      }
    }
    return this.delegate.run(node, ctx)
  }
}

class DefaultAutoOrchObservationCollector implements AutoOrchObservationCollector {
  async collect(record: AutoOrchScheduledResume): Promise<AutoOrchObservation> {
    const lines = [
      '定时检查触发：请基于已有完整上下文继续处理等待中的外部任务。',
      '',
      `externalRunId: ${record.externalRunId ?? '(none)'}`,
      `orchestrationTaskId: ${record.orchestrationTaskId}`,
      `nodeId: ${record.nodeId}`,
      '',
      record.resumeInstruction
        ? `恢复指令：${record.resumeInstruction}`
        : '恢复指令：读取可用的训练日志、metrics、checkpoint 或外部状态，判断继续等待、重训、终止或完成。',
      '',
      '如果外部任务仍未完成，请再次调用 auto_orch_pause_external；如果候选结果已达成目标，请正常完成本节点；如果失败且无法修复，请返回失败结果。',
    ]
    return { prompt: lines.join('\n') }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    if (timer.unref) timer.unref()
  })
}

function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function numberOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
