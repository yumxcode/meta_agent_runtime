# Loop 结构泛化方案评审（2026-07-13）

评审对象：`loop-structural-generalization-plan-2026-07-13.md`（codex 提案，未实现）。

评审方法：逐节对照当前源码（LoopKernel / Seats / CharterValidate / Distiller /
WaitOps / EffectLedger / LedgerApi / runner / daemon，含 2026-07-11~13 全部修复），
并以 `agibot_x1_train_oma/.loop/x1-walking-control-v1` 真实实例做特例压测——该实例
正是 results_improved 事故现场（rounds 12–14 中 stale_count 冻结在 2、连续 pivot），
且评审时仍有一个 self_timer 停泊中的 round 15，是检验兼容迁移的天然金样本。

## 总体判断

方向正确。分层（薄内核 / 受控插件 / 场景包）合理，"明确不做"清单克制且对
（不做任意 DAG、不做图灵完备 DSL、插件不写 Ledger、LLM 不写 projection），
G1→G5 的次序与"先内置场景、ABI 稳定后才开放第三方"的工程纪律也对。

但按源码与特例压测，方案存在 **2 个设计级缺口、4 个关键欠规格、3 个与近期已落地
修复相冲突或失联的点**。结论：可以进入 G1，但 D1/D2/S1/S3 四项必须先补，
C1 须在 G3 前补齐。

## 设计级缺口（不补会重演 X1 事故）

### D1. 缺失 observable 的语义未定义 —— X1 事故根因，方案未吸取教训

X1 实例中 `results_improved` 缺失 → 表达式求值异常 → `safeEval` 回退 →
`stale_count` 冻结在 2 → pivot 绊线每轮触发。这是本项目最重要的一次故障。

方案 §7 的 `ObservableValue.value` 允许 `null`，但 Route 规则对 null/缺失如何求值
只字未提。泛化后 observable 来源从 1 种扩到 6 种，缺失场景只会更多（artifact 未
产出、adapter 超时、pointer 悬空、effect 未 conclude）。

必须补：
- 三态语义：present / absent / error，进本轮审计事件（对齐已落地的
  `RoundEntry.warnings` 机制）；
- 每条 RouteRule 显式声明 absent 行为：`onAbsent: 'skip' | 'false' | 'fail_stop'`；
- 静态校验：rule 引用的每个 observable 必须能追溯到一个声明了产出义务的来源
  （对齐已落地的 JUDGE_CONTRACT 注入原则：声明即强制产出）。

### D2. SEAT 角色模型未定义，`seats: Record<string, SeatSpec>` 是滑向 DAG 的斜坡

当前内核轮内序写死：worker →（diversity/schema/judge 门 + 每因一次纠偏）→ 收尾。
方案允许任意命名 seat 集合，却不说谁先谁后、谁产 artifact、谁触发重试。seat 顺序
一旦可配置，就违背方案自己"不做任意 DAG"的红线。

必须补：**固定角色槽位**——producer / reviewer(s) / pivoter / finalizer。名字可换、
reviewer 数量受限、执行顺序内核所有。这与"judge 输出 schema 内核所有"是同一条
设计原则的延伸。

## 关键欠规格

### S1. 轮内纠偏重试在 Artifact/Gate 协议中消失

现状：gate fail 双重作用——挡入账 + 给 worker 一次带 messages 的同轮重跑
（2026-07-13 刚补齐空 messages 的洞）。方案 §8 的 Gate 只是 commit 过滤器，
proposal→gate→commit 协议没有"fail 后是否重试 producer、messages 如何回传"。

补法：GateBinding 增加 `retryProducer: 0 | 1` 与 messages 回传语义。否则 G1 的
"行为等价"验收无法通过（correctiveRetries 是 RoundEntry 审计字段）。

### S2. Effect rules DSL 悬空，且示例规则对 X1 恰好是错的

