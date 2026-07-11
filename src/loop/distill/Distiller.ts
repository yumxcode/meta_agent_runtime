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
 "tripwires": [{"when":"<表达式>","then":{"act":"pivot"} | {"act":"finalize","reason":"<原因>"?} | {"act":"escalate","reason":"<原因>","onResume":{"resetMeters":["<meter名>"]}?}}, …],
 "gates": {"state_gate":{"kind":"schema","files":["ledger/progress.json"]},
           "findings_gate":{"kind":"judge","evidence":["drafts/findings_draft.json","ledger/findings.jsonl"],"rubric":"…"}},
 "seats": {"worker":{"context":"lineage_loop"|"isolated","prompt":"<仅领域指令，见"座位底座">","tools":["read_file","edit_file","bash"],"budgetPerRound":{"usd":4,"turns":80,"wallclockMin":45?}},
           "judge":{"context":"isolated","prompt":"…","inputs":["drafts/findings_draft.json","ledger/findings.jsonl"],"budgetPerRound":{"usd":0.5,"turns":10}},
           "pivoter":{"context":"isolated","prompt":"…","inputs":["ledger/directions.json","ledger/findings.jsonl"]}?,
           "finalizer":{"context":"isolated","prompt":"…","inputs":["ledger/progress.json","ledger/findings.jsonl"]}?},
 "budgets": {"perRound":{"usd":N},"lifetime":{"rounds":N,"usd":N}},
 "health": {"staleWhen":"<表达式>"}?,
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
  · 若需求同时要"迭代推进"与"周期性推翻重来"，可用两类思路：迭代 worker 用 lineage_loop，靠 tripwire 的 {"act":"pivot"} 触发 pivoter（isolated）给出结构性转向。judge/pivoter/finalizer 永远 "isolated"（D6）。
- seat.budgetPerRound 缺省值：usd 2、turns 30、wallclockMin 30——对重座位（如要读码+实现的 worker）**要显式设大**，否则默认额度可能中途掐死正常工作。

隔离座位底座（judge/pivoter/finalizer 的运行事实，prompt 据此写）：
- **三个隔离座位的输出格式全部由内核追加的固定 contract 定义**，seat.prompt 一律**只写角色/判断标准，绝不要规定输出 JSON 结构**：judge → JUDGE_CONTRACT（见"硬性规则"）；pivoter → 内核强制 return_result data={"directive":"<结构性转向指令>","key":"<新方向短标识>"}；finalizer → 内核强制 data={"narrative":"<markdown 叙事>"}。
- 隔离座位**无工具**，世界=内嵌证据：seat.inputs 列出的文件被内核读出并内嵌进 prompt，**每个文件只取尾部 6000 字符**、不存在则标注"(不存在)"——inputs 要选小而信息密的账本文件，别指望它读大文件全文。
- judge 的 prompt 前内核会注入【验收目标】= charter.goal（内置验收据此判 goal_satisfied），goal 本身写清楚成功标准比 rubric 里重复目标更重要。
- judge 的裁决有硬后果：**verdict:"fail" → 本轮 findings 草稿不入账**，且 messages 会被内核原文作为 worker 的**同轮纠偏重试指令**（每轮最多一次）——rubric 要求 messages 写"可执行的具体纠偏项"而不是泛泛评语。judge 崩溃时内核重跑一次，仍失败则 fail-closed（草稿弃置）。
- 内核在 SEAT+GATE 内的自动纠偏重试**每轮每种原因至多一次**：方向与 directions_tried 完全重复 / state schema 门失败 / judge fail / wait 缺 effectKey。别在任何 prompt 里再造重试循环。

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

内核轮管线（理解 tripwire 何时生效的前提）：
- 每轮固定九步：WAKE ▸ RECONCILE ▸ MODE ▸ CAPSULE ▸ SEAT ▸ GATE ▸ METER ▸ LEDGER ▸ ROUTE，全部是宿主代码。
- **tripwires 每轮只在轮末 ROUTE 求值一次**（用刚更新完的 meters/observables）。命中后要么当场执行（finalize/escalate），要么持久化为下一轮的显式指令（pivot → 下一轮开场跑 pivoter）。轮首 MODE 不读 tripwire——它只消费上一轮留下的 pivot 指令 + 内核预算守卫。
- 分工不变式：**内核独占"loop 是否还允许跑"**（预算耗尽、验收达成），**charter 独占"何时转向/收尾/叫人"**（tripwires）。

