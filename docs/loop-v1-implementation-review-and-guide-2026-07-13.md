# Loop v1.0 泛化实现审核报告与使用指南（2026-07-13）

审核对象：commit `6f9ef93 loop v1.0`（+8250 行 / 60 文件），即
`loop-structural-generalization-plan-2026-07-13.md` 经四轮评审收敛后的实现。

## 1. 审核结论

**通过。** G0 契约全部落地，G1 完成，G2 有实证（release/compliance 两个非研究场景
零内核改动），G3 完成主体（SecretBroker 未实现）。tsc 通过；1193 个测试全绿
（较修复前 +70）。X1 真实实例在新运行时下实测兼容（见 §5）。

### 1.1 G0/G1 契约验证矩阵

| 契约项 | 实现位置 | 验证 |
|---|---|---|
| Observable 三态 present/absent/error | `types.ts ObservationResult`、`LoopKernel collectObservations` | 单测 + X1 重放 |
| RouteRule/HealthRule/Tripwire `onAbsent/onError` | `CharterTypes`、`LoopKernel evaluateObservationRule`（先真实求值、失败后分类，保短路语义） | 单测 |
| `producer_ok` 保留 kernel observable | `CharterTypes.PRODUCER_OK_OBSERVABLE`，validator 拒绝同名声明 | 单测 |
| legacy meter 改写 `producer_ok == false \|\| (E)` | `CharterValidate.withProducerOkForMissingJudge`——**仅改写引用 judge observable 的表达式**（四审 C1' 修正已采纳），meter-only 表达式不动 | 单测 + X1 重放 |
| METER = 确定性 counter reducer | `projection/ConditionalCounterReducer`（求值异常 → retain + 诊断，`safeEval` 隐式 fallback 已消灭） | 单测 + X1 重放 |
| Reducer 契约（manifest/accepts/穷尽） | `projection/ReducerContract` | 单测 |
| 义务图 obligation 静态校验 | `CharterValidate buildObligations`，冻结进 `frozen.observableObligations`；legacy 快照加载时内存重建 | X1 实测 |
| 固定角色槽位 | `FrozenSeatPlan`（producer/reviewers/pivoter/finalizer）+ `charter/ExecutionPlan` | 单测 |
| GateBinding per-binding 纠偏 + executionRetry 正交 | `FrozenGateBinding`；research 的 judge 绑定 `retryProducer:1, executionRetry:1`，diversity `retryProducer:1` | 单测 |
| Objective `onAbsent/onError/onNull` | `charter.metric` + `evaluateMetricObjective` | 单测 |
| Artifact 流（proposal→gate→commit 事务） | `artifacts/ArtifactProtocol/Executor/Indexes/SegmentStore` | 单测 |
| 投影 checkpoint（热路径有界） | `projection/ArtifactCheckpoint`（projector v3、segment 轮转、stateHash） | 单测 |
| 场景注册表 | `scenarios/ScenarioRuntime`（research/generic/release/compliance 四个内置），未知 ID fail-closed | 单测 |
| EffectAdapter ABI（submit/inspect/cancel/reconcile） | `effects/EffectAdapter` + `EffectRuntime`（`effect_poll` wake、admission 限流） | 单测 |
| Effect Rule 硬边界 DSL | `effects/EffectRules`（标识符来自 observation schema、冻结校验） | 单测 |
| event 通道鉴权 | `effects/EventAuth`（HMAC 签名 + nonce + 过期，**超出方案要求**） | 单测 |
| first-wins 双通道裁决 | event/poll/timeout 全部经 `EffectLedger.conclude`（带锁）唯一转换 | 单测 |

### 1.2 内核业务词汇清零

`LoopKernel.ts` 中 `finding`/`direction` 业务分支为 0（唯一命中是
`charter.metric?.direction` 策略字段）。findings/directions 的语义完全迁入
`scenarios/research/ResearchArtifacts`，以 artifacts.jsonl 为权威、legacy
`findings.jsonl` 作为兼容投影双写（供既有工具与 capsule parity）。

### 1.3 已知边界（非缺陷，按计划分期）