§9 的 `"when": "slope < 0.001 && samples >= 5"`：`slope/samples/balance` 等标识符
从哪来（inspect 输出的哪个 pointer）、用什么表达式语言（复用 Expr？标识符宇宙
如何声明与静态校验？）均未定义。

更实质：X1 的平台期判断不是机械规则——"退火阶段 2 是否推 fwd_vel>0.3 同时保
single>0.8"、reward hacking 识别，斜率规则会在 R13 的最优窗口错杀。方案应明确
**混合模型**：adapter rules 只管硬边界（status/timeout/balance/超长等待），
语义性判断留在 worker 收割段（保留 self-timer 路径），而非暗示 rules 取代 worker。

### S3. Distiller 是泛化的最大隐性受害者，方案只给了一行 `distiller-prompt.md`

本周实战结论（X1 臆造键事故 → 契约注入 → prompt 全面对齐审计）：LLM 对着看不见
的契约写 charter 必然出错。GenericCharter 带插件版本绑定、pointer、ShapeSpec，
复杂度远超单 prompt 可靠生成的范围。

必须写明：distiller 输出降级为**场景选择 + 模板参数填空**。自由度只在
goal / rubric / 参数值；绑定结构由 scenario pack 模板固定并经完整校验。
否则已修复的问题类将 ×10 回归。

### S4. Adapter 凭据管理完全缺失

X1 worker 依赖 `account-pool get/remove` 做 API key 轮换——真实运维需求。§10 的
permissions 只有 network/paths/subprocess，没有 secrets 供给、轮换与失效处理模型。
gradmotion adapter 落地第一天就会撞上。需在 plugin manifest 中定义
`credentials: { pool?: string; rotateOn?: string[] }` 一类的声明式凭据接口，凭据
本体由 runtime 注入，绝不进 charter/prompt。

## 与已落地修复的冲突/失联

### C1. §9 与 F12 决策相反且未声明

2026-07-13 刚完成 probe 机制退役（"等待全归 worker 驱动"，ProbeAdapters 已删），
方案又引入 inspect/poll 确定性保底。重新引入可以成立（event 丢失保底目前只有
超时 escalate），但必须显式说明：这是对 F12 的部分回退；self-timer 与 adapter
poll 两条路径如何共存；同一 effect 双通道并发时谁裁决（建议沿用 EffectLedger
conclude 的 first-wins 锁语义）。否则实现者会做出两套打架的等待机制。

### C2. 未建立在刚落地的 postState 之上

§13 Event Ledger + projection 的雏形就是 2026-07-13 落地的 `RoundEntry.postState`
（progress.json 已是可重建缓存，损坏时从 postState 重建、异常时 fail-stop）。
方案应把 rounds.jsonl + postState 声明为 LoopEvent 的演进起点，而非另起新店。

配套问题：
- 核心事件清单漏 `round.aborted`（abortedCostUsd 语义已建立）与预算事件；
- §5 `commit.mode: 'replace'` 与"不删审计历史"红线表面冲突——须写明 replace 是
  projection 级语义，底层仍为 append 事件。

### C3. 九步顺序引错

§1 写作 WAKE→RECONCILE→**CAPSULE→MODE**→…，实际内核是 **MODE→CAPSULE**
（MODE 先消费 pivot 指令并跑 pivoter，其 directive 再注入 worker capsule）。
声称"生命周期保持固定"却引错顺序，应更正。

## X1 特例正向检验（泛化表达力）

映射大多成立：

| X1 现状 | 泛化后 | 判定 |
|---|---|---|
| findings 富结构（direction/task_id/branch/commit/single_change/findings[claim,evidence]） | charter 级 ArtifactSpec.shape 覆盖 pack 默认 | ✓ 方案已支持 |
| `results_improved`（judge 观测，事故源） | artifact pointer 观测（训练曲线数值随 artifact 入账） | ✓ 且更优 |
| bestMetric=0.8053（charter judge prompt 根本未定义 metric 语义，是内核契约逼出来的） | Objective 显式 source + direction | ✓ 消除语义含混 |
| Gradmotion 训练 | effect adapter `gradmotion/task@2` | ✓（受 S2/S4 约束） |
| stale_count/pivot/escalate 结构 | meters/route policies | ✓ |

