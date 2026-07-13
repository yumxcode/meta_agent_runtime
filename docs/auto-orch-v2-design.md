# auto_orch v2 — 章程驱动的长周期 Loop 运行时

> 历史说明：本文是早期以单一训练项目做 dogfood 的设计记录，其中出现的项目目录、
> 平台和命令均为当时实例值，不是当前 Loop 通用约定。现行泛化边界与实现计划以
> `loop-structural-generalization-plan-2026-07-13.md` 为准。

> 定位：介于 auto（全生成、零保证）与确定性流程（全保证、零生成）之间。
> 一句话：**把自主性装进会计制度**。需要"聪明"的环节给座位（LLM），
> 需要"三个月后依然精确"的环节给构件（代码）。提示词是建议，结构才是保证。

---

## 0. 设计原则（已达成共识的部分）

1. **稳定性的锚点是契约，不是路径**：同样的观测量、阈值、验收标准、账本；路径可变。
2. **职责分离是结构性的**：计数交给代码（精确且不知疲倦）；反思交给独立座位，
   其独立性由**输入的物理边界**保证（只能看到账本和证据），而非指令叮嘱。
3. **换人制**：执行者每轮重生，跨轮连续性住在账本里，不住在上下文里。
4. **绊线不可否决**：阈值触发的转段是硬中断，任何座位无权 veto。
5. **章程是资产**：需要保存/复用/版本化的是章程，不是执行轨迹。
6. **判断准则**：凡是必须在第三个月依然为真的东西（计数、阈值、验收、记录），
   不得住在任何 agent 的上下文窗口里。

---

## 1. 核心对象

### 1.1 Charter（章程）— 唯一的持久化复用资产

一份声明式契约，可读、可 diff、可版本化。图不是必需品；复杂拓扑是章程的
可选渲染（见 §6.3）。

```yaml
charter:
  id: walk-research
  version: 7                      # 每次人批准的修订 +1
  goal: "人形机器人行走控制长周期自主研究……"

  observables:                    # 每轮必须量化的观测量（来源声明，代码采集）
    - name: metric_delta   source: judge.output.metric_delta
    - name: new_findings   source: judge.output.new_findings_count
    - name: best_metric    source: ledger:progress.best_metric

  invariants:                     # 始终成立；违反 = error 转段（schema 由代码校验）
    - progress.json matches schema@progress_v1
    - findings.jsonl is append-only
    - directions_tried 无 exact 重复

  meters:                         # 计数器 —— 纯代码，声明式规则
    iteration:   { inc: every_round }
    stale_count:
      inc_when:   "new_findings == 0 || metric_delta < 0"
      reset_when: "new_findings > 0 && metric_delta >= 0"

  tripwires:                      # 绊线：阈值 → 强制转段（座位无权否决）
    - when: "stale_count >= 2"        then: { mode: pivot }
    - when: "stale_count >= 4"        then: { escalate: attention, stop: true }
    - when: "iteration >= 12"         then: { mode: finalize, stop: true }
    - when: "budget.lifetime.exhausted" then: { escalate: budget, stop: true }

  gates:                          # 验收门（分两级）
    state_gate:    { kind: schema, files: [progress.json, findings.jsonl] }   # 代码，每轮免费
    findings_gate: { kind: judge, evidence: [findings_draft, metrics_curve],  # 隔离座位
                     rubric: "每条 finding 必须有训练数据支撑；与历史无语义重复" }

  seats:                          # 座位（LLM），各自声明上下文档位
    worker:   { context: lineage(round), tools: [read,edit,bash,paper_search],
                budget_per_round: {usd: 4, turns: 90} }
    judge:    { context: isolated,  inputs: evidence_only,
                budget_per_round: {usd: 0.5, turns: 10} }
    pivoter:  { context: isolated,  trigger: "mode == pivot",
                inputs: [capsule, directions_tried, findings_digest] }

  waits:                          # 等待与唤醒策略（长周期核心，见 §3）
    training:
      effect:  gradmotion.submit            # 提交动作登记效果账本（幂等键）
      probe:   { every: 2h, code: builtin/rl_probe,
                 rules:
                   - { when: done,       do: wake_harvest }
                   - { when: plateau,    do: [terminate_remote, wake_harvest] }
                   - { when: no_balance, do: [account_rotate, resubmit] }      # 座位不用醒
                   - { when: error,      do: wake_harvest } }
      event:   { channel: "events/gradmotion/*.json", match: effect_key }      # 被动快路径

  budgets:
    per_round: { usd: 6, wallclock: 2h(不含 waiting) }
    lifetime:  { rounds: 12, usd: 60, deadline: +30d }

  escalation:
    attention: { report: state/attention_report.md, notify: [cli, inbox_receipt],
                 resume: human_ack }

  write_channels:
    state:    ledger_api            # 唯一合法通道，见 §5
    repo:     { worktree: true, write_scope: ["humanoid/envs/x1/**"] }
    external: effect_ledger
```

