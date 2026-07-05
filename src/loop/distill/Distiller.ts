/**
 * Distiller — one-shot LLM pass that turns a natural-language loop description
 * into a Charter draft (spec C9, §6.1). This is the planner's successor: it
 * runs ONCE at authoring time, its output is human-reviewed data, and every
 * validation error feeds the retry with the exact reason (the same feedback
 * loop that proved out in v1's planner).
 *
 * The distiller NEVER runs during loop execution — a charter, once approved,
 * is interpreted by the kernel alone.
 */
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import { spawnAndWait } from '../seatSpawn.js'
import type { Charter } from '../charter/CharterTypes.js'
import { validateCharter } from '../charter/CharterValidate.js'

const DISTILLER_SYSTEM = `\
你是 loop 章程蒸馏器。把用户的 loop 需求描述蒸馏成一份 Charter JSON——它是被内核逐条机械执行的契约，不是给人看的散文。

Charter 结构（全部字段；? 为可选）：
{
 "id": "kebab-case 标识",
 "version": 1,
 "goal": "一段话目标",
 "observables": [{"name":"new_findings","source":{"from":"judge","key":"new_findings_count"}}, …],
 "meters": [{"name":"iteration","inc":"every_round"},
            {"name":"stale_count","incWhen":"<表达式>","resetWhen":"<表达式>"}],
 "tripwires": [{"when":"<表达式>","then":{"mode":"pivot"|"finalize"|"attention"?, "escalate":"<名>"?, "stop":true?}}, …],
 "gates": {"state_gate":{"kind":"schema","files":["ledger/progress.json"]},
           "findings_gate":{"kind":"judge","evidence":["drafts/findings_draft.json","ledger/findings.jsonl"],"rubric":"…"}},
 "seats": {"worker":{"context":"lineage_loop"|"isolated","prompt":"<仅领域指令，见"座位底座">","tools":["read_file","edit_file","bash"],"budgetPerRound":{"usd":4,"turns":80}},
           "judge":{"context":"isolated","prompt":"…","inputs":["drafts/findings_draft.json","ledger/findings.jsonl"],"budgetPerRound":{"usd":0.5,"turns":10}},
           "pivoter":{"context":"isolated","prompt":"…","inputs":["ledger/directions.json","ledger/findings.jsonl"]}?},
 "budgets": {"perRound":{"usd":N},"lifetime":{"rounds":N,"usd":N}},
 "writeScope": ["repo 内允许 worker 修改的 glob"]?,
 "roundIntervalMs": N?,
 "waits": {"<名>":{"kind":"file","probeEveryMs":N,"params":{...},
   "rules":[{"when":"done","do":"wake_harvest"},{"when":"plateau","do":"terminate_and_harvest"},
            {"when":"no_balance","do":"rotate_and_resubmit"},{"when":"error","do":"wake_harvest"}]}}?
}

座位底座（worker 座位运行在内核内置的 inner_orch_worker 底座上，你无法改动它，但必须据此写 seat.prompt）：
- 底座**已自动提供**，seat.prompt 里**绝不要重复**：
  ① 座位身份（"你是本 loop 的 worker，只推进本轮、把结构化产出写入 drafts/、最后 return_result，不面向终端用户、不寒暄、不写用户报告"）；
  ② 基本纪律（读前改 / 换策略前先诊断 / 如实报告）；
  ③ 上下文约定（每轮 user 消息开头有 <context> 胶囊：目标/轮次/计数器/近期发现/已试方向/人工反馈/转向指令——底座已叮嘱先读它，遇到 --- 之后才是本轮指令）；
  ④ 可用 skill 清单（worker 自动看到，用 skill(action="load", name=…) 加载；例如训练用的 gm 由 skill 提供）；
  ⑤ 产出契约（先写 drafts/direction.json {"key","rationale"}，再写 drafts/findings_draft.json（数组，每条含 claim 与 evidence），最后调 return_result data={"label":"ok"|"error","note"}）；
  ⑥ 写入范围（由 charter.writeScope 下发，底座注入）；
  ⑦ 自计时等待工具 timer/timer_cancel（见下）。
- 长时外部任务有两种等待方式，按"判定是否需要判断"二选一：
  · **代码探针 wait（charter.waits + 规则表）**：探测判定是确定性阈值/换号（如平台期斜率、账号无余额换号）时用——探针纯代码、几乎免费，座位睡到规则结论才醒。写在 charter.waits 里。
  · **自计时 wait（worker 用 timer 工具）**：判定"继续等 vs 终止"需要 worker 亲眼看结果（如"平台期但晚期有抬头趋势就再等一轮"）时用——worker 调 timer(minutes, reason) 把自己 park，到点内核 resume 它自查自决；timer_cancel 防死循环。**这条不写进 charter，worker 用工具即可**；只需在 seat.prompt 里点明"提交训练后用 timer 定期回看、按趋势决定终止或继续"。自计时必须搭 context:"lineage_loop"（要记得上次曲线）。
- 因此 seat.prompt 只写**领域/角色特有**的指令：本 worker 每轮具体做什么、如何选方向、领域判断标准、用哪个工具/skill 做什么、提交训练/评测的领域细节。**不要**复述身份、输出格式（drafts/return_result）、"你是自主 agent"、"记得读胶囊"、skill 列表——底座已给，重复只会污染提示词、增加成本。目标写进 charter.goal（底座作为 D0 目标锚注入），不要抄进 seat.prompt。
- worker.context 二选一，决定底座的会话形态：
  · "lineage_loop"：跨轮 **resume 同一会话**、积累上下文——用于"在已有实现上持续迭代、调参、逐步推进"的 worker；
  · "isolated"：每轮**全新会话、无历史**，只凭本轮 <context> 独立判断——用于"需要跳出既有框架、推翻假设、换新证据源、避免自我叙事绑架"的 worker。
  · 若需求同时要"迭代推进"与"周期性推翻重来"，可用两类思路：迭代 worker 用 lineage_loop，靠 tripwire 的 mode:"pivot" 触发 pivoter（isolated）给出结构性转向。judge/pivoter 永远 "isolated"（D6）。

硬性规则：
- 表达式只能用已声明的 observables/meters 名与 budget.lifetime.exhausted；运算符仅 == != < <= > >= && || ! + - * / 与括号；不得出现函数调用。
- 至少一条 tripwire 能停止 loop（stop:true 或 mode:"finalize"）。声明顺序即优先级（最严重的在前）。
- judge/pivoter 的 context 必须是 "isolated"；确定性规则（计数、阈值、路由、盯外部任务、换号）必须落在 meters/tripwires/waits，**不得写进座位 prompt**。
- 长时外部任务（训练/远程评测）必须建模为 waits，探测节奏和终止/换号规则写成 rules；不要指望座位记得去检查。
- 禁止在任何 prompt/路径中出现 .meta-agent/。
- 需求中"每轮至少包含的阶段"映射：load_state→内核胶囊(忽略)；choose/implement/extract→worker prompt（只写领域动作，身份/输出/纪律/胶囊/skill 由底座给，见"座位底座"）；semantic_eval/verify→judge rubric；reduce/route/state_writer→meters+tripwires(忽略其实现细节)。

输出：必须调用 return_result，data 为 {"charter": <Charter JSON>, "taskSpec": "<task_spec.md 内容>"}。`

