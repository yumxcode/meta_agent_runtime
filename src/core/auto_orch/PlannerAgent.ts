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
 * single-executor plan with an explicit verify role (one executor pursuing the
 * goal, then graph-level review), flagged `source: 'fallback'` so the host can
 * observe it.
 *
 * This module does the PLANNING half only. Executing the plan's nodes against
 * real kernel sub-agents (the NodeRunner wiring) is the separate execution half.
 */
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import { DEFAULT_SUB_AGENT_MAX_DURATION_MS, TERMINAL_STATUSES } from '../../subagent/types.js'
import type { SubAgentRuntimeEvent } from '../../subagent/SubAgentBridge.js'
import type { MetaAgentEvent } from '../types.js'
import { SessionStore } from '../SessionStore.js'
import { notifyAutoOrchObserver, type AutoOrchObserver } from './Observer.js'
import {
  validatePlan,
  type OrchPlan,
  type OrchNode,
  type OrchEdge,
  type ParallelBranch,
  type JoinPolicy,
  type CodeNodeSpec,
} from './LoopIR.js'
import { randomUUID } from 'crypto'
import { loadAutoOrchPlan, type AutoOrchStoredPlanRef } from './PlanStore.js'

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
  /** Optional host-mediated, planner-only review of validated draft plans. */
  plannerReview?: AutoOrchPlannerReviewConfig
  /** Optional observability sink for planner attempts. */
  observer?: AutoOrchObserver
  /** Optional saved plan id/version to reuse as the starting graph. */
  planRef?: string
  /** Optional instruction to revise the saved plan before execution. */
  planRevision?: string
}

export interface AutoOrchPlannerReviewConfig {
  enabled?: boolean
  maxRounds?: number
  askUser?: (question: string, choices?: string[]) => Promise<string>
}