需要补的两处：

1. **代码 push 到外部 remote 是 effect 而非 artifact**。`workspace_diff` 的 commit
   覆盖不了"远端平台拉取我的分支"这一副作用。需要 artifact→effect 的 provenance
   交接：effect 输入引用已 commit artifact 的 hash。
2. **§12 迁移表遗漏**：capsule 的"已试方向禁重复"守卫、纠偏重试、timer 停泊、
   escalate/re-arm（migrate 即人工 ack + resetMeters）、JUDGE_CONTRACT 注入键、
   warnings 字段。

**建议新增验收项**：把 X1 实例本身作为兼容性金样本——legacy 键 + 富 findings +
正停泊于 self_timer 的 pending round。升级后的 runtime 必须能原地恢复该 park 并
正确续跑；§12 只承诺"不改写冻结快照"，未覆盖"waiting 实例跨版本恢复"。

## 结论与行动项

| # | 事项 | 时点 |
|---|---|---|
| 1 | D1 observable 缺失语义（三态 + onAbsent + 静态校验） | G1 前，阻断 |
| 2 | D2 seat 固定角色槽位模型 | G1 前，阻断 |
| 3 | S1 gate 重试协议（retryProducer + messages 回传） | G1 前，阻断 |
| 4 | S3 distiller 降级为模板填空 | G1 前，阻断 |
| 5 | C2/C3 文档修正（postState 起点、事件清单、九步顺序、replace 语义） | G1 前，低成本 |
| 6 | C1 F12 关系声明 + 双通道裁决 | G3 前 |
| 7 | S2 effect rules 标识符绑定 + 混合模型 | G3 前 |
| 8 | S4 凭据模型 | G3/G4 前 |
| 9 | X1 金样本进兼容验收（含 waiting 实例跨版本恢复） | G1 验收项 |

补齐第 1–4 项后，方案可进入 G1 实施。

---

# 复审附录（2026-07-13，针对吸收评审后的修订版）

修订版已闭环全部 9 项评审意见：D1 三态 observable + `RouteRule.onAbsent/onError` +
obligation 静态校验（§7.1）；D2 五角色固定槽位（§4.1）；S1 同轮纠偏协议（§8.1）；
S2 observation schema 标识符 + 硬边界白名单（§9.2）；S3 Distiller 模板参数化
（§11.1）；S4 SecretBroker（§10.1）；C1 声明为 F12 部分回退 + first-wins 原子裁决
（§9.1）；C2 从 rounds.jsonl+postState 演进（§13.1）；C3 顺序更正；另有 §5.1
ArtifactRef→Effect provenance 链、§12.1 X1 waiting 金样本、G0 阶段与
`round.aborted`/预算事件，均到位。

复审发现 3 个残留问题：

## A1（重要）三态语义只覆盖 Route，未覆盖 METER/Reducer —— 恰是 X1 事故的冻结点

G0 验收写了"不得出现 meter 静默冻结"，但正文只为 RouteRule 定义了 `onAbsent`。
更深一层：GenericCharter 中 `meters` 字段消失、迁移表也没有 meters 行——X1 charter
的 `stale_count incWhen/resetWhen` 迁往何处没有答案。若并入 Reducer/projection，
§6 规定 Reducer 输入校验失败"本轮 fail-stop"，则一个声明了 `onAbsent:'skip'` 的
observable 被 reducer 消费时，是传入 absent 状态还是触发 fail-stop？两处语义打架。

要求补：
- 一节"三态在 Reducer 输入端的传播规则"。建议：reducer 输入签名显式接受三态、
  分支必须穷尽（absent/error 有显式处理路径），冻结时静态校验；