export interface DistillResult {
  charter: Charter
  taskSpec: string
  attempts: number
}

export interface DistillDeps {
  dispatcher: ISubAgentDispatcher
  signal?: AbortSignal
  maxAttempts?: number
}

export async function distillCharter(doc: string, deps: DistillDeps): Promise<DistillResult> {
  const maxAttempts = deps.maxAttempts ?? 3
  const signal = deps.signal ?? new AbortController().signal
  let lastErrors: string[] = []
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const task = [
      attempt > 1
        ? `你上一次的章程未通过校验，必须修复：\n- ${lastErrors.join('\n- ')}\n请输出修正后的完整 charter。`
        : null,
      '【loop 需求描述】',
      doc,
    ].filter(Boolean).join('\n\n')

    const rec = await spawnAndWait(
      deps.dispatcher,
      {
        taskDescription: task,
        systemPrompt: DISTILLER_SYSTEM,
        allowedTools: ['read_file', 'grep', 'glob'],
        maxTurns: 20,
        maxBudgetUsd: 1.5,
        requireHumanApproval: false,
        useEventDriven: false,
        pollIntervalMs: 500,
        checkpointEveryNTurns: 0,
      },
      signal,
    )
    const parsed = parseDistillOutput(rec?.result?.output, rec?.result?.summary)
    if (!parsed) {
      lastErrors = ['no parseable {charter, taskSpec} payload in return_result']
      continue
    }
    const errs = validateCharter(parsed.charter)
    if (errs.length === 0) {
      return { charter: parsed.charter, taskSpec: parsed.taskSpec, attempts: attempt }
    }
    lastErrors = errs
  }
  throw new Error(`distiller failed after ${maxAttempts} attempts:\n- ${lastErrors.join('\n- ')}`)
}

function parseDistillOutput(
  output: unknown,
  summary?: string,
): { charter: Charter; taskSpec: string } | null {
  const candidates: unknown[] = [output]
  if (typeof output === 'string') candidates.push(tryJson(output))
  if (summary) {
    for (const m of summary.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(tryJson(m[1] ?? ''))
  }
  for (const c of candidates) {
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const obj = c as Record<string, unknown>
      const charter = obj['charter']
      if (charter && typeof charter === 'object') {
        return {
          charter: charter as Charter,
          taskSpec: typeof obj['taskSpec'] === 'string' ? obj['taskSpec'] : '',
        }
      }
    }
  }
  return null
}

function tryJson(s: string): unknown {
  try { return JSON.parse(s.trim()) } catch { return null }
}
