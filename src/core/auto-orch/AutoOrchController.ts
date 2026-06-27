/**
 * AutoOrchController — the end-to-end driver that turns a goal into an executed
 * orchestration loop.
 *
 *   goal ──▶ Planner (LLM authors OrchPlan) ──▶ PlanRunner walks the graph ──▶
 *           each node ──▶ KernelNodeRunner spawns a real sub-agent
 *
 * This is the single object the backend constructs for auto-orch and the router
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

export interface AutoOrchControllerDeps extends AutoOrchPlannerDeps {
  /** Per-node sub-agent wait/poll tuning, forwarded to the KernelNodeRunner. */
  nodeRunnerOptions?: KernelNodeRunnerOptions
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

  constructor(deps: AutoOrchControllerDeps) {
    this.plan = makeAutoOrchPlanner(deps)
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
    const blackboard = new Blackboard()
    const runner = new PlanRunner(planned.plan, this.nodeRunner, { blackboard })
    const run = await runner.run(signal)
    return {
      planSource: planned.source,
      run,
      planNote: planned.note,
      summary: renderSummary(planned, run, blackboard.correctiveRounds()),
    }
  }
}

/**
 * Build the auto-orch LAUNCH phase hook (B): a `pre_query` hook that, on the
 * FIRST turn only, runs the whole orchestration and aborts the shell executor,
 * surfacing the orchestration summary as the result text (via the abort note).
 *
 * This is how auto-orch boots end-to-end without a bespoke submit() path: the
 * mode's main session is a thin shell whose first query never happens — the
 * controller does the real work through sub-agents. Idempotent (runs once); a
 * resumed/second turn is a no-op `continue`.
 */
export function buildAutoOrchLaunchHooks(controller: AutoOrchController): PhaseHookFn {
  const registry = new HookRegistry()
  let launched = false
  registry.register({
    id: 'auto-orch-launch',
    point: 'pre_query',
    role: 'orchestrator',
    handler: async ({ event }) => {
      if (launched) return continueVerdict('orchestration already launched')
      launched = true
      const result = await controller.run(event.signal)
      // abort the shell loop; the note becomes the session result text.
      return { action: 'abort', note: result.summary }
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
  lines.push(
    `[auto-orch] 编排${planned.source === 'planner' ? '计划' : '回退（单执行器）'}执行${statusZh(run.status)}。`,
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
    case 'aborted':
      return '被中断'
    case 'bounds_exceeded':
      return '触达硬上限后停止'
    case 'invalid':
      return '因计划非法未执行'
    case 'failed':
      return '因内部错误中止'
    default:
      return ''
  }
}
