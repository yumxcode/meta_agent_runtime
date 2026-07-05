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
  claimAutoOrchSchedule,
  releaseAutoOrchScheduleClaim,
  autoOrchClaimOwner,
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
import {
  attachAutoOrchRunWorkspace,
  type AutoOrchRunWorkspace,
  type AutoOrchRunWorkspaceDescriptor,
} from './RunWorkspace.js'
import { appendAutoOrchPlanRun, type AutoOrchStoredPlanRef } from './PlanStore.js'
import type { AutoWorktreeCoordinator } from '../auto/AutoWorktreeCoordinator.js'

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
  /**
   * Rebinds the bridge's worktree coordinator to the resumed run's coordinator
   * while a continuation executes (null restores the base). Mirrors
   * AutoOrchControllerDeps.worktreeBinding.
   */
  worktreeBinding?: (coordinator: AutoWorktreeCoordinator | null) => void
  /** Creating session id, stamped on schedules for observability. */
  getSessionId?: () => string | undefined
}

const DEFAULT_POLL_MS = 5_000
const DEFAULT_RESUME_POLL_MS = 1_000
const DEFAULT_RESUME_MAX_WAIT_MS = DEFAULT_SUB_AGENT_MAX_DURATION_MS + 60_000
const DEFAULT_NEXT_CHECK_MS = 30 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 5
const MIN_REPAUSE_DELAY_MS = 60_000
const BASE_RETRY_DELAY_MS = 60_000
const MAX_RETRY_DELAY_MS = 60 * 60_000

export class AutoOrchScheduler {
  private readonly collector: AutoOrchObservationCollector
  private readonly pollIntervalMs: number
  private readonly resumePollMs: number
  private readonly resumeMaxWaitMs: number
  private readonly nodeRunner: KernelNodeRunner
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private ticking = false
  private readonly claimOwner = autoOrchClaimOwner()
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