- 迁移表增加 "`meters`（incWhen/resetWhen DSL）→ ?" 行；
- present 态 `value: null` 与 Expr 严格类型求值相遇时的判定（null 参与比较应归入
  error 态处理，不得抛回 safeEval 式回退）。

## A2（中）纠偏预算收紧与 G1 parity 验收自相矛盾

现内核 diversity/schema/judge 各自可重试一次，一轮 `correctiveRetries` 可为 2+；
§8.1 规定"多 Gate 不累加、一轮最多一次"；而 G1 验收要求"纠偏次数相同"。二者必居
其一：

- 方案 A：改为 per-GateBinding 各一次（自然上界 = 绑定数，仍有限且可审计）；
- 方案 B：维持"一轮一次"，显式声明为行为变化，并放宽 G1 该条 parity 判据。

不改则 G1 验收必然失败、或被迫隐式降级——后者是方案自己（§16 末段）明令禁止的。

## A3（轻）两处不一致 + 一处措辞

1. §4.1 "reviewers 读取同一批冻结证据"与 §8 "Gate 输入是显式 evidence whitelist"
   冲突（现实现为 per-seat inputs；judge 与合规 reviewer 理应看不同文件）。应改为
   "各自声明的证据白名单，冻结于同一时点快照"。
2. reviewer 崩溃一次重跑后 fail-closed 的现有语义（judgeCrash retry）未进
   §4.1/§8.1，迁移表亦无此行。
3. §12.1 "保持 ledger hash" 应为"前缀段 hash 不变"——恢复后必然追加新事件。

## 复审结论

| # | 事项 | 时点 |
|---|---|---|
| A1 | Reducer 端三态传播 + meters 迁移行 + null/Expr 判定 | G0 文本定稿前，阻断 |
| A2 | 纠偏预算择一（建议方案 A） | G0 文本定稿前，阻断 |
| A3 | 证据白名单措辞、reviewer 崩溃语义、ledger hash 措辞 | G1 前，低成本 |

A1/A2 补齐后，G0 可以开工。

---

# 三审附录（2026-07-13，针对吸收复审后的修订版）

A1/A2/A3 均已高质量闭环：§6.1 把三态贯穿 Reducer/METER（`ReducerInput.observations`、
`accepts` + 穷尽分支静态校验、counter 的 `onAbsent/onError: increment|reset|retain|
fail_stop`、present-null 参与 Expr 运算归入 error 态），迁移表补齐 meters 行；§8.1
改为 per-GateBinding 纠偏预算，`executionRetry`（同一 evidence snapshot 原地重跑、
不计 correctiveRetries）与 producer 纠偏正交分离，judge 崩溃重跑语义保留，G1 验收
补上"diversity/schema/judge 依次各纠偏一次 + judge 崩溃重跑再崩 fail-closed"用例；
§4.1/§12.1 三处措辞修正到位。

不再有阻断级设计缺口。三审发现 4 个收尾级问题：

## B1（中）counter 兼容 fallback 是上下文相关的，静态枚举表达不了

现实现中 `incWhen` 求值失败的回退是 `!worker.ok`——**依赖 producer 本轮成败**：
worker 失败 → increment，worker 正常但 observable 缺失 → false（retain）。§6.1 的
`onAbsent/onError` 是静态四选一，配 `increment` 或 `retain` 都无法同时复现两种情形，
G1 的"meter parity"验收会在此踩空。

建议采用更干净的解法：把 producer 本轮成败建模为**恒 present 的内置 observable**
（如 `producer_ok: boolean`），research 兼容 binding 的 incWhen 直接写
`producer_ok == false || new_findings == 0 || …`，`onError` 一律 `retain`。这同时
消灭了"求值失败 → 条件性 increment"这一最后的隐式 fallback，比在枚举里加
`increment_if_producer_failed` 更符合方案自己的显式化原则。

## B2（轻）HealthRule 缺三态声明