- SecretBroker 未实现（G3 余项）：X1 的 account-pool 轮换仍走 worker prompt；
- `ScenarioTemplate.render` 未作为具名构件存在：distiller 直接产出 charter，但
  绑定结构由注册表在冻结时解析固定、validator 强校验——参数边界事实成立，命名
  构件可后补；
- 插件 JSON-RPC 子进程 ABI（G4）、round child process 与 admission control（G5）
  未做；四个场景包为内置代码而非外部包；
- Effect admission 为单主机进程内限流（v1 声明如此）。

---

## 2. 架构说明

```text
┌────────────────────────────────────────────────────────────┐
│ Scenario Pack（scenarios/）                                 │
│ research@1 · generic@1 · release@1 · compliance@1          │
│ ArtifactSpec 模板 / 产出契约 / 场景门 / capsule·报告视图    │
├────────────────────────────────────────────────────────────┤
│ 受控构件层                                                  │
│ artifacts/  Artifact 事务（proposal→gate→commit、segment）  │
│ projection/ 确定性 reducer + checkpoint（三态输入契约）      │
│ effects/    EffectAdapter ABI + Rules + EventAuth + 轮询     │
├────────────────────────────────────────────────────────────┤
│ Generic Loop Kernel（kernel/ + charter/）                    │
│ 九步轮管线 · 固定角色槽位 · GateBinding 纠偏协议             │
│ 三态观测 · producer_ok · 预算/abort/路由/终止                │
├────────────────────────────────────────────────────────────┤
│ Durable Runtime                                             │
│ ledger/（rounds+postState、重建、尾读）· wake/（claim/租约） │
│ instance/（冻结/迁移/re-arm）· security/（路径与沙箱下译）   │
│ runner/daemon（两相调度、并发、fail-stop 分诊）              │
└────────────────────────────────────────────────────────────┘
```

九步生命周期不变：WAKE → RECONCILE → MODE → CAPSULE → SEAT → GATE → METER →
LEDGER → ROUTE。固定的是控制流、事务与安全边界；场景包只能提供构件，触不到
调度、账本与预算。

---

## 3. 机制说明

### 3.1 观测与路由（事故根因的结构性修复）

每个 observable 每轮产出 `ObservationResult`：`present`（含值）/ `absent`（含
reason）/ `error`（含 errorCode）。三态全部进轮审计。规则求值先真实执行（保留
`&&`/`||` 短路），失败后按引用的观测状态分类，再按该规则声明的
`onAbsent/onError`（skip / false / fail_stop）处理并写 warning——内核不再为任何
缺失值猜默认。

`producer_ok` 是内核保留、恒 present 的布尔观测。冻结时，引用了 judge observable
的 legacy `incWhen: E` 被改写为 `producer_ok == false || (E)`：producer 失败短路
为真（失败轮即 stale），producer 成功而观测缺失则 error → retain + 诊断。
X1 的"stale_count 冻死 + 连环 pivot"在此结构下不可再现。

义务图（obligations）在冻结时建立：每个被规则引用的 observable 必须追溯到产出
义务；judge 来源的键全部注入 JUDGE_CONTRACT 强制输出——"声明即强制产出"。

### 3.2 座位与门（固定角色，有界纠偏）

执行计划冻结为固定槽位：pivoter（仅 pivot 轮）→ producer（唯一主执行位）→
reviewers（0–3 个隔离评审位）→ finalizer（仅终止后）。顺序、数量上限、重试
后果由内核所有；charter 只能配 prompt/模型/工具/预算。

GateBinding 两类重试正交：`retryProducer`（每绑定至多一次，汇总 messages 回传
producer 同轮重做，重跑全部相关门）与 `executionRetry`（同一证据快照原地重跑门
执行，处理评审位崩溃，不产生新 proposal 不计纠偏）。一轮纠偏总上界 = 声明
retry 的绑定数，另受轮预算约束。

### 3.3 Artifact 事务与投影