### 1.2 LoopInstance（运行实例）

`instance = charter@version + stateRoot + 状态机`

```
idle ──wake──▶ running(round N) ──提交外部任务──▶ waiting(external)
  ▲                │                                   │ probe/event 唤醒
  │                ▼                                   ▼
  └── 正常收尾 ── gates/meters/route ◀── running(harvest 段) ──┘
                     │
                     ├─ tripwire: pivot      → running(pivot 段)
                     ├─ tripwire: attention  → paused_attention（人 ack 后 resume）
                     ├─ tripwire: finalize   → done
                     └─ invariant 违反/连续失败 → failed（报告 + 停触发器）
```

### 1.3 Ledger（账本）— 代码单写者

```
<stateRoot>/
  ledger/
    rounds.jsonl        # 每轮一条：观测量、计量结果、路由决定、成本、座位摘要
    findings.jsonl      # 业务账本（schema 由章程声明）
    directions.json
    effects.jsonl       # 外部副作用：{key, kind, submitted_at, status, probes[], settled_at}
  inbox/                # 人/外部系统投递反馈；round 开始时 ingest，消费后归档 processed/
  reports/              # attention/final/pivot 报告
  capsule.json          # 最近一次胶囊（可重建，缓存性质）
```

规则：所有账本文件只由内核代码写（原子 append / temp+rename）；座位产出
一律先落草稿区，经 gate 后由内核入账。**agent 读账本、不写账本**。

---

## 2. 内核：Round 生命周期（固定控制流，不由 LLM 决定）

```
WAKE ▶ RECONCILE ▶ CAPSULE ▶ MODE ▶ SEAT ▶ GATE ▶ METER ▶ LEDGER ▶ ROUTE
```

| 步骤 | 执行者 | 内容 |
|---|---|---|
| 1. WAKE | 内核 | 三源之一唤醒（§3），原子 claim 本轮 |
| 2. RECONCILE | 代码 | 对账：未决 effects？孤儿 claim？崩溃残留？inbox 有新反馈？ |
| 3. CAPSULE | 代码 | 确定性构建胶囊：账本 digest + 路径地图 + 死路清单 + inbox 反馈 + memory 要点 |
| 4. MODE | 代码 | 读绊线决定本轮模式：normal / pivot / finalize / attention |
| 5. SEAT | LLM | worker（或 pivoter）干活。若提交外部任务：登记 effect → 声明 wait → **round 挂起为 waiting，进程可退出** |
| 6. GATE | 代码→LLM | 先 schema 门（免费），过了才 judge 门（隔离座位）。fail → 携纠偏重跑 worker 一次；仍 fail → 记入 stale，不硬停 |
| 7. METER | 代码 | 按声明规则更新计数器 |
| 8. LEDGER | 代码 | 原子落账（rounds/findings/directions/progress） |
| 9. ROUTE | 代码 | 绊线检查 → 调度下一轮 wake / 转段 / 停止 |

关键形态：**round 可分裂为"提交段"和"收割段"**，中间是 waiting 状态，
由唤醒机制接续。这是 RL 训练等长等待场景的一等公民形态，不是特例。

每轮 LLM 成本：worker 1 session + judge 1 session +（低频 pivoter）≤ 3 个座位；
其余 8 个步骤全部毫秒级代码。

---

## 3. 唤醒机制（Wake）— 三源合一

统一 **WakeStore**（泛化现有 AutoOrchScheduleStore：文件持久化、原子 claim、
多进程安全、退避重试）。wake 记录：

