/**
 * PlannerAgent — the AI that AUTHORS the orchestration loop (C, planning half).
 *
 * Given the frozen goal, it spawns an INDEPENDENT planning sub-agent (same
 * isolation pattern as the drift/verify agents) whose sole job is to emit an
 * OrchPlan as a JSON code block: a graph of executor + role nodes with condition
 * edges (which may form cycles → real loops). The plan is DATA, never code, so
 * the engine validates it (`validatePlan`) before anything runs.
 *
 * Fail-open is the load-bearing safety property: an unparsable, invalid, or
 * un-spawnable plan NEVER wedges the run — the planner degrades to a degenerate
 * single-executor plan that reproduces plain `auto` behaviour (one executor
 * pursuing the goal), flagged `source: 'fallback'` so the host can observe it.
 *
 * This module does the PLANNING half only. Executing the plan's nodes against
 * real kernel sub-agents (the NodeRunner wiring) is the separate execution half.
 */
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import { TERMINAL_STATUSES } from '../../subagent/types.js'
import {
  validatePlan,
  type OrchPlan,
  type OrchNode,
  type OrchEdge,
  type ParallelBranch,
  type JoinPolicy,
} from './LoopIR.js'

export interface AutoOrchPlannerDeps {
  /** Spawns the isolated planning sub-agent. */
  dispatcher: ISubAgentDispatcher
  /** Workspace / jail root. */
  projectDir: string
  /** Lazily reads the pure frozen goal (SessionRouter._autoGoal). */
  getGoal: () => string | null
  /**
   * How many planning attempts before falling back. On a validation failure the
   * errors are fed BACK to the planner and it is asked to re-create the plan.
   * Default 2 (one initial + one retry). Values < 1 are treated as 1.
   */
  maxAttempts?: number
}

/** Outcome of a planning attempt. `plan` is ALWAYS a valid, runnable plan. */
export interface PlannerOutcome {
  /** A validated plan — either the planner's, or the degenerate fallback. */
  plan: OrchPlan
  /** Where the plan came from. */
  source: 'planner' | 'fallback'
  /** Free-text reason, esp. when falling back. */
  note?: string
  /** Validation errors that triggered the fallback (observability only). */
  errors?: string[]
}

/** Read-only investigation tools so the planner can size up the repo first. */
const PLANNER_TOOLS = ['read_file', 'grep', 'glob', 'bash']

const PLANNER_RUBRIC = `\
你是一个独立的"任务编排规划 Agent"。你不执行任务，只为一个复杂目标设计一张**协作计划图**，交给固定引擎解释执行。

你可以用只读工具（read_file/grep/glob/bash）先了解工作区，但**不要修改任何文件**。

计划图的构成：
- 节点 node：kind 为 "executor"（干活：写代码/研究/改文件）或 "role"（审查角色，role 取 "verify"/"drift"/"reviewer" 等）。每个 node 必须有唯一 id、taskDescription（交给该子 Agent 的自然语言任务/审查标准，要自包含——子 Agent 看不到你的上下文）。
- 写文件的 executor 必须设 "workspaceMode": "isolated_write"（否则会被校验拒绝）；只读/审查节点用默认或 "shared_readonly"。
- 边 edge：{from,to,when?}，when 为 {"on":"always"} 或 {"on":"verdictLabel","label":"pass"|"fail"} 或 {"on":"verdictAction","action":"done"}。**回边即循环**：verify 节点 fail 时连回 generate 节点，就形成 generate→verify→fix 的修正环。
- entry：入口节点 id。
- bounds（强烈建议给出）：{maxNodeVisits,maxTotalSteps,maxTotalCostUsd,maxWallClockMs}，给循环设上限防止打转。

设计原则：
- 能并行的独立子任务拆成并行 executor 节点；有依赖的串行连边。
- 关键产出后挂一个 role:"verify" 节点校验是否达成目标；长流程中可挂 role:"drift" 审查航向。
- 图要尽量小而清晰；不要为简单目标过度拆分（简单目标一个 executor + 一个 verify 即可）。

**优雅终止（硬性要求，否则计划会被拒绝并要求你重做）：每一个环都必须能在某种 verdict 下离开。**
- 推荐做法：环上挂一个 verify 节点，它的 "pass" 路由到环外节点或不连任何出边（不匹配出边即自然终止），"fail" 才连回去重做。
- 反面例子（会被拒）：A→B→A 全是 {"on":"always"} 的无条件边——永远出不来，只能撞上限。
- 一句话：每个环里至少要有「一条带条件的逃逸边离开环」或「一个节点在完成时不匹配任何出边而终止」。

输出（关键）：只在最后一条消息里输出一个 JSON 代码块，形如：
\`\`\`json
{
  "id": "plan-1",
  "entry": "gen",
  "nodes": [
    {"id":"gen","kind":"executor","taskDescription":"...","allowedTools":["read_file","edit_file","bash"],"workspaceMode":"isolated_write"},
    {"id":"verify","kind":"role","role":"verify","taskDescription":"对照目标核对产出是否达成，给出 pass/fail"}
  ],
  "edges": [
    {"from":"gen","to":"verify"},
    {"from":"verify","to":"gen","when":{"on":"verdictLabel","label":"fail"}}
  ],
  "bounds": {"maxNodeVisits":5,"maxTotalSteps":40,"maxTotalCostUsd":5}
}
\`\`\`
不要在 JSON 之外解释。只输出这一个 JSON 代码块。`