/** Outcome of a planning attempt. `plan` is ALWAYS a valid, runnable plan. */
export interface PlannerOutcome {
  /** A validated plan — either the planner's, or the degenerate fallback. */
  plan: OrchPlan
  /** Where the plan came from. */
  source: 'planner' | 'saved' | 'fallback'
  /** True only when an interactive user explicitly approved the graph. */
  approvedByUser?: boolean
  /** Saved plan ref used as the seed, when present. */
  seedPlanRef?: AutoOrchStoredPlanRef
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

## 节点 node（三种 kind）
每个 node 必须有唯一 id 和**自包含**的 taskDescription（子 Agent 看不到你的上下文，所需信息都要写进去）。
**taskDescription 长度硬性限制**：每个节点限 2-3 句话（合计 ≤200 字）。只写核心指令 + 必要约束（要读写哪些文件、产出什么、禁止什么）。
**不要**在 taskDescription 里写完整的操作手册、代码分析步骤或论文摘要——子 Agent 执行时会自行探查工作区。
- "executor"：干活（写代码/研究/改文件）。写文件的 executor **必须** "workspaceMode":"isolated_write"，否则被校验拒绝；只读用 "shared_readonly"。
- "role"：审查角色，role 取 "verify"（完成度审查）或 "reviewer"（通用只读复核）。审查节点只读，不产出代码；只用于语义性强、错误代价高、会污染长期结果/最终交付的关键产出。
- "parallel"：**并发组**——需要**同时**跑的多个独立子任务放进**一个** parallel 节点的 branches 里（见下）。
- "code"：确定性代码节点。你只声明 codeSpec/input/capabilities，不直接写源码；框架会在执行前用专门 code_author 生成源码、review、落盘成 codeRef+sourceHash，然后冻结执行。

## 节点执行预算（maxTurns / maxBudgetUsd）
- executor 默认 turn 预算较小，只适合短任务。若节点需要长日志分析、实验状态排查、跨文件研究、生成较大 JSON/报告、或可能启动/接管训练任务，必须显式设置 "maxTurns"（建议 60-120）和合理的 "maxBudgetUsd"。
- 对复杂或关键 executor，"maxBudgetUsd" 可以设得更充足（例如 2-8，确有必要可更高），让子 Agent 有足够预算完成读文件、分析、工具调用和落盘；不要因为预算过低导致节点半途失败。注意单节点预算仍受全局子 Agent 总预算约束。
- 不要把复杂研究+训练+落盘塞进低预算节点；要么拆分节点，要么同时调大该节点 maxTurns 与 maxBudgetUsd。长训练等待仍必须用 auto_orch_pause_external 暂停，不能靠大 maxTurns 阻塞等待。
- parallel.branches 也支持 maxTurns/maxBudgetUsd；复杂分支同样要显式设置。

## 关键：节点产出的 label（边据此路由，务必对应）
- executor → "ok"（成功） / "error"（执行失败）
- role(verify/reviewer) → "pass"（通过） / "fail"（未通过，会携带具体未达成项）
- parallel → "ok"（达成 join 且合并成功） / "fail"（未达成或合并失败）
- code → 由 codeSpec.labels 声明的 label，或 "error"（执行/契约失败）
例：要表达"executor B 失败则去 D"，边用 "label":"error"（不是 "fail"）；"verify 不通过则回 gen"用 "label":"fail"。

## 并行（parallel 节点）——这是唯一的并行方式
**多个 executor 节点不会并行，它们串行执行。** 真正并行 = 一个 "kind":"parallel" 节点：
\`\`\`json
{"id":"build","kind":"parallel","taskDescription":"并行实现各模块","join":"all","integrator":"integrator",
 "branches":[
   {"id":"auth","taskDescription":"实现鉴权模块","allowedTools":["read_file","edit_file","bash"],"workspaceMode":"isolated_write","writeScope":["src/auth/**"]},
   {"id":"api","taskDescription":"实现API模块","allowedTools":["read_file","edit_file","bash"],"workspaceMode":"isolated_write","writeScope":["src/api/**"]}
 ]}
\`\`\`
- branches：每个分支自己一个子 Agent + 独立 git 分支；字段同 executor，外加 **writeScope**（该分支只许写的路径 glob）。
- join："all"（默认，全成功）/"any"（≥1）/"quorum"（配合 quorum 数）。
- **L1 写域规则（硬性）**：写文件的分支**必须**声明 writeScope；任意两个 writer 的写域要么**不相交**（如 src/auth/** vs src/api/**，则合并零冲突），要么就**声明 "integrator" 角色**来解决冲突合并。重叠又没 integrator 会被校验拒绝。
- 并行只读（多路调研/多角度审查）无需 writeScope。
- **外部等待硬性限制**：任何可能启动长训练、远程评测、批处理实验，或需要等待外部结果/定时检查的任务，**不得放入 parallel.branches**。这类任务必须建成普通 "executor" 串行节点；该 executor 启动外部任务后会通过 auto_orch_pause_external 暂停整个 orchestration，由框架 scheduler 恢复同一个子 Agent session。parallel 只用于无需 pause 的短任务/独立实现/只读调研。

## 确定性代码节点（code）
当某一步是机械状态归约、计数器更新、JSON/JSONL 落盘、路由标签计算时，优先用 code 节点，而不是让 executor 用自然语言手写状态。
你只写规格，不写代码：
\`\`\`json
{"id":"reduce_progress","kind":"code","taskDescription":"更新 stale_count 并返回路由标签",
 "codeSpec":{"description":"读取 state/progress.json 与 state/iteration_eval.json；若 newFindingsCount<=0 或 metricDelta<0 则 stale_count+1，否则清零；返回 healthy/stale/pivot_required/attention_required。","inputs":["state/progress.json","state/iteration_eval.json"],"outputs":["state/progress.json"],"labels":["healthy","stale","pivot_required","attention_required"]},
 "input":{"taskDir":".meta-agent/research/task-001"},
 "capabilities":["state.read","state.write","jsonl.append"],
 "codeBounds":{"timeoutMs":3000,"maxOutputBytes":65536}}
\`\`\`
code 节点在规划输出里不要包含 codeRef/sourceHash；这些由框架冻结后补齐。

## 边 edge
{from,to,when?}，when 为 {"on":"always"} 或 {"on":"verdictLabel","label":"..."} 或 {"on":"verdictAction","action":"..."}。
按声明顺序取**第一条命中**的边；无命中边即终止。**回边即循环**（例如 reviewer/verify fail 连回 gen = 修正环）。

## 优雅终止（硬性，否则计划被拒并要求你重做）
每一个环都必须能在某 verdict 下离开：环上必须有条件分支能退出，常见做法是用 reviewer/verify 的 "pass" 路由到环外或**不连任何出边**（不匹配即自然终止），"fail" 才连回重做。不要为了满足退出条件给每个中间状态都加 role 节点。
反面例子（会被拒）：A→B→A 全是 {"on":"always"} 无条件边——永远出不来。

## 设计原则
- 同时跑的独立子任务 → 一个 parallel 节点；有依赖的串行连边。
- 只在语义性强、错误代价高、会污染长期结果/最终交付的关键产出后使用 role:"verify" 或 role:"reviewer"。机械格式检查、schema 校验、计数器更新、路由判断必须优先用 code 节点，不要用 role verify。
- 每个循环默认最多 1 个语义审查 role；除非目标高风险或产物跨模块影响大，不要在每个状态写入后加 verify。状态机/研究循环不应把每个中间状态都挂 verify。
- 图小而清晰；简单目标可以 executor + verify，复杂状态流优先 code 节点 + 少量关键语义审查，不要过度拆分。
- entry=入口 id；bounds（建议）={maxNodeVisits,maxTotalSteps,maxTotalCostUsd,maxWallClockMs} 给循环设上限。

## 输出（必须用 return_result 提交完整 OrchPlan）
完成后，**必须调用 return_result 工具**提交结果：
- \`data\` 参数 = **OrchPlan JSON 对象本身**（完整的 {entry,nodes,edges,bounds} 结构，不是字符串、不是描述）——它是权威通道，不会被截断。
- \`summary\` 参数 = 一句话概述（如"16 节点研究循环，含训练+审查+pivot"）。

OrchPlan 的 JSON 结构范例（最终出现在 return_result.data 里的就是这种结构）：
范例 A（修正环）：
\`\`\`json
{"id":"plan","entry":"gen","nodes":[
  {"id":"gen","kind":"executor","taskDescription":"...","allowedTools":["read_file","edit_file","bash"],"workspaceMode":"isolated_write","maxTurns":80,"maxBudgetUsd":1.0},
  {"id":"verify","kind":"role","role":"verify","taskDescription":"对照目标核对产出是否达成，给出 pass/fail"}
],"edges":[
  {"from":"gen","to":"verify"},
  {"from":"verify","to":"gen","when":{"on":"verdictLabel","label":"fail"}}
],"bounds":{"maxNodeVisits":5,"maxTotalSteps":40,"maxTotalCostUsd":5}}
\`\`\`
范例 B（条件分支：B 成功→C，B 失败→D）：
\`\`\`json
{"entry":"A","nodes":[
  {"id":"A","kind":"executor","taskDescription":"..."},
  {"id":"B","kind":"executor","taskDescription":"..."},
  {"id":"C","kind":"executor","taskDescription":"..."},
  {"id":"D","kind":"executor","taskDescription":"修复 B 的失败"}
],"edges":[
  {"from":"A","to":"B"},
  {"from":"B","to":"C","when":{"on":"verdictLabel","label":"ok"}},
  {"from":"B","to":"D","when":{"on":"verdictLabel","label":"error"}}
]}
\`\`\``

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
 * Resume retry task: used when the previous conversation history is injected via
 * initialMessages. The model already has its full prior context (exploration +
 * previous output), so we only need to tell it what went wrong and ask it to fix.
 */
function buildPlannerResumeTask(errors: string[]): string {
  return [
    '你上一次的输出未通过校验。请根据下面的错误修正，并重新输出**完整**的 OrchPlan JSON 代码块。',
    '',
    '【本次必须修复的校验错误】',
    errors.map(e => `- ${e}`).join('\n'),
    '',
    '注意：你可以看到之前的完整对话历史（包括你对工作区的探查结果）。',
    '请基于已有理解直接修正输出，不要重复探查工作区。',
    '',
    '只输出修正后的完整 JSON 代码块，不要解释。',
  ].join('\n')
}

function buildPlannerRevisionTask(goal: string, plan: OrchPlan, feedback: string): string {
  return [
    '【需要编排的目标】',
    goal,
    '',
    '用户刚刚审阅了你产出的 OrchPlan 草图，并要求修改。请根据反馈重新输出完整 OrchPlan JSON 代码块。',
    '',
    '【用户反馈】',
    feedback,
    '',
    '【当前草图】',
    JSON.stringify(plan, null, 2),
    '',
    '只输出修正后的完整 JSON 代码块，不要解释。',
  ].join('\n')
}

/**
 * The degenerate fallback: a single executor node that pursues the goal, with a
 * graph-level verify role. It is ALWAYS valid, so the run can proceed no matter
 * what the planner did without relying on hidden auto gates.
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
        // Must mirror the planner's executor toolset (see the PLANNER examples):
        // an isolated_write node with NO allowedTools resolves to ZERO tools
        // (SubAgentRunner._resolveToolsWithSandbox treats [] as "no tools"),
        // leaving the fallback agent able only to chat — it cannot read/edit/test.
        allowedTools: ['read_file', 'edit_file', 'write_file', 'grep', 'glob', 'bash'],
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

/**
 * Extract an OrchPlan from a planner sub-agent's result. Prefers the structured
 * `output` (from return_result.data — up to 512KB, never truncated) over the
 * `summary` text (truncated to SUMMARY_MAX_CHARS). This is critical for large
 * plans whose JSON alone exceeds the summary cap and gets head-truncated.
 */
function parsePlannerResult(summary: string | null, output?: unknown): OrchPlan | null {
  // 1. Structured output: return_result.data is already a parsed JSON object.
  //    Call normalisePlan directly — no string parsing needed.
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const plan = normalisePlan(output as Record<string, unknown>)
    if (plan && plan.nodes.length > 0) return plan
  }
  // 2. Output as string: might be a JSON string of the plan.
  if (typeof output === 'string' && output.trim()) {
    const parsed = parseOrchPlan(output)
    if (parsed) return parsed
  }
  // 3. Fall back to summary text (may be truncated — best effort).
  if (summary) return parseOrchPlan(summary)
  return null
}
function normalisePlan(obj: Record<string, unknown>): OrchPlan | null {
  if (!obj || typeof obj !== 'object') return null
  if (typeof obj['entry'] !== 'string') return null
  if (!Array.isArray(obj['nodes']) || !Array.isArray(obj['edges'])) return null

  const nodes: OrchNode[] = (obj['nodes'] as unknown[]).map(n => {
    const o = (n ?? {}) as Record<string, unknown>
    const kind = o['kind'] === 'role'
      ? 'role'
      : o['kind'] === 'parallel'
        ? 'parallel'
        : o['kind'] === 'code'
          ? 'code'
          : 'executor'
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
    if (kind === 'code') normaliseCodeNode(node, o)
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

/** Parse code-node fields while leaving materialisation to AutoOrchController. */
function normaliseCodeNode(node: OrchNode, o: Record<string, unknown>): void {
  if (typeof o['codeRef'] === 'string') node.codeRef = o['codeRef']
  if (typeof o['sourceHash'] === 'string') node.sourceHash = o['sourceHash']
  const spec = o['codeSpec'] as Record<string, unknown> | undefined
  if (spec && typeof spec === 'object') {
    const codeSpec: CodeNodeSpec = {
      description: String(spec['description'] ?? ''),
    }
    if (Array.isArray(spec['inputs'])) codeSpec.inputs = (spec['inputs'] as unknown[]).map(String)
    if (Array.isArray(spec['outputs'])) codeSpec.outputs = (spec['outputs'] as unknown[]).map(String)
    if (Array.isArray(spec['labels'])) codeSpec.labels = (spec['labels'] as unknown[]).map(String)
    node.codeSpec = codeSpec
  }
  const input = o['input']
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    node.input = input as Record<string, unknown>
  }
  if (Array.isArray(o['capabilities'])) node.capabilities = (o['capabilities'] as unknown[]).map(String)
  const b = o['codeBounds'] as Record<string, unknown> | undefined
  if (b && typeof b === 'object') {
    node.codeBounds = {}
    if (typeof b['timeoutMs'] === 'number') node.codeBounds.timeoutMs = b['timeoutMs']
    if (typeof b['maxOutputBytes'] === 'number') node.codeBounds.maxOutputBytes = b['maxOutputBytes']
  }
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

/**
 * Spawn the planner agent and block until terminal; return its summary text.
 *
 * On the FIRST attempt `plannerSessionId` is generated by the caller and set in
 * the spawn config as `autoOrch.agentSessionId` so SubAgentRunner persists the
 * full conversation history to SessionStore when the run finishes.
 *
 * On a RETRY the caller loads that history and passes it as `initialMessages`,
 * so the new sub-agent starts with the complete previous context (exploration,
 * reasoning, prior output) — the model can fix its output without re-exploring
 * the codebase. The retry `taskDescription` is the error feedback message.
 */
async function runPlannerAgent(
  dispatcher: ISubAgentDispatcher,
  taskDescription: string,
  signal: AbortSignal,
  observer: AutoOrchObserver | undefined,
  attempt: number,
  plannerSessionId: string,
  initialMessages?: import('../types.js').ConversationMessage[],
): Promise<{ summary: string | null; output?: unknown; error?: string }> {
  if (signal.aborted) return { summary: null, error: 'planner aborted before start' }
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
      // Mark resumable + assign a stable session id so SubAgentRunner persists
      // the full conversation history. On retry we reload it as initialMessages.
      autoOrch: {
        resumable: true,
        orchestrationTaskId: plannerSessionId,
        nodeId: 'planner',
        agentSessionId: plannerSessionId,
      },
      ...(initialMessages ? { initialMessages } : {}),
    },
    abortSignal: signal,
    onRuntimeEvent: event => {
      const formatted = formatPlannerSubAgentEvent(event, attempt)
      if (formatted) void notifyAutoOrchObserver(observer, formatted)
    },
  })

  const POLL_MS = 500
  const MAX_WAIT_MS = DEFAULT_SUB_AGENT_MAX_DURATION_MS + 60_000
  const deadline = Date.now() + MAX_WAIT_MS
  let latest = rec
  while (!TERMINAL_STATUSES.has(latest.status)) {
    if (signal.aborted || Date.now() > deadline) break
    await new Promise(r => setTimeout(r, POLL_MS))
    const polled = await dispatcher.getStatus(rec.taskId)
    if (!polled) break
    latest = polled
  }
  if (!TERMINAL_STATUSES.has(latest.status) && signal.aborted) {
    await dispatcher.cancelTask(rec.taskId, 'planner aborted').catch(() => undefined)
  }
  if (latest.status !== 'completed') {
    return {
      summary: null,
      error: latest.result?.error ?? `planner sub-agent ${latest.status}`,
    }
  }
  if (!latest.result?.summary && latest.result?.output === undefined) {
    return { summary: null, error: latest.result?.error ?? 'planner agent returned no summary' }
  }
  // Return BOTH summary (text, may be truncated) and output (structured data from
  // return_result, up to 512KB, never truncated). The caller prefers output for
  // plan parsing so large plans survive intact.
  return { summary: latest.result.summary, output: latest.result.output }
}