```json
{ "loopId": "...", "roundId": "...", "kind": "timer|probe|event|manual",
  "fireAt": 1234567890, "effectKey": "...", "claim": {...}, "attempts": 0 }
```

### 3.1 定时唤醒（timer）
下一轮的常规调度：cron / interval / once。错过的 tick **合并**（coalesce），
不排队补跑。

### 3.2 探测唤醒（probe）— "每 2 小时看一次训练"
waiting 状态的轮询。到点被唤醒的**不是座位，是探针（纯代码）**：

```
probe 到点 → 拉远端指标（gm task data get）→ 规则判定：
  done       → 唤醒 worker 收割段（resumable session 恢复，轮内血缘不断）
  plateau    → 代码终止远端训练 → 唤醒收割段
  no_balance → account-pool remove + get → 代码重提交 → 更新 effect → 继续睡
  error      → 唤醒收割段（带错误上下文）
  其他       → 记录探测点到 effects.jsonl → 重排下次 probe → 继续睡
```

成本结构决定形态：探针无 LLM、几乎免费；唤醒座位贵。所以**先探针后座位**，
90% 的探测不需要任何 agent 醒来。"平台期判定"用确定性规则（斜率阈值 +
最小观察窗），阈值写在章程里可调。

### 3.3 事件唤醒（event）— 被动快路径
外部系统投递事件文件到 `events/`（webhook 由 CLI 网关落成文件），daemon 的
watcher 以 `effectKey` 幂等匹配到等待中的 effect → 立即唤醒收割段。

**event 是快路径，probe 是保底**，两者并存不冲突：同一 effect 的收割由
claim 保证只发生一次；事件先到则取消后续 probe，probe 先发现完成则事件到达
时发现已 settled、直接归档。

### 3.4 进程模型（复用 SchedulerKeepAlive 三层）
- A 前台等待：交互会话存活期间自己 tick；
- B detached daemon：`meta-agent loop-scheduler`，host 锁 + idle 退出，
  唯一常驻假设，且它只做 claim + 探针 + 座位拉起，本身无状态；
- C 启动自愈：任何会话启动时扫描 overdue wake / 孤儿 claim / 未决 effects。

**零进程存活假设**：daemon 挂掉、机器重启，一切从 charter + ledger + effects
+ WakeStore 恢复；RECONCILE 步骤保证重放安全（effect 幂等键防止双开训练）。

---

## 4. 上下文三档（座位声明制）

| 档位 | 机制 | 默认使用者 |
|---|---|---|
| capsule | 内核每轮代码构建，注入所有座位 | 全员（公共事实一次构建） |
| lineage | 责任链内同 session 续传：round 内 worker 从选方向干到收割；waiting 恢复同 session；corrective 重跑带上次摘要 | worker |
| isolated | 强制新 session；输入物理上仅证据文件 + capsule | judge / pivoter |

轮间 worker 重生（防自我叙事绑架）；跨轮继承走账本经 capsule 注入。
"该忘的忘掉，该记的走账本。"

---

## 5. 写三通道

| 通道 | 机制 | 事故隔离 |
|---|---|---|
| state | LedgerAPI 直写 canonical stateRoot：原子 append/replace + schema 校验 + 内核单写者。**不进 worktree、不走 git merge** | "state 被合并丢弃"在结构上不可能；纯 state 轮零 worktree 开销 |
| repo | worktree + **writeScope 必须声明**（静态查相交性；scope 下译为 sandbox writeAllowPaths）→ finalize/merge → outputs 契约验收 | 现有五层护栏（validatePlan / tool guard / sandbox deny / merge guard / outputs 契约）原样复用 |
| external | effect ledger：幂等键 + 状态机（submitted→probing→settled）+ 探测历史 | 崩溃重放不双开训练、不重复扣费 |

---

## 6. 生成与复用

### 6.1 蒸馏（distiller）— planner 的新角色
LLM 把自然语言 loop 描述**一次性蒸馏成章程**（观测量/计数规则/绊线/门/
座位/waits），人审阅批准。章程比 16 节点图 JSON 可读一个量级，审批有意义。
校验是平凡的（schema + 表达式静态检查），不存在"全量重出图"的重试灾难。