function buildPlannerTask(goal: string): string {
  return [
    '【需要编排的目标】',
    goal,
    '',
    '请先（必要时）用只读工具了解工作区，然后设计计划图，最后只输出一个 OrchPlan 的 JSON 代码块。',
  ].join('\n')
}

/** Re-plan task: hand the previous output + the exact validation errors back. */
function buildPlannerRetryTask(goal: string, previousSummary: string, errors: string[]): string {
  return [
    '【需要编排的目标】',
    goal,
    '',
    '你上一次产出的计划【未通过校验】。请根据下面的错误修正，并重新输出**完整**的 OrchPlan JSON 代码块。',
    '',
    '【本次必须修复的校验错误】',
    errors.map(e => `- ${e}`).join('\n'),
    '',
    '【你上一次的产出（供参考，请勿原样照抄错误部分）】',
    previousSummary.length > 1500 ? previousSummary.slice(0, 1500) + '…' : previousSummary,
    '',
    '只输出修正后的完整 JSON 代码块，不要解释。',
  ].join('\n')
}

/**
 * The degenerate fallback: a single executor node that pursues the goal, with a
 * verify gate. This reproduces plain-auto behaviour and is ALWAYS valid, so the
 * run can proceed no matter what the planner did.
 */
export function singleExecutorPlan(goal: string): OrchPlan {
  return {
    id: 'fallback-single-executor',
    entry: 'execute',
    nodes: [
      {
        id: 'execute',
        kind: 'executor',
        taskDescription: goal,
        workspaceMode: 'isolated_write',
      },
      {
        id: 'verify',
        kind: 'role',
        role: 'verify',
        taskDescription: '对照原始目标核对产出是否真正达成，给出 pass/fail。',
      },
    ],
    edges: [
      { from: 'execute', to: 'verify' },
      { from: 'verify', to: 'execute', when: { on: 'verdictLabel', label: 'fail' } },
    ],
    bounds: { maxNodeVisits: 4, maxTotalSteps: 16, maxTotalCostUsd: 5 },
  }
}

/**
 * Extract and shape-normalise the last OrchPlan JSON block from the agent's
 * summary text. Returns null when nothing parseable is found. Normalisation is
 * defensive (coerces id/kind/arrays); structural correctness is left to
 * `validatePlan`, so a half-formed plan is rejected downstream and falls back.
 */
export function parseOrchPlan(text: string): OrchPlan | null {
  if (!text) return null
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1] ?? '')
  const candidates: string[] = fences.length ? [...fences] : []
  const lastBrace = text.lastIndexOf('{')
  if (lastBrace !== -1) candidates.push(text.slice(lastBrace))

  for (let i = candidates.length - 1; i >= 0; i--) {
    const raw = candidates[i]?.trim()
    if (!raw) continue
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>
      const plan = normalisePlan(obj)
      if (plan) return plan
    } catch {
      // try the next candidate
    }
  }
  return null
}

