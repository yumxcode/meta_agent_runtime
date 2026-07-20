# Meta-Agent Graph Loop 机制全面审核报告

日期：2026-07-19
范围：`src/loop/graph/**`（spec / runtime / agent）、`src/loop/expr/Expr.ts`、`src/loop/runner.ts`、`src/loop/daemon.ts`、`src/infra/persist`（锁与原子写）
方法：逐文件精读核心 4.5k 行源码；针对每个疑点回读代码交叉验证；在本机运行全部相关测试（`vitest run src/loop/graph src/loop/expr`：**10 个文件、65 个测试全部通过**）。

---

## 一、总体结论

durable-graph-v2 的设计质量整体较高：控制面（Control）/ 会话面（Lane）/ 工作区（Workspace）三面分离清晰，commit 协议（journal 先行 + prepared intent + commitKey 幂等 + lease fencing + continuationVersion）在崩溃恢复上是闭合的，校验器对"逻辑闭环"的机械保证（outcome 全覆盖、唯一 default、priority 唯一、可达性、终态可达性、强制 maxActivations 保险丝、ABI 未知字段拒绝）相当完备。

按四项要求打分（满分 5）：

| 维度 | 评分 | 摘要 |
|---|---|---|
| 多种 loop 场景 | 4.5 | 计数/条件循环、长任务分段（hard park）、定时/轮询、外部事件、fan-out/join（嵌套）、人工介入（paused terminal）均覆盖；join 缺超时是唯一明显缺口 |
| 逻辑闭环 | 4.5 | 静态闭环校验完备；两处运行时闭环缺口（见 M1、M2） |
| 简单 | 4 | 核心 runtime 约 4.5k 行；复杂度集中在 `GraphStore.reconcileLocked` 一处，可接受 |
| 稳定可靠 | 4 | commit/恢复协议严密；发现 3 个中等、7 个低等问题，无高危 |

未发现会导致状态损坏或重复提交的缺陷。以下问题按严重度排列，均已在源码中逐一确认（非推测）。

---

## 二、中等严重度发现

### M1. Join 唤醒信号在崩溃窗口丢失，可能造成永久卡死

位置：`GraphKernel.finishActivation`（L413-416）、`GraphKernel.tick` 恢复段（L115-127）、`NodeExecutors.executeJoin`（L312-335）

Join 成员未凑齐或非 leader 时以**纯 event、无 wakeAt** 的方式 park（内部事件 `join:<node>`）。该事件唯一的发出点是 `finishActivation` 在 live commit 之后对新 spawn 的 join 子节点调用 `resumeDue`。但 `tick()` 开头通过 `recoverPrepared` 重放的 commit **不会补发这个事件**。

故障序列：分支 X 的 commit 已写入 journal（spawn 了最后一个 join 成员 A）→ 进程在调用 `resumeDue` 前崩溃 → 重启后 A 为 ready 并执行 `executeJoin`；若按 id 排序选出的 leader 恰是先前已 park 的成员 B，A 也会 park。此后所有成员均为 waiting、无 wakeAt，再无任何代码路径发出 `join:<node>` 事件——实例永久停在 `waiting`（仅 `maxWallTimeMs` 保险丝或运维手工 `loop event <id> join:<node>` 可解）。

建议（任选其一即可闭环，两者都做更稳）：
1. `tick()` 恢复循环中，对 `recoverPrepared` 返回的每个非 duplicate 结果的 join spawn 同样调用 `resumeDue(join:<node>, forkGroupId)`；
2. `executeJoin` 非 leader park 时附带一个轮询 `wakeAt`（如 now+30s），使 join 具备自愈能力（与 effect 轮询同款模式，代价极小）。

### M2. `limits.maxWallTimeMs` 对纯事件等待的实例不生效

位置：`GraphKernel.tick`（L110-113）、`runner.prepareAndClaim`（L49-80）

墙钟保险丝只在 `tick()` 入口检查。而 `prepareAndClaim` 只为**带 wakeAt** 的 waiting activation 和 **active** 实例调度 wake；一个停在 `wait{kind:'event'}`（未设 timeoutMs）的实例状态为 `waiting`、无任何 wake，`tick()` 永远不会被触发——`maxWallTimeMs` 形同虚设，直到下一次事件到达才补检。文档把 maxWallTimeMs 列为循环保险丝之一，此处与承诺不符。

建议：实例进入 `waiting` 且设有 `maxWallTimeMs` 时，为其调度一个 `createdAt + maxWallTimeMs` 的 `__graph__` wake（WakeStore 已具备全部能力，一行调度即可）。

### M3. serializable 策略下 Agent 节点的重放成本放大