产物不再由内核硬编码：charter/场景声明 `ArtifactSpec`（kind、draftPath、stream、
commitMode append/replace/versioned、requiredGates）。producer 只写 draft；内核
走 proposal → 全部 required gates pass → commit 的事务，事件追加进
artifacts.jsonl（segment 轮转 + checkpoint 投影，热路径与近期窗口相关）。
`replace` 只是投影层最新值语义，底层事件不可删。被拒 proposal 留
`artifact.rejected` 审计。

### 3.4 外部副作用（Effect）

两条等待路径边界固定：`self_timer`（无 adapter，唤醒后由 producer 做语义判断——
平台期、reward hacking 这类判断永远在这里）与 `effect_wait`（有 adapter：event
低延迟通知 + `effect_poll` wake 驱动 inspect 硬边界保底 + 超时确定性升级）。
Effect Rule 只准硬边界（terminal 状态/超时/余额/失败码/安全数值界），标识符来自
adapter 版本化 observation schema，冻结校验。event/poll/timeout 竞争由
EffectLedger 带锁 conclude 的 first-wins 裁决；event 文件经 HMAC 签名鉴权。

### 3.5 账本与恢复

rounds.jsonl 每轮附 `postState`（权威 checkpoint），progress.json 是可重建缓存：
损坏 → 从 postState 重建；无法重建 → `LedgerCorruptionError` fail-stop。abort 轮
不入账、wake 回队、成本记 `abortedCostUsd` 随重放并账。writeScope 下译为 OS 沙箱
+ file 工具双层写守卫；charter 路径全部经 PathSafety（词法 + realpath）。

---

## 4. 泛化性论证：有没有陷入 X1 特例？

**没有。** 判据与证据：

1. **内核词汇表**：kernel 源码零 finding/direction 分支（§1.2），只认识
   artifact/stream/gate/observation/effect——X1 的"研究发现"只是 research 包里
   的一个 append 流。
2. **换场景不改内核**：release（manifest replace 流 + note versioned 流）与
   compliance（human_approval 门，无 LLM 评审也能走完提交）两个场景仅由
   `ScenarioDefinitions` 声明构成，各自有独立测试（`BuiltinWorkScenarios.test`、
   `ScenarioRegistry.test`），未触碰 LoopKernel。
3. **X1 专有的东西都在正确的层**：Gradmotion 平台细节、gm CLI、账号轮换、平台期
   判断——全部在 worker seat prompt（charter 数据）里，内核与场景包均无一行
   涉及。将来 gradmotion 写成 EffectAdapter 也只是新增一个 adapter 注册项。
4. **特例被泛化模型完整覆盖（实测）**：X1 冻结于旧 schema 的实例在新运行时下
   加载 → 自动解析为 `builtin/research@1`、义务图重建、`results_improved` 注入
   judge 契约、停泊中的 self_timer round 15 可恢复；事故场景重放得到
   "retain + 显式诊断"而非静默冻结（§1 矩阵）。

一句话：research 从"内核的本体"降级成了"注册表里四个场景之一"，而 X1 只是
research 场景的一份 charter 数据。

---

## 5. 使用方法

### 5.1 通用流程

```bash
# 1) 写需求文档（自然语言，描述目标/迭代方式/终止条件/预算）
# 2) 蒸馏出 charter（distiller 选场景、填参数，validator 强校验、错误回灌重试）
meta-agent loop distill --doc requirements.md
# 3) 创建实例（冻结 charter：表达式→AST、义务图、执行计划、场景绑定全部定格）
meta-agent loop create --charter charter.json
# 4) 驱动：单步或守护进程（并发默认 4，长 seat 不阻塞其他 loop）
meta-agent loop tick
meta-agent loop daemon
# 5) 观察与干预
meta-agent loop list / inspect <id>       # 状态、rounds、warnings、artifacts
meta-agent loop inbox <id> "人工反馈..."   # 下一轮进 capsule
meta-agent loop pause / resume / stop <id>
meta-agent loop migrate <id> --charter v2.json  # 版本升级；escalate 后即人工 ack + re-arm
```

选场景的经验法则：迭代研究/调参/实验 → `research@1`；产出结构化交付物、需要
schema 门 → `generic@1` 或 `release@1`；需要人工审批才能提交 → `compliance@1`。