  async schedulePausedRun(
    plan: OrchPlan,
    run: PlanRunResult,
    runWorkspace?: AutoOrchRunWorkspaceDescriptor,
    planRef?: AutoOrchStoredPlanRef,
  ): Promise<AutoOrchScheduledResume | null> {
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
      projectDir: this.opts.projectDir,
      createdBySessionId: this.opts.getSessionId?.(),
      // Persist the goal: a daemon / later session resuming this run has no
      // in-memory goal anchor, but role nodes still need one to judge against.
      goal: safeGoalOf(this.opts.getGoal),
      externalRunId: stringOf(run.resumeHandle['externalRunId']),
      resumeInstruction: stringOf(run.resumeHandle['resumeInstruction']),
      runAt: now + Math.max(0, nextCheckAfterMs),
      status: 'scheduled',
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      plan,
      ...(planRef ? { planRef } : {}),
      ...(runWorkspace ? { runWorkspace } : {}),
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
      // Workspace-scoped pickup: never touch another project's schedules.
      const due = await listDueAutoOrchSchedules(Date.now(), { projectDir: this.opts.projectDir })
      for (const record of due) {
        if (this.stopped || signal.aborted) break
        if (this.active.has(record.scheduleId)) continue
        // Cross-process atomic claim: exactly one scheduler executes a due
        // schedule, even when several sessions share the workspace.
        if (!(await claimAutoOrchSchedule(record.scheduleId, this.claimOwner))) continue
        this.active.add(record.scheduleId)
        try {
          await this.runDue(record, signal)
        } finally {
          this.active.delete(record.scheduleId)
          // The claim guards the execution window only; a re-paused schedule's
          // next fire re-claims.
          await releaseAutoOrchScheduleClaim(record.scheduleId).catch(() => undefined)
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
    let workspace: AutoOrchRunWorkspace | null = null
    try {
      const stillRunning = await readAutoOrchSchedule(running.scheduleId)
      if (!stillRunning || stillRunning.status !== 'running') return
      // Re-attach the run's integration workspace: the continuation must keep
      // executing on the run branch, never on main.
      if (running.runWorkspace) {
        workspace = await attachAutoOrchRunWorkspace(this.opts.projectDir, running.runWorkspace)
        if (!workspace) {
          throw new Error(
            `auto_orch run workspace is gone (branch ${running.runWorkspace.branchName}); cannot resume`,
          )
        }
        this.opts.worktreeBinding?.(workspace.coordinator)
      }
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
        // Still waiting: keep the run workspace alive for the next check.
        await this.handleRepaused(running, finalTask, finalTask.result.output.auto_orch_pause)
        return
      }

      await this.markResumedSessionSettled(running, finalTask)
      // A resumed isolated writer's worktree must merge into the run branch —
      // synthesising 'ok' without merging would silently drop its file changes.
      const resumeMerge = await this.mergeResumedTask(workspace, finalTask)
      let continuation = await this.continuePlanFromResumedNode(
        running.plan, running.nodeId, finalTask, signal, workspace, resumeMerge, running.goal,
      )
      if (continuation.status === 'paused') {
        await this.schedulePausedRun(running.plan, continuation, running.runWorkspace, running.planRef)
      } else if (workspace) {
        // Terminal: apply the run-level transaction (same semantics as the
        // controller) — completed merges into main, everything else discards.
        if (continuation.status === 'completed') {
          const fin = await workspace.finishSuccess(`auto_orch ${workspace.runId}: resumed run completed`)
          if (!fin.merged) {
            continuation = {
              ...continuation,
              status: 'failed',
              note: [continuation.note, fin.note].filter(Boolean).join('；'),
            }
          } else if (fin.note) {
            continuation = {
              ...continuation,
              note: [continuation.note, fin.note].filter(Boolean).join('；'),
            }
          }
        } else {
          await workspace.finishDiscard().catch(() => undefined)
        }
      }
      if (continuation.status !== 'paused') {
        await this.cancelOrchestration(running.orchestrationTaskId, 'auto_orch run reached a terminal non-paused state')
      }
      if (running.planRef) {
        await appendAutoOrchPlanRun(this.opts.projectDir, running.planRef, continuation).catch(() => undefined)
      }
      await writeAutoOrchSchedule({
        ...running,
        status: continuation.status === 'failed' || continuation.status === 'invalid' || continuation.status === 'bounds_exceeded'
          ? 'failed'
          : 'completed',
        updatedAt: Date.now(),
        terminalAt: Date.now(),
        terminalNotice: terminalNoticeFor(continuation),
        lastError: continuation.status === 'completed' || continuation.status === 'paused'
          ? undefined
          : continuation.note,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const maxAttempts = running.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
      if (running.attempts < maxAttempts && !signal.aborted) {
        const delay = retryDelayMs(running.attempts)
        await writeAutoOrchSchedule({
          ...running,
          status: 'scheduled',
          runAt: Date.now() + delay,
          updatedAt: Date.now(),
          lastError: `${message}; retrying in ${Math.ceil(delay / 1000)}s`,
        })
        return
      }
      // The run is dead: discard its workspace so the main tree stays clean and
      // a later re-run cannot trip over the residue.
      await workspace?.finishDiscard().catch(() => undefined)
      await this.cancelOrchestration(running.orchestrationTaskId, 'auto_orch scheduled resume failed')
      await writeAutoOrchSchedule({
        ...running,
        status: 'failed',
        updatedAt: Date.now(),
        terminalAt: Date.now(),
        terminalNotice: `auto_orch scheduled resume failed after ${running.attempts} attempt(s): ${message}`,
        lastError: message,
      })
    } finally {
      if (workspace) this.opts.worktreeBinding?.(null)
    }
  }

  /** Merge a successfully-resumed isolated writer's worktree into the run branch. */
  private async mergeResumedTask(
    workspace: AutoOrchRunWorkspace | null,
    task: SubAgentRecord,
  ): Promise<{ ok: boolean; note?: string }> {
    if (!workspace) return { ok: true }
    if (task.status !== 'completed' || !task.result?.success) return { ok: true }
    if (task.config.workspaceMode !== 'isolated_write') return { ok: true }
    if (!workspace.coordinator.recordFor(task.taskId)) return { ok: true }
    try {
      const r = await workspace.coordinator.merge(task.taskId, {
        message: `meta-agent: auto_orch resumed node merge (${task.taskId})`,
      })
      if (r?.merged === false) return { ok: false, note: 'resumed worktree merge failed' }
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        note: `resumed worktree merge failed: ${err instanceof Error ? err.message : String(err)}`,
      }
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
      runAt: now + Math.max(MIN_REPAUSE_DELAY_MS, pause.nextCheckAfterMs ?? DEFAULT_NEXT_CHECK_MS),
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
    workspace: AutoOrchRunWorkspace | null,
    resumeMerge: { ok: boolean; note?: string },
    recordGoal?: string,
  ): Promise<PlanRunResult> {
    // Goal: prefer the goal PERSISTED on the schedule — the session that
    // created it may be long gone (daemon resume), and role nodes need it.
    const getGoal = (): string | null => recordGoal ?? safeGoalOf(this.opts.getGoal) ?? null
    // Run-scoped delegate: continuation nodes must execute against the
    // integration tree, exactly like the original run's nodes did.
    const delegate = workspace || recordGoal
      ? new KernelNodeRunner(this.opts.dispatcher, {
          getGoal,
          ...this.opts.nodeRunnerOptions,
          projectDir: workspace?.root ?? this.opts.projectDir,
          ...(workspace
            ? {
                codeArtifactRoot: this.opts.projectDir,
                worktrees: workspace.coordinator,
                runTree: workspace,
              }
            : {}),
        })
      : this.nodeRunner
    const runner = new ResumeContinuationNodeRunner(pausedNodeId, task, delegate, resumeMerge)
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
    private readonly resumeMerge: { ok: boolean; note?: string } = { ok: true },
  ) {}

  async run(node: OrchNode, ctx: PlanRunContext): Promise<OrchVerdict> {
    if (!this.consumed && node.id === this.pausedNodeId) {
      this.consumed = true
      const costUsd = this.resumedTask.result?.costUsd ?? 0
      if (!this.resumeMerge.ok) {
        return {
          action: 'branch',
          label: 'error',
          note: this.resumeMerge.note ?? 'resumed worktree merge failed',
          data: { costUsd },
        }
      }
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

function safeGoalOf(getGoal: () => string | null): string | undefined {
  try {
    const goal = getGoal()
    return goal && goal.trim() ? goal : undefined
  } catch {
    return undefined
  }
}

function retryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * (2 ** Math.max(0, attempts - 1)))
}

function terminalNoticeFor(run: PlanRunResult): string {
  const path = run.visitedPath.length ? ` path=${run.visitedPath.join(' → ')}` : ''
  const note = run.note ? `; ${run.note}` : ''
  return `auto_orch resumed run ${run.status}${path}; cost=$${run.costUsd.toFixed(3)}${note}`
}

function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function numberOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