位置：`GraphKernel.finishActivation`（L278-319）、`MAX_SERIALIZABLE_REPLAYS = 50`

serializable 冲突重放不消耗 attempt（正确），上限 50 次。但对 **agent 节点**，每次重放是一个完整的付费 Agent 段；`lifetimeBudget` 与 `limits.maxCostUsd` 均为可选项——两者都未设置时，一个高争用图理论上可为单个 Activation 烧掉 50 段成本。50 的上限对 function 节点合理，对 agent 节点过宽。

建议：validator 增加规则——`stateConsistency: 'serializable'` 且图中含 agent 节点时，强制要求该节点声明 `lifetimeBudget.usd`（或 graph 级 `maxCostUsd`）；或对 agent 节点单独采用更低的重放上限（如 5）。

---

## 三、低严重度发现

**L1. Join 无超时能力（场景缺口）。** `wait` 节点有 `timeoutMs`，join 没有。若某个 expected 分支走了 failure 路由且失败路径没有直达 done/failed terminal（例如回环重试后放弃在中间态），join 成员将永久等待。静态校验无法发现这类语义死路。建议：join 支持可选 `timeoutMs`（超时按 `timeout` outcome 路由），或至少在 loop-runtime-guide 的运行前审查清单中明确"每个 expects 分支的失败路径必须到达 terminal 或回到 join"。

**L2. attempt 语义与类型文档矛盾。** `ActivationRecord.replayCount` 注释称 lease 丢失是"non-attempt-consuming replay"，但 `GraphStore.releaseExpiredClaims` 将过期租约标记为 `readyReason: 'retry'`，下次 claim 会消耗 attempt。代码方向其实更安全（防崩溃-重启无限循环烧钱），矛盾在文档。建议修正注释，明确"lease 过期消耗 attempt 是刻意的防护"。

**L3. 事件 inbox 与 journal 无限增长。** 超时后到达（`createdAt >= wakeAt` 被判负）或永不匹配的外部事件永久滞留为 `pending`；journal 文件在 checkpoint 之后也不修剪。长周期实例磁盘线性增长。建议：`loop gc` 增加对已终态实例外的 pending 事件过期清理，以及 checkpoint 之前 journal 段的归档压缩（保留审计可导出 tar）。

**L4. Agent timer 恢复上下文未注入 prompt。** `__agentTimerReason` / `__continuationCheckpoint` / `__resume` 写入 activation.input 后，`buildGraphAgentUserPrompt` 只渲染 `node.inputs` 的显式绑定——恢复段完全依赖 persistent Lane 的会话续接（lineageSessionId）。checkpoint 目前是"只写不读"的死数据；若 lineage 会话丢失或被压缩，恢复段将没有任何"你为何被唤醒"的上下文。建议：恢复段（continuationVersion > 0）自动在 user prompt 中追加一个 `resume_context` section（park 原因 + checkpoint + 定时/事件 payload），成本一行、收益明确。

**L5. 展平命名空间的 `.` 键碰撞。** `flattenPrimitives` 将 `{"a.b":1}` 与 `{a:{b:1}}` 展平为同一个键 `output.a.b`。Agent 输出不可控，碰撞时条件会取错值。建议展平时跳过（或转义）含 `.` 的键。

**L6. `$output` 引用拼写错误被静默吞掉。** 缺失引用→边不匹配→落 default 是有意设计（可选字段路由），但拼错的 `$output.done_` 也会永远走 default。当节点声明了 `outputSchema` 且 `additionalProperties: false` 时，validator 完全有能力静态校验 `when` 中的 `$output.x` 是否在 schema 中——建议补上这条免费的静态检查。

**L7. runner 的 5 次重试窗口与 15 分钟锁 stale 窗口不匹配。** 持锁进程僵死时，锁要 15 分钟才可被 rename 抢占，而 wake 重试 5 次约 5-6 分钟就耗尽并尝试将实例置 failed。实际大多被"setStatus 同样拿不到锁"意外缓解（失败静默、重新调度），属侥幸闭环。建议将 `withFileLock: timed out` 明确归类为瞬态错误（不计入 MAX_WAKE_ATTEMPTS），或使锁 staleMs 与重试窗口协调。

---

## 四、场景覆盖矩阵（要求一：多种 loop 场景）