function normalisePlan(obj: Record<string, unknown>): OrchPlan | null {
  if (!obj || typeof obj !== 'object') return null
  if (typeof obj['entry'] !== 'string') return null
  if (!Array.isArray(obj['nodes']) || !Array.isArray(obj['edges'])) return null

  const nodes: OrchNode[] = (obj['nodes'] as unknown[]).map(n => {
    const o = (n ?? {}) as Record<string, unknown>
    const kind = o['kind'] === 'role' ? 'role' : o['kind'] === 'parallel' ? 'parallel' : 'executor'
    const node: OrchNode = {
      id: String(o['id'] ?? ''),
      kind,
      taskDescription: String(o['taskDescription'] ?? ''),
    }
    if (typeof o['role'] === 'string') node.role = o['role']
    if (Array.isArray(o['allowedTools'])) node.allowedTools = (o['allowedTools'] as unknown[]).map(String)
    if (typeof o['systemPrompt'] === 'string') node.systemPrompt = o['systemPrompt']
    if (typeof o['maxTurns'] === 'number') node.maxTurns = o['maxTurns']
    if (typeof o['maxBudgetUsd'] === 'number') node.maxBudgetUsd = o['maxBudgetUsd']
    if (o['workspaceMode'] === 'isolated_write' || o['workspaceMode'] === 'shared_readonly') {
      node.workspaceMode = o['workspaceMode']
    }
    if (kind === 'parallel') normaliseParallel(node, o)
    return node
  })

  const edges: OrchEdge[] = (obj['edges'] as unknown[]).map(e => {
    const o = (e ?? {}) as Record<string, unknown>
    const edge: OrchEdge = { from: String(o['from'] ?? ''), to: String(o['to'] ?? '') }
    const w = o['when'] as Record<string, unknown> | undefined
    if (w && typeof w['on'] === 'string') {
      if (w['on'] === 'always') edge.when = { on: 'always' }
      else if (w['on'] === 'verdictLabel' && typeof w['label'] === 'string') {
        edge.when = { on: 'verdictLabel', label: w['label'] }
      } else if (w['on'] === 'verdictAction' && typeof w['action'] === 'string') {
        edge.when = { on: 'verdictAction', action: w['action'] }
      }
    }
    return edge
  })

  const plan: OrchPlan = { entry: obj['entry'] as string, nodes, edges }
  if (typeof obj['id'] === 'string') plan.id = obj['id']
  const b = obj['bounds'] as Record<string, unknown> | undefined
  if (b && typeof b === 'object') {
    plan.bounds = {}
    for (const k of ['maxNodeVisits', 'maxTotalSteps', 'maxTotalCostUsd', 'maxWallClockMs'] as const) {
      if (typeof b[k] === 'number') plan.bounds[k] = b[k] as number
    }
  }
  return plan
}

/** Parse the parallel-specific fields (branches/join/quorum/integrator) onto a node. */
function normaliseParallel(node: OrchNode, o: Record<string, unknown>): void {
  if (Array.isArray(o['branches'])) {
    node.branches = (o['branches'] as unknown[]).map(x => {
      const b = (x ?? {}) as Record<string, unknown>
      const branch: ParallelBranch = {
        id: String(b['id'] ?? ''),
        taskDescription: String(b['taskDescription'] ?? ''),
      }
      if (typeof b['systemPrompt'] === 'string') branch.systemPrompt = b['systemPrompt']
      if (Array.isArray(b['allowedTools'])) branch.allowedTools = (b['allowedTools'] as unknown[]).map(String)
      if (typeof b['maxTurns'] === 'number') branch.maxTurns = b['maxTurns']
      if (typeof b['maxBudgetUsd'] === 'number') branch.maxBudgetUsd = b['maxBudgetUsd']
      if (b['workspaceMode'] === 'isolated_write' || b['workspaceMode'] === 'shared_readonly') {
        branch.workspaceMode = b['workspaceMode']
      }
      if (Array.isArray(b['writeScope'])) branch.writeScope = (b['writeScope'] as unknown[]).map(String)
      return branch
    })
  }
  if (o['join'] === 'all' || o['join'] === 'any' || o['join'] === 'quorum') node.join = o['join'] as JoinPolicy
  if (typeof o['quorum'] === 'number') node.quorum = o['quorum']
  if (typeof o['integrator'] === 'string') node.integrator = o['integrator']
}