function formatPlannerSubAgentEvent(event: SubAgentRuntimeEvent, attempt: number) {
  if (event.type === 'runner_started') {
    return {
      type: 'planner_subagent_event' as const,
      attempt,
      taskId: event.taskId,
      eventType: 'runner_started',
    }
  }
  if (event.type === 'session_submit_started') {
    return {
      type: 'planner_subagent_event' as const,
      attempt,
      taskId: event.taskId,
      eventType: 'model_call_started',
    }
  }
  const summary = summarizeMetaAgentEvent(event.event)
  if (!summary) return null
  return {
    type: 'planner_subagent_event' as const,
    attempt,
    taskId: event.taskId,
    eventType: summary.eventType,
    ...(summary.toolName ? { toolName: summary.toolName } : {}),
    ...(summary.preview ? { preview: summary.preview } : {}),
    ...(summary.isError !== undefined ? { isError: summary.isError } : {}),
  }
}

function summarizeMetaAgentEvent(event: MetaAgentEvent): {
  eventType: string
  toolName?: string
  preview?: string
  isError?: boolean
} | null {
  switch (event.type) {
    case 'thinking_delta':
    case 'text':
    case 'tool_use':
    case 'tool_result':
    case 'stream_event':
    case 'compact_start':
    case 'compact_boundary':
      return null
    case 'api_retry':
      return {
        eventType: 'api_retry',
        preview: `attempt ${event.attempt}/${event.maxRetries}, delay ${event.retryDelayMs}ms`,
      }
    case 'system_message':
      return { eventType: `system_${event.subtype}`, preview: compactPreview(event.text, 180) }
    case 'compact_failed':
      return {
        eventType: 'compact_failed',
        preview: compactPreview(event.error, 180),
        isError: true,
      }
    case 'result':
      return {
        eventType: 'result',
        preview: `${event.subtype}, turns=${event.numTurns}, cost=$${event.totalCostUsd.toFixed(3)}`,
        isError: event.isError,
      }
  }
}