`policies.health` 与 RouteRule 并列，但 HealthRule 未定义 `onAbsent/onError`。要么
补齐同款声明，要么规定 health 只允许消费 state projection（恒 present），冻结时
校验。

## B3（轻）G0 范围应限定为"契约冻结"，模板渲染器实现不应阻断

G0 清单含"ScenarioTemplate 与参数化 Distiller"——模板渲染器依赖场景包基建，是
G1 工程量。建议 G0 措辞改为"冻结 ScenarioTemplate 接口与校验规则"，实现落 G1，
避免 G0 被拖成半个 G1。

## B4（轻）objectives 对 present-null 的更新语义未写

`metric: number|null` 是 JUDGE_CONTRACT 常态。objective source 读到 present-null
时 bestMetric/objective projection 应 skip update 并记诊断，一句话写明即可（更新
逻辑是 code 而非 Expr，不受 §6.1 的 error 态规则覆盖）。

## 三审结论

| # | 事项 | 时点 |
|---|---|---|
| B1 | producer_ok 内置 observable + 兼容 binding 表达式改写 | G0 文本定稿时 |
| B2 | HealthRule 三态声明或限定来源 | G0 文本定稿时 |
| B3 | G0 范围措辞收窄 | 文档修订，随手 |
| B4 | objectives present-null 语义一句话 | 文档修订，随手 |

四项均为收尾级。B1 处理后，方案可冻结进入 G0 实施。

---

# 四审附录（2026-07-13，针对吸收三审后的修订版）

B1–B4 均已闭环且质量到位：

- B1：`producer_ok` 为保留 kernel source（`from:'kernel'` 不可扩展、恒 present、
  插件不可伪造、provenance 指向 seat 事件）；legacy `incWhen: E` 改写为
  `producer_ok == false || (E)` 借短路求值复现双情形（producer 失败→不触碰缺失
  observable 即得 true；producer 成功且缺失→error→retain）；G0 验收加入双情形
  注入用例；"删除最后一处 `!worker.ok` 隐式 fallback"目标达成。
- B2：`ObservationFailurePolicy` 统一 Route/Health，并明确 skip/false 不沿用上一轮
  结果。
- B3：G0 收窄为"冻结 ScenarioTemplate 接口与校验规则，不实现渲染器"，渲染器实现
  移入 G1。
- B4：Objective `onAbsent/onNull: skip_update` + 诊断事件，禁止 null 当 0/无穷/
  Expr error。

四审发现 3 个文档级精度问题，无阻断项：

## C1'（轻）改写规则在 meter-only 表达式角落偏离现语义

现内核的 `!worker.ok` fallback 只在**求值异常**时生效；只引用 meters 的 incWhen
（如 `iteration > 3`）在 worker 失败轮上会正常求值取真实结果。改写为
`producer_ok == false || (E)` 后该情形恒为 true。研究包 stale_count 不受影响，但
严格 Ledger parity 可能在含 meter-only 表达式的 charter 上踩到。应将改写规则限定为
"引用了 judge 来源 observable 的表达式"，或显式声明此角落为接受的语义修正并调整
parity 判据。

## C2'（轻）`producer_ok` 定义中"取消"与 abort 语义矛盾

abort 轮不入账、不到 METER（wake 回队重放，F2 语义），§7.1 自己也写了"没有到达
METER 的 attempt 不生成 counter 更新"。false 清单应删去"取消"，保留预算阻止
（budget-blocked seat 确实到达 METER）。

## C3'（轻）`seat.blocked` 未入核心事件清单

§7.1 以 `seat.blocked` 作 provenance，§13 事件清单无此项。补入清单，或并入
`seat.completed` 加 blocked 标记。

## 四审结论

三处均为一行级文档修订，修完即可冻结方案、进入 G0 实施。本评审序列（初审 9 项 →
复审 3 项 → 三审 4 项 → 四审 3 项，严重度单调下降且全部闭环）至此收敛。