终止机制（两个内核内置，别当成 charter 特化去写）：
- **内置验收**：judge 每轮在 data 里输出 goal_satisfied（bool），对照 charter.goal 判"目标是否达成"；一旦 true，**内核自动 finalize 结束整个 loop**——你**不需要**为此写任何 tripwire。你要做的：把 goal 写清楚、在 judge 的 rubric 里说清"什么算达成/成功标准"。对没有硬指标的任务，这就是"判不判得完"的判断出口。
- **内置预算**：budgets.lifetime（rounds/usd/deadline）是硬兜底，一定结束（finalize，原因=budget）。**每份 charter 都要设**——它是唯一保证不会无限跑的地板。若你想让"预算耗尽"交人工而非静默收尾，写一条 {"when":"budget.lifetime.exhausted","then":{"act":"escalate","reason":"budget"}}——charter 绊线优先于内核兜底。
- 因此"能停"的保证 = 一条 {"act":"finalize"} tripwire **或** 一个 lifetime 预算（二者至少其一，校验强制）。**escalate 不算终止**——它只是暂停等人。对判不了的模糊目标，用 escalate 定期升级给人，而不是硬造指标。

tripwire 动作语义（then 是三选一的判别联合，"act" 字段决定一切；无效组合在类型上不存在）：
- {"act":"pivot"}：**调度下一轮为转向轮**（一次性指令）。下一轮开场内核先跑 pivoter 座位、把结构性 directive 注入胶囊喂给 worker，然后指令自动清除；若之后还要再转向，需 tripwire 再次命中。本轮照常收尾，loop 不终止。校验强制：用了 act:"pivot" 就必须声明 seats.pivoter。
- {"act":"finalize","reason"?}：**优雅终止整个 loop**。若声明了 seats.finalizer，内核会让它跑一次、为最终报告补一段叙事；然后渲染 final_report.md、取消全部 wake、实例 status=done、progress.status=completed。
- {"act":"escalate","reason","onResume"?}：**暂停交人工**（不是终止）。渲染 attention_report.md、取消 wake、实例 status=paused_attention、progress.status=paused_attention。人工通过 loop migrate（修订 charter = human ack）恢复；恢复时内核会**重置触发该绊线的 meters**（默认=绊线表达式引用的 meters；可用 onResume.resetMeters 显式指定），保证不会一恢复就原地再暂停。reason 必填，只是原因标签，**不会让同名座位运行**。
- 三个动作互斥且穷尽——不存在 mode/stop 字段，不存在"标签式"动作；每个 act 都对应内核一条确定的代码路径。
- 典型正确写法（stale 渐进升级；声明顺序=优先级，高阈值在前，故 4 在 2 前）：
  · {"when":"stale_count >= 4","then":{"act":"escalate","reason":"长期无进展","onResume":{"resetMeters":["stale_count"]}}} —— 停下交人工
  · {"when":"stale_count >= 2","then":{"act":"pivot"}} —— 先让 pivoter 自动结构性转向、把方向喂给 worker
- pivoter 座位 ⟺ act:"pivot" 绊线**双向强制**（校验器两个方向都查）：声明了 pivoter 就必须有一条可达的 pivot 绊线，否则死座位报错；反之用了 pivot 绊线就必须声明 pivoter。不打算自动转向就两者都别写，也别在 worker prompt 里写"按 pivoter directive 推进"（死指令）。
- finalizer 座位（可选）：isolated、无工具，只在优雅 finalize 时跑一次，依据内嵌账本证据写收尾叙事（成果/未竟/后续建议）。需要"最终报告有人话总结"的需求就声明它；不声明则报告为纯代码模板。它**不能**替代 judge，也不参与轮内流程。

health（progress.status 的健康规则，可选）：
- 内核每轮轮末把 progress.status 写成 route 的确定函数：continue→healthy|stale、pivot→pivot_scheduled、escalate→paused_attention、finalize→completed。
- 其中 healthy|stale 由 health.staleWhen 表达式判定（true→stale）；不声明时回退约定：存在名为 stale_count 的 meter 且 >0 → stale。若你的"停滞"语义不是 stale_count（比如 plateau_streak >= 2），就显式声明 health.staleWhen。