### 6.2 CharterStore
版本化（人批准 +1）、成功率统计、修订记录。运行中 judge/pivoter 的输出可
附带"建议修改章程第 X 条"（例如调 plateau 阈值），走 amend 流程人批后生效
——章程随使用越磨越准，这才是业务流程知识的结晶闭环。

### 6.3 复杂拓扑（10% 场景）
章程中某个座位的工作可声明为一张 auto_orch 子图（现有 LoopIR/PlanRunner
作为 worker 的执行后端保留）。图从"顶层控制流"降级为"座位内部的工作方式"，
长周期控制权始终在章程构件手里。

---

## 7. 示例走查：RL 训练研究 loop 的一轮

```
t0    timer wake → RECONCILE（inbox 有人留言"别再调 sigma"）→ CAPSULE（注入该反馈）
t0+1m MODE=normal → worker 醒（血缘 session）：读胶囊选方向 → 改 reward 代码
      （repo 通道，writeScope=humanoid/envs/x1/**）→ 提交 gradmotion 训练
      → effect 登记{key=exp-042} → wait 声明 → round 挂起 waiting，进程退出
t+2h  probe（代码）：拉曲线 → 未收敛未平台 → 记探测点 → 睡
t+4h  probe：斜率 < 阈值且窗口满 → 判 plateau → 代码终止远端 → wake_harvest
t+4h1m worker 同 session 恢复（记得自己为什么选这个方向）：提取结果 → findings 草稿
t+4h5m schema 门（代码，过）→ judge 醒（隔离）：对证据评审 → new_findings=1, delta=+0.02
t+4h8m METER：stale_count 清零 → LEDGER 入账 → ROUTE：healthy → 排明早 timer
      （若 stale_count 达 2：本轮直接转 pivoter；达 4：写报告停机等人）
```

全程 LLM 会话 2 个（worker 一条血缘 + judge 一次），代码步骤 9 个，
探测 2 次零 LLM，账号无余额场景座位甚至不会醒。

---

## 8. 与现有资产的映射

| v2 构件 | 复用 | 新建 |
|---|---|---|
| WakeStore | AutoOrchScheduleStore（claim/退避）泛化 | timer/probe/event 三 kind |
| daemon | SchedulerKeepAlive 三层 | loop-scheduler 入口 |
| 座位 spawn | SubAgentBridge/Runner、resumable session、五层护栏 | 上下文档位声明 |
| LedgerAPI | code node 的 api.state、state/ 快速路径 | 单写者化、schema 注册 |
| effect | pause_external 语义 | 幂等键账本 + 探针规则引擎 |
| capsule | coordination/CapsuleBuilder 模式 | 接入 round 管线 |
| 蒸馏/存储 | PlannerAgent 骨架、PlanStore 版本化 | charter schema + amend 流程 |
| 子图后端 | LoopIR/PlanRunner 原样保留 | 座位→子图适配 |

## 9. 里程碑

- **M1（最小可跑）**：charter schema + 内核 round 循环 + LedgerAPI +
  timer/manual 唤醒 + worker/judge 两座位。用你的行走研究 loop 验收
  （训练等待先用 probe 轮询）。
- **M2（长周期健壮）**：effect ledger + probe 规则引擎（平台期/换号）+
  event 唤醒 + RECONCILE 对账 + daemon 泛化。
- **M3（生成复用）**：charter 蒸馏器 + CharterStore + amend 修订闭环。
- **M4（收尾）**：writeScope 全面强制 + pivoter 座位 + auto_orch 子图后端接入。

## 10. 待讨论问题

1. charter 的表达式语言边界（meters/tripwires 的条件式）：受限 DSL vs
   直接复用 code node 沙箱执行 JS 片段？倾向前者（可静态校验、可 diff）。
2. probe 规则引擎的内置探针集合：先只做 gradmotion 一类，还是抽象
   `effect kind → probe adapter` 插件面？
3. judge 的证据饮食如何声明得既严格又不僵硬（evidence 白名单 vs 黑名单）？
4. inbox 反馈的优先级语义：普通建议 vs 强制指令（等价于人工绊线）是否分级？
5. lifetime 预算记账的权威源：ledger 汇总 vs WakeStore claim 点缓存，
   崩溃一致性以谁为准（倾向 ledger 为唯一权威，claim 点只读缓存）。
