/**
 * AutoOrchController — the end-to-end driver that turns a goal into an executed
 * orchestration loop.
 *
 *   goal ──▶ Planner (LLM authors OrchPlan) ──▶ PlanRunner walks the graph ──▶
 *           each node ──▶ KernelNodeRunner spawns a real sub-agent
 *
 * This is the single object the backend constructs for auto_orch and the router
 * kicks off on the first turn. It owns NO execution logic of its own beyond
 * sequencing the three pieces and rendering a short human-readable summary of
 * what the orchestration did — all the safety (validation, bounds, fail-open)
 * already lives in the Planner and PlanRunner.
 */
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { PhaseHookFn } from '../../kernel/loop/PhaseHooks.js'
import { makeAutoOrchPlanner, type AutoOrchPlannerDeps, type PlannerOutcome } from './PlannerAgent.js'
import { KernelNodeRunner, type KernelNodeRunnerOptions } from './KernelNodeRunner.js'
import { PlanRunner, type PlanRunResult } from './PlanRunner.js'
import { Blackboard } from './Blackboard.js'
import { HookRegistry } from './HookRegistry.js'
import { continueVerdict } from './Verdict.js'
import type { AutoOrchScheduler } from './AutoOrchScheduler.js'
import { materializeCodeNodes } from './CodeNodeAuthor.js'
import type { AutoOrchObserver } from './Observer.js'
import {
  appendAutoOrchPlanRun,
  saveApprovedAutoOrchPlan,
  saveMaterializedAutoOrchPlan,
  type AutoOrchStoredPlanRef,
} from './PlanStore.js'
import type {
  AutoWorktreeCleanupStrategy,
  AutoWorktreeCoordinator,
} from '../auto/AutoWorktreeCoordinator.js'

export interface AutoOrchControllerDeps extends AutoOrchPlannerDeps {
  /** Per-node sub-agent wait/poll tuning, forwarded to the KernelNodeRunner. */
  nodeRunnerOptions?: KernelNodeRunnerOptions
  /** Optional framework scheduler that resumes paused auto_orch sub-agents. */
  scheduler?: AutoOrchScheduler
  /** Optional observability sink for graph execution events. */
  observer?: AutoOrchObserver
  /** Best-effort cleanup for auto-series isolated-write worktrees after terminal runs. */
  worktreeCleanup?: {
    coordinator: AutoWorktreeCoordinator
    strategy: AutoWorktreeCleanupStrategy
  }
}

export interface OrchestrationResult {
  /** How the executed plan was obtained. */
  planSource: PlannerOutcome['source']
  /** The plan-runner outcome (status, visited path, cost, …). */
  run: PlanRunResult
  /** Planner note (esp. when it fell back). */
  planNote?: string
  /** A short human-readable recap suitable for the session result text. */
  summary: string
}

export class AutoOrchController {
  private readonly plan: ReturnType<typeof makeAutoOrchPlanner>
  private readonly nodeRunner: KernelNodeRunner
  private readonly scheduler?: AutoOrchScheduler
  private readonly dispatcher: ISubAgentDispatcher
  private readonly projectDir: string
  private readonly observer?: AutoOrchObserver
  private readonly getGoal: () => string | null
  private readonly worktreeCleanup?: AutoOrchControllerDeps['worktreeCleanup']

  constructor(deps: AutoOrchControllerDeps) {
    this.plan = makeAutoOrchPlanner(deps)
    this.scheduler = deps.scheduler
    this.dispatcher = deps.dispatcher
    this.projectDir = deps.projectDir
    this.observer = deps.observer
    this.getGoal = deps.getGoal
    this.worktreeCleanup = deps.worktreeCleanup
    // Forward workspace + goal so role nodes ('verify'/'drift') resolved from the
    // catalogue get the real jail root and frozen goal they judge against.
    this.nodeRunner = new KernelNodeRunner(deps.dispatcher, {
      projectDir: deps.projectDir,
      getGoal: deps.getGoal,
      ...deps.nodeRunnerOptions,
    })
  }

