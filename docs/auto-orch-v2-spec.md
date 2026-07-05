# auto_orch v2 开发 Spec — 章程驱动的长周期 Loop 运行时

> 状态：待评审 | 上游设计：`docs/auto-orch-v2-design.md` | 本文为可开发规格：
> 组件接口、数据 schema、已定决议、任务分解（WBS）、开发时刻表、验收标准。

---

## 1. 范围

**目标**：交付一个"章程 + 内核 + 座位"的 loop 运行时，使 90% 的长周期 loop
场景（以 RL 行走研究 loop 为验收基准）能以 ≤3 个 LLM 座位 + 全确定性构件
无人值守运转数周，具备定时/探测/事件三源唤醒与崩溃无损恢复能力。

**非目标（本期不做）**：
- 不做 Web UI；CLI + 文件即产品面；
- 不做多机分布式（单主机多进程模型，daemon host 锁）。

**退役范围（见 D15/D16）**：v1 auto_orch 图引擎整体退役，不保留座位子图后端；
可复用构件被 v2 吸收（见 §7 迁移清单）。10% 自由拓扑场景由"多份章程组合 +
auto 会话"覆盖，不再以图表达。

---

## 2. 已定决议（Decision Log）

| # | 决议 | 依据 |
|---|---|---|
| D1 | 稳定性锚点 = 契约（观测量/阈值/验收/账本），非路径 | 讨论共识 |
| D2 | 计数/路由/校验/盯任务/换号一律确定性构件，不经 LLM | 职责分离 |
| D3 | 章程规则用**受限表达式 DSL 解释执行**（create 时解析 AST，内核求值器求值），不生成代码；定制归约走现有 code node 冻结机制 | 可静态校验、可 diff |
| D4 | 探针为**内置适配器注册表**（`kind → adapter`），章程只传参数 | 代码随 runtime 发布测试 |
| D5 | Worker 轮内血缘（含 waiting 恢复、纠偏重跑）、**轮间强制重生**；跨轮只传账本化结论（capsule）。可经 `context: lineage(loop)` 显式放开，默认关闭 | 防自我叙事绑架；月级上下文数学不可行 |
| D6 | Judge **每次调用全新**（含同轮二审）；历史判重靠输入 findings.jsonl，不靠记忆 | 独立性=输入的物理边界 |
| D7 | 账本代码单写者：座位产出落草稿区，经 gate 后由内核入账；agent 只读 | 事故结构性免疫 |
| D8 | 写三通道：state→LedgerAPI 直写（不进 worktree/merge）；repo→worktree+writeScope 必须声明；external→effect 账本（幂等键） | `.meta-agent` 事故复盘 |
| D9 | 实例化冻结章程快照；amend 需显式 migrate，运行中实例不受章程库修改影响 | 长周期规则一致性 |
| D10 | 绊线不可被座位否决；升级 fail-stop（停触发器+报告+等人 ack） | 硬中断反思 |
| D11 | 进程模型：daemon 只调度（claim+探针+派发）；round 跑在短命 tick 子进程；waiting 为无进程状态；零进程存活假设 | 崩溃隔离 |
| D12 | 错过的 timer 合并（coalesce）不补跑；同一 effect 收割仅一次（claim 保证） | 幂等 |
| D13 | lifetime 预算权威源 = ledger 汇总，claim 点只读缓存 | 崩溃一致性 |
| D14 | 现有护栏中通用层（工具 guard/sandbox deny/merge guard/outputs 契约）原样适用于座位 spawn；validatePlan 的路径规则移植为 charter 校验规则 | 已实现/移植 |
| D15 | v2 **不注册为 SessionMode**：入口是 `loop *` 命令组与 daemon，不进 session 工厂。v2 是会话之上的事务运行时（L2），L1 各会话模式是其座位的执行档位 | 架构分层讨论 |
| D16 | **退役 v1 auto_orch**：不保留图后端，`SessionMode` 移除 `'auto_orch'`，planner/LoopIR/PlanRunner/KernelNodeRunner 下线。复杂 worker 用 auto/simple_auto 会话表达，跨阶段编排用章程表达。可复用构件（CodeNodeRunner 沙箱、ScheduleStore→WakeStore、PlanStore 版本化模式→CharterStore、reviewer 骨架→judge 座位、blackboard→纠偏 preface）由 v2 吸收 | 其他模式够用，消除双引擎维护成本 |

**遗留待决**（不阻塞 M1）：DSL 运算符集边界（O1）；probe 适配器插件面（O2）；
judge 证据白名单声明语法（O3）；inbox 反馈分级（O4）。

---