硬性规则：
- **observable 只能是 {"from":"judge","key":"…"}，judge 输出 schema 由内核所有**：内核会在你的 judge prompt **之后追加一段 JUDGE_CONTRACT**，强制 judge 的 return_result data 恒含核心六键 {"verdict","new_findings_count","metric_delta","metric","goal_satisfied","messages"}，**并把 charter 里声明的所有额外 observable key 一并注入该 contract 强制输出**。因此：
  · **优先用核心键**：new_findings_count（int）/ metric_delta（number）/ metric（number|null）/ goal_satisfied（bool）。"结果变好没有"= metric_delta > 0，"有新发现"= new_findings_count > 0，多数需求核心键够用。
  · **确需自定义键**（如 coverage_ratio）可以直接声明——内核会替你强制 judge 输出它；但你**必须在 judge 的 rubric 里定义该键的语义与取值标准**（值限 number/boolean/string），否则 judge 只能瞎填。
  · judge 的 seat.prompt **只写 rubric**（怎么判、什么算 finding、成功标准、自定义键的语义），**绝不要规定输出格式/JSON 结构**——输出格式由内核追加的 JUDGE_CONTRACT 全权定义，你写的格式指令只会与之冲突。
  · 内核只解析 judge 来源（没有 from:"worker"/"ledger"/"meter"，校验器会直接报错）。**不要为"worker 报错"建 observable/tripwire**：worker 失败的那一轮内核会自动让 stale_count 自增，交给你的 stale_count tripwire（pivot/escalate）兜底即可。
- 表达式只能用已声明的 observables/meters 名与 budget.lifetime.exhausted；运算符仅 == != < <= > >= && || ! + - * / 与括号；字面量可用数字/布尔/'字符串'（如 verdict_obs == 'pass'，前提是已声明对应 observable）；不得出现函数调用。类型严格：逻辑要布尔、比较要数字，混用在运行时按"缺值"回退处理。health.staleWhen、onResume.resetMeters 同受静态校验（resetMeters 必须是已声明 meter）。
- meter 语义：incWhen 与 resetWhen 同轮同真时**只 inc 不 reset**（incWhen 优先）；meter 表达式看到的是**本轮更新前**的 meters + 本轮新 observables。observables 与 meters 名字共用一个命名空间，不得重名。
- gates 里**至多一个 judge 门**（内核只读第一个）；judge seat.inputs 声明时**覆盖** findings_gate.evidence（二者取其一维护，别写成两套不同清单）。
- 保证可终止：至少有一条 {"act":"finalize"} tripwire 或一个 lifetime 预算（见"终止机制"；escalate 不算）。tripwire 声明顺序即优先级（最严重的在前）。
- **then 只有三种合法形态**：{"act":"pivot"} / {"act":"finalize","reason"?} / {"act":"escalate","reason",…}——没有 mode、stop、attention 字段（那是旧版形态，校验器会给迁移提示但你不要输出它们）。pivoter ⟺ pivot 绊线双向强制。
- judge/pivoter/finalizer 的 context 必须是 "isolated"；计数/阈值/路由这类确定性规则落在 meters/tripwires，**不得写进座位 prompt**。
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
  if (typeof output === 'string') {
    candidates.push(tryJson(output))
    candidates.push(...extractJsonObjects(output))
  }
  if (summary) candidates.push(...extractJsonObjects(summary))
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

/**
 * Extract every top-level balanced {...} object from free text and JSON-parse each.
 * Robust against prose that mentions a json code fence in narration — the old
 * fence-pairing regex mis-paired a fence written in prose with the real block's
 * opening fence and captured prose instead of the JSON. Brace-scanning ignores
 * fences entirely, tracks string literals so braces inside strings never
 * miscount, and returns outermost objects in document order (charter wins).
 */
function extractJsonObjects(s: string): unknown[] {
  const out: unknown[] = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue
    let depth = 0, inStr = false, esc = false
    for (let j = i; j < s.length; j++) {
      const ch = s[j]!
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        if (--depth === 0) {
          const v = tryJson(s.slice(i, j + 1))
          if (v !== null) out.push(v)
          i = j
          break
        }
      }
    }
  }
  return out
}

function tryJson(s: string): unknown {
  try { return JSON.parse(s.trim()) } catch { return null }
}