### 5.2 charter 里你真正要写的东西

goal（验收目标，judge 靠它判 goal_satisfied）、producer prompt（领域动作）、
reviewer rubric（判什么、自定义观测键的语义）、observables/meters/tripwires
（何时 pivot/escalate/finalize）、budgets.lifetime（必设）、writeScope
（字面路径或 `path/**`）。输出格式、重试、账本、等待机制一概不写——内核契约
自动注入，写了反而冲突。

---

## 6. agibot X1 操作步骤（特例走查）

### 6.1 存量实例：直接继续跑

`x1-walking-control-v1`（v1 冻结、round 15 停泊在 self_timer）无需任何迁移：

```bash
cd ~/code/robot_x/X1/agibot_x1_train_oma
meta-agent loop daemon        # 或 loop tick
```

RECONCILE 自动补 timer wake → 到点唤醒 lineage worker 进收割段（检查
TASK_20260711_135 的退火曲线）→ 判断继续等/收割 → 轮末新运行时下
`results_improved` 已被注入 judge 契约必然输出；即使 judge 违约漏输出，得到的
也是 retain + rounds.jsonl 里的显式诊断，不会再连环 pivot。

建议顺手做一次显式迁移（v1→v2）以获得完整新语义（tripwire/health 的
onAbsent 默认从兼容值 `false` 收紧为你想要的策略）：

```bash
meta-agent loop migrate x1-walking-control-v1 --charter charter.v2.json
# v2 相对 v1 仅加：{"scenario":"builtin/research@1"}、tripwire/health 的
# onAbsent/onError 显式声明、（可选）"metric":{"direction":"max"}
```

### 6.2 新开一个同类 loop（新语义完整版）

1. 需求文档要点：目标（步态指标阈值原样写进 goal）、每轮单变量因果归因、
   Gradmotion 提交/收割细节与账号轮换写进 worker prompt、平台期判断规则写进
   收割段指引、`writeScope: ["humanoid/**"]`、budgets.lifetime {rounds:20, usd:100}。
2. `loop distill` → 检查产出 charter：确认 `scenario: builtin/research@1`；
   observables 若声明 `results_improved` 这类自定义键，**必须**在 judge rubric
   里定义其语义（义务图会强制 judge 输出它，语义没写它只能瞎填）；
   tripwires 建议 `stale_count >= 2 → pivot`（onAbsent: false）、
   `stale_count >= 4 → escalate`（onResume.resetMeters: [stale_count]）。
3. `loop create` → `loop daemon`。
4. 训练中人工干预：`loop inbox <id> "优先验证 reward 退火，别再动 DR"` ——
   下一轮 capsule 生效；escalate 后改 charter 再 `loop migrate` 即 ack 复跑。
5. 收尾：goal_satisfied / 预算耗尽 / finalize 绊线 → `reports/final_report.md`
   （研究视图：成果、dead ends、后续建议）。

### 6.3 X1 的后续升级路径（可选，不阻塞使用）

- 把 Gradmotion 封成 `EffectAdapter`（submit=task create+run，inspect=task info
  + data get 硬状态，cancel=task stop），charter 的 effects 绑定接管
  "任务失败/余额耗尽/超时"三类硬边界与事件丢失保底；平台期语义判断保持在
  worker 收割段——这是设计边界，不是欠缺。
- 账号轮换等 SecretBroker（G3 余项）落地后从 prompt 迁入 adapter credentials。

---

## 7. 后续工作清单

| 项 | 阶段 | 说明 |
|---|---|---|
| SecretBroker + adapter credentials | G3 余项 | X1 账号轮换的正式归宿 |
| ScenarioTemplate 具名渲染器 | G1 补强 | 现由注册表冻结解析 + validator 事实达成 |
| 插件 JSON-RPC 子进程 ABI | G4 | 第三方 adapter/gate/reducer |
| round child process + admission control | G5 | 故障隔离与多租户配额 |
| gradmotion EffectAdapter | 场景需求 | §6.3 |
