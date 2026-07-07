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

export const DISTILLER_SYSTEM = `\
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
 "seats": {"worker":{"context":"lineage_loop"|"isolated","prompt":"<仅领域指令，见"座位底座">","tools":["read_file","edit_file","bash"],"budgetPerRound":{"usd":4,"turns":80,"wallclockMin":45?}},
           "judge":{"context":"isolated","prompt":"…","inputs":["drafts/findings_draft.json","ledger/findings.jsonl"],"budgetPerRound":{"usd":0.5,"turns":10}},
           "pivoter":{"context":"isolated","prompt":"…","inputs":["ledger/directions.json","ledger/findings.jsonl"]}?},
 "budgets": {"perRound":{"usd":N},"lifetime":{"rounds":N,"usd":N}},
 "writeScope": ["repo 内允许 worker 修改的 glob"]?,
 "roundIntervalMs": N?,
}
（注：没有 charter.waits 字段。等待完全由 worker 驱动——见"座位底座"的等待机制。）

座位底座（worker 座位运行在内核内置的 inner_orch_worker 底座上，你无法改动它，但必须据此写 seat.prompt）：
- 底座**已自动提供**，seat.prompt 里**绝不要重复**：
  ① 座位身份（"你是本 loop 的 worker，只推进本轮、把结构化产出写入 drafts/、最后 return_result，不面向终端用户、不寒暄、不写用户报告"）；
  ② 基本纪律（读前改 / 换策略前先诊断 / 如实报告）；
  ③ 上下文约定（每轮 user 消息开头有 <context> 胶囊：目标/轮次/计数器/近期发现/已试方向/人工反馈/转向指令——底座已叮嘱先读它，遇到 --- 之后才是本轮指令）；
  ④ 可用 skill 清单（worker 自动看到，用 skill(action="load", name=…) 加载；例如某个外部工具/平台的能力由 skill 提供）；
  ⑤ 产出契约（先写 drafts/direction.json {"key","rationale"}，再写 drafts/findings_draft.json（数组，每条含 claim 与 evidence），最后调 return_result data={"label":"ok"|"error","note"}）；
  ⑥ 写入范围（由 charter.writeScope 下发，底座注入）；
  ⑦ 自计时等待工具 timer（见下）；以及"段协议"（提交长任务后调 timer 即结束本段、被唤醒后进收割段）——底座已讲，seat.prompt 不要复述机制。
- 长时外部任务（任何需要"发起后等一会儿再看结果"的动作）**只有两种等待方式，都由 worker 驱动，不写进 charter**（没有代码探针；等待期间的状态检查、异常处理/重试、以及"继续等还是收尾"的判断，全部由 worker 自己用工具/skill 做）：
  · **自计时（worker 用 timer 工具）**：worker 调 timer(minutes, reason)——**调用即刻结束本段并 park**（底座硬保证；worker 不需要、也不应在调 timer 后继续做别的）。到点内核 resume 它，worker 自查状态、自决"继续等（再 timer）还是收割"。minutes 取 5..180（按慢任务真正需要多久才有可见进展来定）。适合需要 worker 亲眼看中间结果再决定"继续等 vs 收尾"、或等待中要 worker 自己处理异常的场景。**必须搭 context:"lineage_loop"**（要记得上一段的中间态）。（举例，不限于此：盯一个慢任务的进展按趋势决定是否提前终止。）
  · **事件（外部系统推送）**：worker 返回 return_result data={"label":"wait","effectKey":"<id>"} 声明在等一个外部事件；外部系统往 events/<id>.json 丢 {effectKey, verdict, data} 即收割。适合真正 push 式的外部系统；无超时（要超时用自计时）。
  你只需在 seat.prompt 里点明用哪种、以及提交后如何回看/判断——工具和事件机制底座已给。
- **worker 每段任务必须是串行流程**（一步接一步：选方向 →〔需要就检索资料〕→ 设计 → 实现 → 提交长任务 → 调 timer 结束本段）。**绝不要**让 worker 在一段里并行扇出多个子代理再阻塞等待——那会挂死并拖满座位墙钟。若 worker 需要检索资料（如查论文），可 spawn **单个**子代理串行地搜、拿到结果再继续；tools 里给 spawn_sub_agent 即可，但 seat.prompt **不要**写"并行扇出 investigation/refutation/analogy"这类多路并发探索段。
- **提交长任务后立刻调 timer 结束本段**是铁律；"盯进度直到平台期再终止"这类监控判断放到**被唤醒后的收割段**，不要在提交段里内联死盯或轮询。
- 因此 seat.prompt 只写**领域/角色特有**的指令：本 worker 每轮具体做什么、如何选方向、领域判断标准、用哪个工具/skill 做什么、调用外部工具或提交长任务的领域细节。**不要**复述身份、输出格式（drafts/return_result）、段协议/timer 机制、"你是自主 agent"、"记得读胶囊"、skill 列表——底座已给，重复只会污染提示词、增加成本。目标写进 charter.goal（底座作为 D0 目标锚注入），不要抄进 seat.prompt。
- seat.budgetPerRound 可含 **wallclockMin**（该座位**单段**墙钟上限，分钟；默认 30）。若某座位的提交段本来就要"读码+设计+实现+提交"这类较重工作，设大些（如 45–60），避免正常工作被 30 分钟墙钟误杀；段与段之间的等待不计墙钟（进程已关闭）。
- worker.context 二选一，决定底座的会话形态：
  · "lineage_loop"：跨轮 **resume 同一会话**、积累上下文——用于"在已有实现上持续迭代、调参、逐步推进"的 worker；
  · "isolated"：每轮**全新会话、无历史**，只凭本轮 <context> 独立判断——用于"需要跳出既有框架、推翻假设、换新证据源、避免自我叙事绑架"的 worker。
  · 若需求同时要"迭代推进"与"周期性推翻重来"，可用两类思路：迭代 worker 用 lineage_loop，靠 tripwire 的 mode:"pivot" 触发 pivoter（isolated）给出结构性转向。judge/pivoter 永远 "isolated"（D6）。

账本归内核（最容易映射错的地方，务必钉死）：
- 内核在实例目录 .loop/<id>/ledger/ 下**独占写入**这些"状态/日志"文件，**不要**让任何座位去写：
  · ledger/progress.json —— iteration/stale_count/status/best_metric/total_findings/updated_at，**全部内核从 meters 算**（worker 一个字都不写）；
  · ledger/findings.jsonl —— 内核在 judge 门通过后，把 worker 写的 drafts/findings_draft.json **入账**；
  · ledger/directions.json —— 内核把 worker 写的 drafts/direction.json 去重后记录；
  · ledger/rounds.jsonl —— 每轮审计（内核写，含座位摘要/路由），对应需求里的 iteration_log。
- 所以 worker 对"状态"的**全部写入只有两个 draft**：drafts/direction.json + drafts/findings_draft.json。worker prompt **绝不能**出现"更新 progress.json / append findings.jsonl / 写 directions_tried / 算 stale_count / 写 status / 落盘 state 脚本"这类动作——那是内核的活，写了就和内核账本打架（D7 单写者）。需求里的 state_writer/reduce_progress 阶段直接**丢弃**。
- judge/pivoter 的 inputs、findings_gate 的 evidence 都**相对实例目录**解析，要用内核账本路径：ledger/findings.jsonl、ledger/directions.json、ledger/progress.json —— **不要**用工作区的 state/xxx（内核不写那里、也读不到）。
- state_gate（schema 门）如需要，检查 ledger/progress.json 即可（内核写的、恒为合法）；通常可省。
- writeScope 是**"worker 允许改的仓库文件/产物" glob**——按任务而定（代码、配置、文档皆可；纯分析/写作类 loop 可为空/不设），**不是**状态目录。别把 state/ledger/drafts 放进去（drafts 本就可写、账本 worker 碰不到）。若 worker 每轮确实要改某些产物，writeScope 必须覆盖那些路径，否则会被 prompt 挡住。

终止机制（两个内核内置，别当成 charter 特化去写）：
- **内置验收**：judge 每轮在 data 里输出 goal_satisfied（bool），对照 charter.goal 判"目标是否达成"；一旦 true，**内核自动 finalize 结束整个 loop**——你**不需要**为此写任何 tripwire。你要做的：把 goal 写清楚、在 judge 的 rubric 里说清"什么算达成/成功标准"。对没有硬指标的任务，这就是"判不判得完"的判断出口。
- **内置预算**：budgets.lifetime（rounds/usd/deadline）是硬兜底，一定结束。**每份 charter 都要设**——它是唯一保证不会无限跑的地板。
- 因此"能停"的保证 = 一条 stop/finalize tripwire **或** 一个 lifetime 预算（二者至少其一，校验强制）。stale/pivot/attention 这些 tripwire 是**额外**的进展路由，不是唯一出口。对判不了的模糊目标，用 attention 定期升级给人，而不是硬造指标。

硬性规则：
- 表达式只能用已声明的 observables/meters 名与 budget.lifetime.exhausted；运算符仅 == != < <= > >= && || ! + - * / 与括号；不得出现函数调用。
- 保证可终止：至少有一条 stop/finalize tripwire 或一个 lifetime 预算（见"终止机制"）。tripwire 声明顺序即优先级（最严重的在前）。
- judge/pivoter 的 context 必须是 "isolated"；计数/阈值/路由这类确定性规则落在 meters/tripwires，**不得写进座位 prompt**。
- 长时外部任务的等待由 worker 用 timer 工具（自计时）或事件驱动，**不建模成 charter 字段**；在 seat.prompt 里说明即可（见"座位底座"的等待机制）。
- 禁止在任何 prompt/路径中出现 .meta-agent/。
- 账本归内核：worker 只写 drafts/direction.json + drafts/findings_draft.json；progress/findings/directions/log 由内核写入 ledger/，worker 绝不碰（见"账本归内核"）。
- writeScope = worker 要改的仓库文件 glob（按任务而定，可为空），不是 state/ledger/drafts。
- 需求"每轮阶段"映射：load_state→内核胶囊(忽略)；choose/implement/extract→worker prompt(领域动作)；semantic_eval/verify→judge rubric；**reduce_progress/state_writer/route_by_status→内核 METER/LEDGER/ROUTE，全部丢弃，绝不写进 worker**。

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
      // Surface WHY the distiller sub-agent produced nothing usable: its terminal
      // status, whether it succeeded, and what it actually said. This turns the
      // opaque "no parseable payload" into an actionable diagnosis.
      const status = rec?.status ?? 'no-record'
      const success = rec?.result?.success
      const err = String(rec?.result?.error ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
      const said = String(rec?.result?.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
      const outKind = rec?.result?.output === undefined
        ? 'output=undefined'
        : `output=${typeof rec?.result?.output}`
      lastErrors = [
        `no parseable {charter, taskSpec} (sub-agent status=${status}, success=${success}, ${outKind}). ` +
        `sub-agent error: ${err || '(none)'}. sub-agent said: ${said || '(empty)'}`,
      ]
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

export function parseDistillOutput(
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