  /**
   * Plan, then execute the plan graph. Never throws — a failed planner falls
   * back to a single-executor plan, and PlanRunner resolves every failure path
   * to a result so the caller (router) can always report something coherent.
   */
  async run(signal: AbortSignal): Promise<OrchestrationResult> {
    const planned = await this.plan(signal)
    let storedPlanRef: AutoOrchStoredPlanRef | undefined
    if (signal.aborted) {
      const run: PlanRunResult = {
        status: 'aborted',
        visitedPath: [],
        steps: [],
        costUsd: 0,
        note: 'parent run aborted before graph execution',
      }
      return {
        planSource: planned.source,
        run,
        planNote: planned.note,
        summary: renderSummary(planned, run, 0),
      }
    }
    if (planned.approvedByUser) {
      const goal = this.safeGoal()
      storedPlanRef = await saveApprovedAutoOrchPlan(this.projectDir, {
        goal,
        plan: planned.plan,
        source: planned.source,
        approvedByUser: true,
        note: planned.note,
      }).catch(() => undefined)
    }
    const materialized = await materializeCodeNodes(
      planned.plan,
      { dispatcher: this.dispatcher, projectDir: this.projectDir },
      signal,
    )
    if (materialized.errors.length) {
      const run: PlanRunResult = {
        status: 'invalid',
        visitedPath: [],
        steps: [],
        costUsd: 0,
        note: materialized.errors.join('; '),
      }
      return {
        planSource: planned.source,
        run,
        planNote: planned.note,
        summary: renderSummary(planned, run, 0),
      }
    }
    if (storedPlanRef) {
      await saveMaterializedAutoOrchPlan(this.projectDir, storedPlanRef, materialized.plan).catch(() => undefined)
    }
    const blackboard = new Blackboard()
    const runner = new PlanRunner(materialized.plan, this.nodeRunner, { blackboard, observer: this.observer })
    const run = await runner.run(signal)
    if (storedPlanRef) {
      await appendAutoOrchPlanRun(this.projectDir, storedPlanRef, run).catch(() => undefined)
    }
    if (run.status === 'paused' && this.scheduler) {
      await this.scheduler.schedulePausedRun(materialized.plan, run).catch(() => undefined)
    } else if (this.scheduler) {
      await this.scheduler.cancelAll(`auto_orch run ended: ${run.status}`).catch(() => undefined)
    }
    if (run.status !== 'paused') await this.cleanupWorktrees()
    return {
      planSource: planned.source,
      run,
      planNote: planned.note,
      summary: renderSummary(planned, run, blackboard.correctiveRounds()),
    }
  }

  private safeGoal(): string {
    try {
      return this.getGoal()?.trim() || '继续推进当前目标。'
    } catch {
      return '继续推进当前目标。'
    }
  }

  private async cleanupWorktrees(): Promise<void> {
    if (!this.worktreeCleanup) return
    await this.worktreeCleanup.coordinator
      .cleanup(this.worktreeCleanup.strategy)
      .catch(() => undefined)
  }
}

/**
 * Build the auto_orch LAUNCH phase hook (B): a `pre_query` hook that, on the
 * FIRST turn only, runs the whole orchestration and aborts the shell executor,
 * surfacing the orchestration summary as the result text (via the abort note).
 *
 * This is how auto_orch boots end-to-end without a bespoke submit() path: the
 * mode's main session is a thin shell whose first query never happens — the
 * controller does the real work through sub-agents. Idempotent (runs once); a
 * resumed/second turn is a no-op `continue`.
 */
export function buildAutoOrchLaunchHooks(controller: AutoOrchController): PhaseHookFn {
  const registry = new HookRegistry()
  let launched = false
  registry.register({
    id: 'auto_orch-launch',
    point: 'pre_query',
    role: 'orchestrator',
    handler: async ({ event }) => {
      if (launched) return continueVerdict('orchestration already launched')
      launched = true
      const result = await controller.run(event.signal)
      // Abort the shell loop; the note becomes the session result text. A run
      // that did NOT complete (failed / invalid / bounds_exceeded /
      // review_unavailable / aborted) is flagged failed:true so the kernel maps
      // it to an error subtype instead of a deceptive success — the abort itself
      // is still how we stop the shell loop, but it carries the real outcome.
      const failed = result.run.status !== 'completed' && result.run.status !== 'paused'
      return { action: 'abort', note: result.summary, data: failed ? { failed: true } : undefined }
    },
  })
  return registry.toPhaseHookFn()
}

/** Build the controller from a dispatcher + goal accessor (router-facing helper). */
export function makeAutoOrchController(
  dispatcher: ISubAgentDispatcher,
  projectDir: string,
  getGoal: () => string | null,
  nodeRunnerOptions?: KernelNodeRunnerOptions,
): AutoOrchController {
  return new AutoOrchController({ dispatcher, projectDir, getGoal, nodeRunnerOptions })
}

function renderSummary(planned: PlannerOutcome, run: PlanRunResult, correctiveRounds: number): string {
  const lines: string[] = []
  const sourceZh = planned.source === 'planner'
    ? '计划'
    : planned.source === 'saved'
      ? '已保存计划'
      : '回退（单执行器）'
  lines.push(
    `[auto_orch] 编排${sourceZh}执行${statusZh(run.status)}。`,
  )
  if (planned.source === 'fallback' && planned.note) lines.push(`规划回退原因：${planned.note}`)
  if (run.visitedPath.length) lines.push(`执行路径：${run.visitedPath.join(' → ')}`)
  if (correctiveRounds > 0) lines.push(`审查纠偏轮数：${correctiveRounds}`)
  lines.push(`累计成本：约 $${run.costUsd.toFixed(3)}`)
  if (run.note) lines.push(`说明：${run.note}`)
  return lines.join('\n')
}

function statusZh(status: PlanRunResult['status']): string {
  switch (status) {
    case 'completed':
      return '完成'
    case 'paused':
      return '已暂停，等待外部事件恢复'
    case 'aborted':
      return '被中断'
    case 'bounds_exceeded':
      return '触达硬上限后停止'
    case 'invalid':
      return '因计划非法未执行'
    case 'review_unavailable':
      return '因审查不可用而未通过（fail-closed）'
    case 'failed':
      return '因内部错误中止'
    default:
      return ''
  }
}
