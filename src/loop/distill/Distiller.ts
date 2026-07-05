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
 "seats": {"worker":{"context":"lineage_round","prompt":"…","tools":["read_file","edit_file","bash"],"budgetPerRound":{"usd":4,"turns":80}},
           "judge":{"context":"isolated","prompt":"…","inputs":["drafts/findings_draft.json","ledger/findings.jsonl"],"budgetPerRound":{"usd":0.5,"turns":10}},
           "pivoter":{"context":"isolated","prompt":"…","inputs":["ledger/directions.json","ledger/findings.jsonl"]}?},
 "budgets": {"perRound":{"usd":N},"lifetime":{"rounds":N,"usd":N}},
 "writeScope": ["repo 内允许 worker 修改的 glob"]?,
 "roundIntervalMs": N?,
 "waits": {"<名>":{"kind":"file","probeEveryMs":N,"params":{...},
   "rules":[{"when":"done","do":"wake_harvest"},{"when":"plateau","do":"terminate_and_harvest"},
            {"when":"no_balance","do":"rotate_and_resubmit"},{"when":"error","do":"wake_harvest"}]}}?
}

硬性规则：
- 表达式只能用已声明的 observables/meters 名与 budget.lifetime.exhausted；运算符仅 == != < <= > >= && || ! + - * / 与括号；不得出现函数调用。
- 至少一条 tripwire 能停止 loop（stop:true 或 mode:"finalize"）。声明顺序即优先级（最严重的在前）。
- judge/pivoter 的 context 必须是 "isolated"；确定性规则（计数、阈值、路由、盯外部任务、换号）必须落在 meters/tripwires/waits，**不得写进座位 prompt**。
- 长时外部任务（训练/远程评测）必须建模为 waits，探测节奏和终止/换号规则写成 rules；不要指望座位记得去检查。
- 禁止在任何 prompt/路径中出现 .meta-agent/。
- 需求中"每轮至少包含的阶段"映射：load_state→内核胶囊(忽略)；choose/implement/extract→worker prompt；semantic_eval/verify→judge rubric；reduce/route/state_writer→meters+tripwires(忽略其实现细节)。

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