## 3. 数据 Schema（M1 冻结项）

### 3.1 Charter（`charters/<id>/v<NNN>/charter.yaml`）

```yaml
charter:
  id: string                    # 唯一 id
  version: int                  # 人批准 +1
  goal: string
  observables: [{name, source}] # source: judge.output.<k> | ledger:<file>#<jsonpath> | meter:<name>
  invariants:  [{file, schema}] # schema 注册名
  meters:      {name: {inc_when?, reset_when?, inc?: every_round}}
  tripwires:   [{when: expr, then: {mode?|escalate?|stop?}}]   # 声明序即优先级
  gates:       {name: {kind: schema|judge, ...}}
  seats:       {worker|judge|pivoter: {context, tools, budget_per_round, prompt, inputs?}}
  waits:       {name: {effect: kind, probe: {every, code, rules[]}, event?: {channel, match}}}
  budgets:     {per_round, lifetime: {rounds, usd, deadline}}
  escalation:  {attention: {report, notify[], resume}}
  write_channels: {state: ledger_api, repo: {write_scope[]}, external: effect_ledger}
```

### 3.2 表达式 DSL（受限，白名单）

- 类型：number / boolean / string 字面量；标识符（观测量、meter 名、`budget.*`）
- 运算符：`== != < <= > >= && || ! + - * /`，括号
- 显式禁止：函数调用、索引、赋值、正则。解析失败/引用未声明标识符 → create 时报错
- AST 为 JSON 树，存入实例快照；求值器纯函数 `evaluate(ast, ctx) → value`

### 3.3 实例目录（`<taskDir>/.loop/<instanceId>/`）

```
instance.json          # {charterId, version, charterHash, params, status, createdAt}
charter.frozen.json    # 冻结快照（含 AST）
ledger/
  rounds.jsonl         # {round, mode, observables, meters, route, cost, seatSummaries, at}
  findings.jsonl       # 业务账本（章程 schema）
  directions.json
  effects.jsonl        # {key, kind, status: submitted|probing|settled|failed, probes[], payload}
  progress.json        # 由 meters 派生的规范视图
drafts/                # 座位产出草稿区（入账前）
inbox/  processed/     # 反馈投递与归档
events/                # 事件文件投递点
reports/               # attention/pivot/final
capsule.json           # 最近胶囊（缓存，可重建）
```

### 3.4 WakeStore 记录（泛化自 AutoOrchScheduleStore）

```json
{ "wakeId": "...", "loopId": "...", "roundId": null,
  "kind": "timer|probe|event|manual", "fireAt": 0, "effectKey": null,
  "claim": {"owner","heartbeatAt","expiresAt"}, "attempts": 0, "status": "pending|claimed|done|cancelled" }
```

---

## 4. 组件规格与接口（TS 签名级）

### C1 表达式引擎 `src/loop/expr/`
`parse(src: string, declared: Set<string>): Ast`（静态校验引用）
`evaluate(ast: Ast, ctx: Record<string, number|boolean|string>): Value`
纯函数、无 IO、100% 单测覆盖运算符矩阵与错误路径。

### C2 CharterStore `src/loop/charter/`
`save(draft): CharterRef`（人批准动作在 CLI 层）
`load(id, version?): Charter`；`validate(charter): string[]`（schema + DSL 静态检查 +
绊线可达性：stop 路径存在）；版本目录 + latest 指针，复用 PlanStore 模式。

### C3 LedgerAPI `src/loop/ledger/`
`appendJsonl(file, entry)`（原子 append）；`replaceJson(file, value)`（temp+rename）；
`readView(): LedgerView`（meters/best/last-K findings 等派生视图）；
schema 注册与写前校验；**唯一写入者为内核进程**，无对座位的暴露面。

### C4 WakeStore `src/loop/wake/`
泛化 AutoOrchScheduleStore：`schedule/claimDue/heartbeat/release/cancel/reconcileOrphans`。
timer coalesce；probe 自重排；event 由 watcher 转译（events/ 文件 → wake）。

### C5 EffectLedger + Probe 框架 `src/loop/effects/`
`register(effect)`; `settle(key, outcome)`; `pendingFor(loopId)`。
`ProbeAdapter` 接口：`probe({effect, params, ledger}): {verdict, data}`。
内置适配器 M2 首发：`gradmotion`（gm task data get、平台期斜率判定、
no_balance 检测 + account-pool 轮换重提）。

### C6 CapsuleBuilder `src/loop/capsule/`
`build(ledgerView, inbox): Capsule`——确定性、模板化、有大小上限（截断规则
声明式）。借鉴 coordination/CapsuleBuilder。