| 场景 | 支持方式 | 验证 |
|---|---|---|
| 有界计数循环 | 自环 transition + reducer + `when`，`maxActivations` 保险丝强制存在 | ✓ 文档示例 + `recover` 测试 |
| 条件收敛循环 | commit 时以最新 State 评估 `when`（commit_latest 语义正确：reducer 在权威快照上运行，无丢失更新） | ✓ 源码确认 |
| 长任务分段（数天级） | Agent hard park：段预算/生命周期预算/maxParks 三层限制，固定 deadline 防漂移 | ✓ |
| 定时等待/外部轮询 | `wait{timer}`、effect 30s 轮询 park；lease 重放复用 `__timerDeadline` 不延长 | ✓ 测试覆盖 |
| 外部事件驱动（webhook） | 早到 inbox、`source+deliveryId` 幂等去重、timeout-first-wins（`createdAt < wakeAt` 确定性裁决） | ✓ 测试覆盖 |
| 并行 fan-out / join | fork epoch 栈（`outer\|inner`）正确处理嵌套 fork/join；join 幂等合并、late-arrival spawn 去重 | ✓ 测试覆盖；见 M1/L1 |
| 人工介入循环 | paused terminal + `resume` 边恰好一次恢复 | ✓ |
| 失败重试 | 指数退避（封顶 60s）、replay 不消耗 attempt、serializable 冲突退避 | ✓；见 M3 |

缺口仅 join 超时（L1）。

## 五、逻辑闭环评估（要求二）

静态层（GraphValidate）已机械保证：每个非终态节点的所有 requiredOutcomes 必须路由或有 `always` 兜底；条件路由必须恰好一条 default、priority 唯一；全图可达 + 每个节点可达 done/failed 终态（paused 不算闭合终态，其 resume 链也必须闭合）；`maxActivations` 必填。

运行时层的闭环同样扎实：executor 抛错→非 agent 节点转 failure outcome（failure 路由必存在）；transition/reducer 求值抛错→持久 failed commit（避免 prepared intent 反复重放同一异常把实例卡死——代码注释明确此设计意图）；park 超限→转 failure；quiesce 无终态→实例判 failed（"quiesced without reaching a terminal node"）。

仅有的两个运行时闭环缺口即 M1（join 唤醒丢失）与 M2（maxWallTimeMs 休眠不检）。

## 六、简单性评估（要求三）

值得肯定的克制：Expr DSL 白名单化（无 eval、无索引、无三元、严格类型、静态引用检查）；ValueExpression 仅 literal/ref/call 三种形式；节点仅 6 类；未知可执行字段一律拒绝（GraphAbiValidate）；观察者 fail-open 不影响执行。复杂度主要集中在 `GraphStore.reconcileLocked`（checkpoint + journal 重放 + 投影修复 + 心跳覆盖，约 90 行），是全系统唯一"难读"的函数，但职责单一、有 `repairedThrough` 去重优化，属必要复杂度。建议为其补充一段不变量注释（journal 权威、投影可再生、心跳仅覆盖同 token 租约）即可。

## 七、稳定可靠性评估（要求四）

崩溃一致性协议核对结论：journal 先于投影写入；`atomicWriteJson` 全部走 tmp+rename；commitKey = `activationId:continuationVersion` 幂等去重；commit 校验 continuationVersion + 状态机（running/ready）；**每个 tick 的 recoverPrepared 先于 releaseExpiredClaims**，保证已 prepared 的结果总是先于重跑落地（我构造了双 owner 竞争、prepare 后冻结、lease 过期重claim 等多个对抗序列逐一验证，均收敛到单次 commit）；心跳容忍 3 次瞬态失败、"definitively not owned" 才弃段；文件锁的 stale 抢占用 rename 保证唯一赢家。此外崩溃时对 Agent 段按 `budget.usd` 保守预扣成本，防止 crash-retry 穿透 `maxCostUsd`——方向正确。

风险集中在活性（liveness）而非安全性（safety）：M1、M2、L7 都是"卡住/误杀"类问题，不会损坏状态。

## 八、修复优先级建议

1. **M1**：恢复路径补发 join resume + join park 加轮询 wakeAt（两处共约 10 行，消除唯一的永久卡死路径）。
2. **M2**：waiting 实例按 `maxWallTimeMs` 调度到期 wake（约 5 行）。
3. **M3**：validator 对 serializable+agent 强制预算声明（校验规则一条）。
4. **L4**：恢复段自动注入 resume_context（提升长任务可靠性，行数极少）。
5. **L6**：outputSchema 与 `when` 的 `$output` 引用交叉校验（免费的静态防线）。
6. 其余 L 项按运维节奏安排。

---

*审核基于 2026-07-19 工作区快照；所有行号以当时文件为准。65 个既有测试全部通过；上述发现建议各补一个针对性回归测试（尤其 M1 的崩溃窗口可用「commit 后不调 resumeDue + 重开 kernel」直接复现）。*