function compactPreview(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= max ? compact : compact.slice(0, max - 3) + '...'
}

/**
 * Build the planner for an auto_orch session. Returns a function that produces a
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
    const trimmedGoal = goal.trim()

    const maxAttempts = Math.max(1, deps.maxAttempts ?? 2)
    const review = normaliseReviewConfig(deps.plannerReview)
    let lastErrors: string[] = []
    let lastSummary = ''
    let revisionTask: string | null = null
    let invalidAttempts = 0
    let seedPlanRef: AutoOrchStoredPlanRef | undefined
    // Stable session id for resume: the first attempt's conversation history is
    // persisted to SessionStore; retries reload it so the model keeps its prior
    // exploration context instead of starting from scratch each time.
    const plannerSessionId = `auto-orch-planner-${randomUUID()}`
    let firstAttemptDone = false

    try {
      const totalAttempts = maxAttempts + (review.enabled ? review.maxRounds : 0)
      await notifyAutoOrchObserver(deps.observer, {
        type: 'planner_started',
        maxAttempts: totalAttempts,
        maxInvalidAttempts: maxAttempts,
        reviewEnabled: review.enabled,
      })
      if (deps.planRef) {
        const loaded = await loadAutoOrchPlan(deps.projectDir, deps.planRef)
        if (!loaded) return fallback(`saved auto_orch plan not found: ${deps.planRef}`)
        const seedErrors = validatePlan(loaded.plan, { allowUnmaterializedCode: true })
        if (seedErrors.length) {
          return fallback(`saved auto_orch plan is invalid: ${seedErrors.join('; ')}`, seedErrors)
        }
        seedPlanRef = loaded.ref
        if (deps.planRevision?.trim()) {
          revisionTask = buildPlannerRevisionTask(trimmedGoal, loaded.plan, deps.planRevision.trim())
        } else {
          const reviewDecision = await reviewPlanIfRequested(loaded.plan, trimmedGoal, review)
          if (reviewDecision.action === 'cancel') return fallback('saved plan review cancelled by user')
          if (reviewDecision.action === 'revise') {
            revisionTask = buildPlannerRevisionTask(trimmedGoal, loaded.plan, reviewDecision.feedback)
          } else {
            const out: PlannerOutcome = {
              plan: loaded.plan,
              source: 'saved',
              approvedByUser: reviewDecision.approvedByUser,
              seedPlanRef,
              note: `loaded saved plan ${loaded.ref.planId}@v${loaded.ref.version}`,
            }
            await notifyAutoOrchObserver(deps.observer, {
              type: 'planner_completed',
              source: out.source,
              note: out.note,
            })
            return out
          }
        }
      }
      for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        if (signal.aborted) return fallback('planner aborted by user', lastErrors)

        // Resume: on retry (attempt > 1), reload the first attempt's full
        // conversation history from SessionStore and inject it as initialMessages
        // so the model starts with all its prior exploration — it only needs to
        // fix its output format, not re-read the entire codebase.
        let initialMessages: import('../types.js').ConversationMessage[] | undefined
        if (firstAttemptDone) {
          try {
            initialMessages = await SessionStore.loadHistory(plannerSessionId)
          } catch {
            // History unavailable — fall back to a fresh spawn (original behaviour)
          }
        }
        const resumed = !!initialMessages

        const reason = revisionTask
          ? 'user_revision'
          : attempt === 1
            ? 'initial'
            : resumed
              ? 'validation_retry'
              : 'validation_retry'
        // When resuming, use the lean resume task (model already has full context);
        // otherwise use the full retry task (includes truncated previous output).
        const task = revisionTask ?? (attempt === 1
          ? buildPlannerTask(goal)
          : resumed
            ? buildPlannerResumeTask(lastErrors)
            : buildPlannerRetryTask(goal, lastSummary, lastErrors))
        revisionTask = null
        await notifyAutoOrchObserver(deps.observer, {
          type: 'planner_attempt_started',
          attempt,
          maxAttempts: totalAttempts,
          reason,
        })

        const plannerRun = await runPlannerAgent(
          deps.dispatcher, task, signal, deps.observer, attempt,
          plannerSessionId, initialMessages,
        )
        firstAttemptDone = true
        const summary = plannerRun.summary
        if (signal.aborted) return fallback('planner aborted by user', lastErrors)
        if (!summary) {
          lastErrors = [plannerRun.error ?? 'planner agent returned no summary']
          invalidAttempts++
          await notifyAutoOrchObserver(deps.observer, {
            type: 'planner_attempt_failed',
            attempt,
            errors: lastErrors,
          })
          if (invalidAttempts >= maxAttempts) {
            const out = fallback(`planner did not produce a valid plan within ${maxAttempts} attempts`, lastErrors)
            await notifyAutoOrchObserver(deps.observer, {
              type: 'planner_completed',
              source: out.source,
              note: out.note,
            })
            return out
          }
          continue
        }
        lastSummary = summary

        // Prefer the structured output (return_result.data, untruncated) over
        // the summary text (may be head-truncated for large plans).
        const parsed = parsePlannerResult(summary, plannerRun.output)
        if (!parsed) {
          lastErrors = ['no parseable OrchPlan JSON code block was found in your output']
          invalidAttempts++
          await notifyAutoOrchObserver(deps.observer, {
            type: 'planner_attempt_failed',
            attempt,
            errors: lastErrors,
          })
          if (invalidAttempts >= maxAttempts) {
            const out = fallback(`planner did not produce a valid plan within ${maxAttempts} attempts`, lastErrors)
            await notifyAutoOrchObserver(deps.observer, {
              type: 'planner_completed',
              source: out.source,
              note: out.note,
            })
            return out
          }
          continue
        }

        const errors = validatePlan(parsed, { allowUnmaterializedCode: true })
        if (errors.length === 0) {
          invalidAttempts = 0
          const reviewDecision = await reviewPlanIfRequested(parsed, goal, review)
          if (reviewDecision.action === 'cancel') {
            return fallback('planner review cancelled by user')
          }
          if (reviewDecision.action === 'revise') {
            revisionTask = buildPlannerRevisionTask(goal, parsed, reviewDecision.feedback)
            lastErrors = ['user requested plan revision']
            continue
          }
          const out: PlannerOutcome = {
            plan: parsed,
            source: 'planner',
            approvedByUser: reviewDecision.approvedByUser,
            seedPlanRef,
            note: attempt > 1 ? `accepted on attempt ${attempt}` : undefined,
          }
          await notifyAutoOrchObserver(deps.observer, {
            type: 'planner_completed',
            source: out.source,
            note: out.note,
          })
          return out
        }
        lastErrors = errors // feed back on the next attempt
        invalidAttempts++
        await notifyAutoOrchObserver(deps.observer, {
          type: 'planner_attempt_failed',
          attempt,
          errors: lastErrors,
        })
        if (invalidAttempts >= maxAttempts) {
          const out = fallback(`planner did not produce a valid plan within ${maxAttempts} attempts`, lastErrors)
          await notifyAutoOrchObserver(deps.observer, {
            type: 'planner_completed',
            source: out.source,
            note: out.note,
          })
          return out
        }
      }
      const out = fallback(`planner did not produce a valid plan within ${totalAttempts} attempts`, lastErrors)
      await notifyAutoOrchObserver(deps.observer, {
        type: 'planner_completed',
        source: out.source,
        note: out.note,
      })
      return out
    } catch (err) {
      const out = fallback(err instanceof Error ? err.message : String(err))
      await notifyAutoOrchObserver(deps.observer, {
        type: 'planner_completed',
        source: out.source,
        note: out.note,
      })
      return out
    }
  }
}

function normaliseReviewConfig(
  cfg: AutoOrchPlannerReviewConfig | undefined,
): { enabled: boolean; maxRounds: number; askUser?: (question: string, choices?: string[]) => Promise<string>; rounds: number } {
  return {
    enabled: cfg?.enabled === true && typeof cfg.askUser === 'function',
    maxRounds: Math.max(1, cfg?.maxRounds ?? 3),
    askUser: cfg?.askUser,
    rounds: 0,
  }
}

async function reviewPlanIfRequested(
  plan: OrchPlan,
  goal: string,
  review: { enabled: boolean; maxRounds: number; askUser?: (question: string, choices?: string[]) => Promise<string>; rounds: number },
): Promise<{ action: 'approve'; approvedByUser: boolean } | { action: 'revise'; feedback: string } | { action: 'cancel' }> {
  if (!review.enabled || !review.askUser || review.rounds >= review.maxRounds) {
    return { action: 'approve', approvedByUser: false }
  }
  review.rounds++
  const answer = await review.askUser(
    renderPlanForReview(plan, goal, review.rounds, review.maxRounds),
    ['Approve plan', 'Revise plan', 'Cancel run'],
  )
  const norm = answer.trim().toLowerCase()
  if (norm.startsWith('cancel')) return { action: 'cancel' }
  if (norm.startsWith('revise')) {
    const feedback = await review.askUser('请描述希望 planner 如何修改这张 auto_orch 图。')
    return feedback.trim()
      ? { action: 'revise', feedback: feedback.trim() }
      : { action: 'approve', approvedByUser: true }
  }
  return { action: 'approve', approvedByUser: true }
}

export function renderPlanForReview(plan: OrchPlan, goal: string, round: number, maxRounds: number): string {
  const lines: string[] = []
  lines.push(`auto_orch planner 已生成一张候选图（review ${round}/${maxRounds}）。`)
  lines.push('')
  lines.push('【目标摘要】')
  lines.push(compactLine(goal, 500))
  lines.push('')
  lines.push(`【图摘要】nodes=${plan.nodes.length}, edges=${plan.edges.length}, entry=${plan.entry}`)
  lines.push('')
  lines.push('【节点摘要】')
  for (const n of plan.nodes) {
    const extra = n.kind === 'role'
      ? ` role=${n.role ?? 'reviewer'}`
      : n.kind === 'code'
        ? ` code=${n.codeRef ? 'frozen' : 'spec'} labels=${n.codeSpec?.labels?.join('|') ?? '(unspecified)'}`
        : n.kind === 'parallel'
          ? ` branches=${n.branches?.length ?? 0} join=${n.join ?? 'all'}`
          : ''
    lines.push(`- ${n.id}: ${n.kind}${extra} — ${compactLine(n.taskDescription, 100)}`)
  }
  lines.push('')
  lines.push('【边】')
  for (const e of plan.edges) {
    const when = e.when
      ? e.when.on === 'verdictLabel'
        ? `label:${e.when.label}`
        : e.when.on === 'verdictAction'
          ? `action:${e.when.action}`
          : 'always'
      : 'always'
    lines.push(`- ${e.from} -> ${e.to} [${when}]`)
  }
  if (plan.bounds) {
    lines.push('')
    lines.push(`【bounds】 ${JSON.stringify(plan.bounds)}`)
  }
  lines.push('')
  lines.push('请选择批准执行、要求 planner 修改，或取消本次 auto_orch 运行。')
  return lines.join('\n')
}

function compactLine(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}...` : oneLine
}