### C7 LoopKernel `src/loop/kernel/`
`runRound(instance, wake): RoundOutcome`——九步固定管线
（WAKE→RECONCILE→CAPSULE→MODE→SEAT→GATE→METER→LEDGER→ROUTE）。
座位 spawn 走现有 SubAgentBridge（血缘=resumable session；隔离=新 session +
evidence-only 输入拼装）。纠偏重跑 1 次上限。RoundOutcome 全量入 rounds.jsonl。

### C8 进程层 `src/loop/procs/` + CLI
`loop-scheduler` daemon（host 锁、tick WakeStore、跑探针、
`spawn meta-agent loop tick <instance> <wake>`、idle 退出）；
`loop create|tick|list|inspect|pause|resume|inbox add|distill` 命令组。
复用 SchedulerKeepAlive 三层模式。

### C9 Distiller `src/loop/distill/`
一次性 LLM 会话：需求文档 → charter 草案 + task_spec.md 草稿 → CLI 呈现
diff/摘要 → 人批 → CharterStore。校验失败错误喂回重试（复用 planner 重试骨架）。

### C10 升级与报告
attention/final 报告 = 代码模板渲染账本（叙事段可选由 pivoter 补写）；
通知：CLI 列表 + inbox 回执文件；`resume` 需人 ack 记录入 rounds.jsonl。

---

## 5. 任务分解（WBS）

> 估算单位：人日（1 名工程师 + agent 辅助编码）。依赖以 → 标注。

### M1 — 最小可跑内核（合计 ~13d）

| 任务 | 内容 | 估算 | 依赖 |
|---|---|---|---|
| T1.1 | 表达式引擎（parse/evaluate + 单测矩阵） | 2d | — |
| T1.2 | Charter schema + validate + CharterStore | 2d | T1.1 |
| T1.3 | LedgerAPI + schema 注册 + 实例目录布局 | 2d | — |
| T1.4 | WakeStore 泛化（timer/manual + claim/coalesce） | 1.5d | — |
| T1.5 | CapsuleBuilder | 1d | T1.3 |
| T1.6 | LoopKernel 九步管线（worker/judge 两座位；SEAT 接 SubAgentBridge；血缘/隔离两档） | 3d | T1.1–T1.5 |
| T1.7 | CLI：create/tick/list/inspect + tick 子进程入口 | 1d | T1.6 |
| T1.8 | M1 验收：行走研究 loop 用**模拟训练**（本地假 gm 脚本）无人值守跑 3 轮，账本/绊线/纠偏全路径断言 | 0.5d | T1.7 |

### M2 — 长周期健壮（合计 ~9d）

| 任务 | 内容 | 估算 | 依赖 |
|---|---|---|---|
| T2.1 | EffectLedger + waiting 状态（round 分裂提交/收割段，resumable 恢复） | 2d | T1.6 |
| T2.2 | Probe 框架 + gradmotion 适配器（平台期规则、no_balance 换号重提） | 2.5d | T2.1 |
| T2.3 | event 唤醒（events/ watcher + effectKey 对账 + 与 probe 幂等并存） | 1.5d | T2.1 |
| T2.4 | daemon（host 锁、探针内联、tick 派发、idle 退出）+ 启动自愈 | 2d | T1.4, T2.2 |
| T2.5 | RECONCILE 全量对账（孤儿 claim/未决 effect/崩溃注入测试：kill -9 矩阵） | 1d | T2.4 |

### M3 — 生成与复用（合计 ~5d）

| 任务 | 内容 | 估算 | 依赖 |
|---|---|---|---|
| T3.1 | Distiller（蒸馏 prompt + 校验回喂 + 人批 CLI 流程） | 2.5d | T1.2 |
| T3.2 | amend/migrate（章程修订 → 运行实例显式迁移） | 1.5d | T1.2 |
| T3.3 | pivoter 座位 + pivot 模式轮 + attention 报告渲染 | 1d | T1.6 |

### M4 — 收尾加固（合计 ~5d）