/** Spawn the planner agent and block until terminal; return its summary text. */
async function runPlannerAgent(
  dispatcher: ISubAgentDispatcher,
  taskDescription: string,
  signal: AbortSignal,
): Promise<string | null> {
  const rec = await dispatcher.spawnSubAgent({
    config: {
      taskDescription,
      systemPrompt: PLANNER_RUBRIC,
      allowedTools: PLANNER_TOOLS,
      maxTurns: 12,
      maxBudgetUsd: 0.4,
      requireHumanApproval: false,
      useEventDriven: false,
      pollIntervalMs: 500,
      checkpointEveryNTurns: 0,
      // Reserved internal lane (see DriftAgent/VerifyJudge): never starved by
      // worker sub-agents sharing the bridge, nor blocked by the shared budget.
      internal: true,
      workspaceMode: 'shared_readonly',
    },
    abortSignal: signal,
  })

  const POLL_MS = 500
  const MAX_WAIT_MS = 12 * 2 * 60 * 1000
  const deadline = Date.now() + MAX_WAIT_MS
  let latest = rec
  while (!TERMINAL_STATUSES.has(latest.status)) {
    if (signal.aborted || Date.now() > deadline) break
    await new Promise(r => setTimeout(r, POLL_MS))
    const polled = await dispatcher.getStatus(rec.taskId)
    if (!polled) break
    latest = polled
  }
  if (latest.status !== 'completed') return null
  return latest.result?.summary ?? null
}

/**
 * Build the planner for an auto-orch session. Returns a function that produces a
 * runnable plan (planner's or fallback) for the current goal. Never throws.
 */
export function makeAutoOrchPlanner(
  deps: AutoOrchPlannerDeps,
): (signal: AbortSignal) => Promise<PlannerOutcome> {
  return async (signal: AbortSignal): Promise<PlannerOutcome> => {
    const goal = deps.getGoal()
    const fallback = (note: string, errors?: string[]): PlannerOutcome => ({
      plan: singleExecutorPlan(goal && goal.trim() ? goal : '继续推进当前目标。'),
      source: 'fallback',
      note,
      errors,
    })

    if (!goal || !goal.trim()) return fallback('goal missing')

    const maxAttempts = Math.max(1, deps.maxAttempts ?? 2)
    let lastErrors: string[] = []
    let lastSummary = ''

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // First attempt plans fresh; later attempts hand back the previous output
        // + the exact validation errors so the LLM RE-CREATES a corrected plan.
        const task = attempt === 1
          ? buildPlannerTask(goal)
          : buildPlannerRetryTask(goal, lastSummary, lastErrors)

        const summary = await runPlannerAgent(deps.dispatcher, task, signal)
        if (!summary) {
          lastErrors = ['planner agent returned no summary']
          continue
        }
        lastSummary = summary

        const parsed = parseOrchPlan(summary)
        if (!parsed) {
          lastErrors = ['no parseable OrchPlan JSON code block was found in your output']
          continue
        }

        const errors = validatePlan(parsed)
        if (errors.length === 0) {
          return {
            plan: parsed,
            source: 'planner',
            note: attempt > 1 ? `accepted on attempt ${attempt}` : undefined,
          }
        }
        lastErrors = errors // feed back on the next attempt
      }
      return fallback(`planner did not produce a valid plan within ${maxAttempts} attempts`, lastErrors)
    } catch (err) {
      return fallback(err instanceof Error ? err.message : String(err))
    }
  }
}