| 任务 | 内容 | 估算 | 依赖 |
|---|---|---|---|
| T4.1 | lifetime 预算（ledger 权威 + claim 点检查）+ escalate 全路径 | 1d | T2.4 |
| T4.2 | repo 通道收紧：座位 writeScope 必须声明 + 下译 sandbox + outputs 验收 | 1.5d | T1.6 |
| T4.3a | v1 入口退役【已完成】：CLI validModes 移除 `auto_orch`（带指引报错→loop 命令组）；mode profile 标注 RETIRED（仅供 orch-scheduler 排空存量 v1 暂停 run）；`spawnAndWait` 已迁址 `src/loop/seatSpawn.ts`（loop 对 v1 零依赖） | 0.5d | T1.6, T2.4 |
| T4.3b | v1 引擎删除【待独立执行】：实测爆炸半径 51 文件（CLI 单体 113 处引用：orch 命令、事件渲染、计划审批 UX）。删除清单：src/core/auto_orch/ 全部 27 文件 + 10 测试文件；修复 cli/index.ts、routing/AgenticBackendFactory、routing/SessionRouter、subagent/SubAgentRunner（AutoOrchPauseTool/session 持久化）、subagent/SubAgentBridge（autoOrch config）、kernel/loop/PhaseHooks、core/modes.ts union；CodeNodeRunner 沙箱迁址 src/loop/。前置条件：确认无在飞 v1 暂停 run 需要排空 | 1.5d | T4.3a |
| T4.4 | 观测：rounds 事件流接 Observer、`loop inspect` 时间线渲染 | 1d | T2.4 |

---

## 6. 开发时刻表（8 周，含真实场景 dogfood）

| 周 | 里程碑 | 内容 | 出口判据 |
|---|---|---|---|
| W1 | M1a | T1.1–T1.4（引擎/章程/账本/唤醒四地基，可并行） | 单测全绿；DSL 错误路径覆盖 |
| W2 | M1b | T1.5–T1.7 内核管线 + CLI | 手动 tick 跑通单轮 |
| W3 | **M1 验收** | T1.8 模拟训练 3 轮无人值守 | 账本可审计；stale→pivot 绊线触发正确；纠偏重跑路径验证 |
| W4 | M2a | T2.1–T2.2 effect + probe | waiting 挂起/恢复；模拟平台期/无余额场景 |
| W5 | **M2 验收** | T2.3–T2.5 event + daemon + 对账 | kill -9 矩阵全恢复；同 effect 双唤醒仅收割一次 |
| W6 | **M3 验收** | T3.1–T3.3 | 你的 RL 需求文档 → 蒸馏 → 人批 → 起跑全程 ≤10 分钟 |
| W7 | M4 | T4.1–T4.4 | writeScope 强制；预算 fail-stop；inspect 可读 |
| W8 | **Dogfood** | 真实 gradmotion 上跑行走研究 loop ≥5 轮/≥3 天无人值守 | 零人工干预（除设计内 attention）；每轮成本 ≤ 章程预算；事后账本复盘无缺页 |

关键路径：T1.1→T1.2→T1.6→T2.1→T2.2→T2.4→W8。
风险缓冲：W8 兼作 buffer；若 gradmotion 适配器实测超期（远端接口不稳定），
优先保 probe 正确性、event 降级为 M4 后补。

---

## 7. v1 退役迁移清单（D16 执行细则）

| v1 构件 | 去向 |
|---|---|
| AutoOrchScheduleStore / SchedulerKeepAlive | 泛化为 WakeStore / loop-scheduler（T1.4/T2.4 的基座） |
| CodeNodeRunner 沙箱 + code_author | 保留，v2 定制归约后端（D3） |
| PlanStore 版本化模式 | 模式复用于 CharterStore（T1.2） |
| reviewer/RoleRegistry 骨架 | judge/pivoter 座位的 spawn 骨架 |
| Blackboard 定向纠偏 | 内核 GATE 步纠偏 preface 机制 |
| 五层护栏（工具 guard/sandbox deny/merge guard/outputs 契约） | 通用层原样保留于 subagent/sandbox 层 |
| validatePlan 路径规则 | 移植为 charter validate 规则 |
| PlannerAgent / LoopIR / PlanRunner / KernelNodeRunner / ParallelBranchRunner | **下线删除**（T4.3） |
| `SessionMode: 'auto_orch'` | 移除；模式判定函数同步收紧 |

## 8. 总验收标准（Definition of Done）

1. **稳定性**：同一章程、同一初始状态重放 3 次，绊线触发轮次、路由决定、
   账本结构完全一致（座位产出内容可不同）。
2. **健壮性**：任意时刻 kill -9（daemon/tick/训练等待中），重启后自动接续，
   无双开训练、无账本损坏、无丢轮。
3. **独立性**：Judge 输入物理不含 worker transcript（测试断言拼装输入）；
   worker 轮间无上一轮会话引用。
4. **确定性边界**：全程审计 rounds.jsonl，9 类判断点无一经过 LLM。
5. **成本**：每轮 LLM 会话 ≤3；探测 0 LLM；相对 v1 图（~8 冷启动/轮）成本
   下降 ≥60%。
6. **可复用**：章程可导出、在新 taskDir 实例化并跑通。
