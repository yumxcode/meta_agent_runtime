# Meta-Agent Graph Loop 机制复审报告

日期：2026-07-21
范围：`src/loop/graph/runtime/**`（GraphKernel / CommitCoordinator / TransitionEngine / GraphStore / NodeExecutors / GraphExpression / LaneManager）、`src/loop/graph/spec/**`（GraphValidate / GraphLint / GraphTypes）、`src/loop/runner.ts`、`src/loop/daemon.ts`、`src/loop/wake/WakeStore.ts`，并对照 07-19 审核与 07-20 修复报告逐条验证。

## 一、总体结论

durable-graph-v2 的骨架是可靠的：journal 先行 + prepared intent + commitKey 幂等 + lease fencing + continuationVersion 的 commit 协议闭合，07-20 报告声称的高优先级修复经逐条源码核对基本全部真实落地。串行有界循环、条件收敛循环、Agent 分段长任务（hard park + resume context）、定时/轮询、外部事件、人工介入（paused terminal）这些场景可以认为达到生产可用。

但"通用、可靠、稳定"三个词还不能全部画勾。本轮复审发现一个**新的 Join 活性缺口**（M1 的修复没有覆盖全部窗口，且不需要崩溃即可触发）、一个**runner 失败升级策略**问题（瞬态基础设施错误可把长周期 loop 不可逆杀死），以及若干应明确写为"边界"的通用性限制。fan-out/join 场景在修复第一个问题之前，必须依赖 `timeoutMs`/`maxWallTimeMs` 兜底才敢用。

## 二、07-20 修复的逐条验证结果

以下各项均在当前源码中确认已实现，非仅报告声称：

| 声称的修复 | 验证位置 | 结论 |
|---|---|---|
| serializable 在 commit 文件锁事务内校验 expected State version，冲突同事务释放 replay；Agent replay 上限 5、普通 50 | `CommitCoordinator.commit` L62-107 | ✓ 属实；无 update 的 transition 也确认不再递增 State version（`TransitionEngine` L61-68） |
| Terminal 稳定保守仲裁 failed → paused → done，同级按 nodeId/transitionId/语义 input 排序 | `GraphStore.compareTerminalActivation`；`claimReady` 的 Terminal 全图屏障 | ✓ 属实 |
| 终态/暂停 fencing：旧 activation 不能覆盖 done/failed/paused；heartbeat 发现 fencing 后中止 Agent 段 | `commit` L58-60 拒绝；`setStatus` 对 done/failed 单调；`heartbeat` 在非 active 返回 false → abort | ✓ 属实 |
| Join `expects` 必须与真实入边一致（双向） | `GraphValidate` L158-170：expects ⊆ incoming 且 incoming ⊆ expects | ✓ 属实 |
| Join 复用 `NodeBase.timeoutMs`，超时按 `timeout` outcome 路由 | `executeJoin` 的 `__joinDeadline` 固定 deadline + `requiredOutcomes` | ✓ 属实 |
| 纯事件等待获得独立 wall-deadline wake | `runner.prepareAndClaim` 的 `__graph_deadline__`；且崩溃后可从 waiting activation 的 wakeAt 重建 timer wake | ✓ 属实 |
| timer continuation 注入紧凑 resume context | `NodeExecutors` L99-105（reason/checkpoint/signal） | ✓ 属实（07-19 的 L4 已修） |
| Host graph-tick admission 按 TTL 续租 | `runner.runClaimedWake` L120-134 | ✓ 属实 |
| transition evaluation 抛错转持久 failed commit + 30s 超时，防 prepared intent 中毒 | `CommitCoordinator.commit` L144-191 | ✓ 属实 |
| 删除 `$event/$effect` 虚假表达式根 | `GraphValidate` 的 `ROOT_RE` 仅 state/input/output/clock | ✓ 属实 |
| 外部事件大小/格式/delivery 幂等/timeout-first-wins | `validateExternalEventInput`（1MB 上限）、`createdAt < wakeAt` 裁决 | ✓ 属实 |
| 严格 `$output` 绑定必须由源 outputSchema.required 保证；failure/always 边只能传整 `$output` 或 literal | `validateStrictOutputBinding` | ✓ 属实（07-19 的 L6 也一并覆盖：closed schema 的 `when` 引用拼写可静态检出） |
| `$input` 严格引用的静态供给校验 | `validateInputSupply`（每条入边和 entrypoint 必须绑定） | ✓ 属实，这条做得比报告描述更完整 |
| flatten 跳过含 `.` 的键（L5） | `GraphExpression.flattenPrimitives` | ✓ 属实 |

## 三、新发现的问题

### H1. Join 唤醒信号仍有丢失窗口——且不需要崩溃即可触发（高，活性）

07-20 对 M1 的修复是：`recoverPrepared` 恢复 prepared commit 时补发 Join resume 信号（`GraphKernel.tick` L115-121）。这只覆盖"prepare 之后、commit 事务完成之前"崩溃的窗口。**commit 事务完成之后、`resumeDue` 补发信号之前**的窗口没有覆盖：此时 intent 已在事务内被标为 `committed`，重启后 `listPreparedIntents` 不再返回它，信号永远不会补发。

更重要的是，这个丢失不需要进程崩溃。`finishActivation` 中 commit 与 `resumeDue` 是**两个独立事务**（L383 与 L393-396）：commit 成功后，`resumeDue` 若因文件锁竞争超时（`withFileLock` 60s）抛错，异常沿 `Promise.allSettled` 上抛为 kernel failure，wake 会重试 tick——但重试的 tick 里 `recoverPrepared` 找不到任何 prepared intent，信号已永久丢失。tick 恢复段（L118-121）的 `resumeDue` 同样存在这个问题。

丢失后的故障序列：最后一个 Join 成员 A 以 ready 状态存在 → 下一 tick 被 claim 执行 `executeJoin` → barrier 完备，但按 id 排序的 leader 恰是先前已 park 的成员 B（`act-<uuid>` 随机，约 50% 概率）→ A 也 park。此后全部成员 waiting、无 wakeAt，实例转 waiting，而 `claimReady` 对非 active 实例直接返回空——**永久卡死**。仅 join `timeoutMs`、`maxWallTimeMs`，或运维手工投递内部事件 `join:<node>`（还需知道 forkGroupId）可解。

建议（二选一，都做更稳，各约 10-15 行）：

1. **确定性 Join 对账**：每个 tick 在 `resumeDue(now)` 附近增加一步——对所有 waiting 且节点类型为 join 的 activation 重算 barrier 完备性（与 `executeJoin` 同一判据），完备即 resume。幂等、确定、无轮询开销，从根上消除对"信号恰好送达"的依赖。
2. Join 的非 leader/未完备 park 一律附带轮询 wakeAt（如 now+30s），与 Effect 轮询同款自愈模式。

修复后建议补一个回归测试：commit 完成后跳过 resumeDue（或注入 resumeDue 抛错），重开 kernel 连续 tick，断言实例仍能到达 done。

### H2. runner 把连续 5 次"未知错误"升级为不可逆 failed（中，稳定性策略）

`runClaimedWake` 的错误分类是正则白名单（`isDeterministicGraphError`）：白名单内视为确定性错误立即 fail，白名单外重试 `MAX_WAKE_ATTEMPTS = 5` 次后 `setStatus('failed')`。两个方向都有问题：

其一，瞬态基础设施错误不在白名单——锁竞争（"activation lease lost"、"withFileLock: timed out"）、磁盘瞬时 EIO/ENOSPC 等——连续 5 次后实例被置为 failed，而 failed 是**单调终态，不可恢复**（`setStatus` 对 done/failed 早退）。一个设计为跑数周的 loop 可能因一段几分钟的基础设施抖动被永久杀死。目前部分场景被"setStatus 同样拿不到锁而静默失败、daemon 重新调度"侥幸缓解（07-19 的 L7 描述的机制，仍属侥幸闭环）；一旦 setStatus 恰好成功，误杀就落地。

其二，反方向同样脆弱：内核新增确定性错误若忘记登记正则，会被当作瞬态无限重试（daemon 每次 prepareAndClaim 对 active 实例重建 `__graph__` wake，attempts 归零），实例在错误上空转烧 tick。

建议：把"未知错误耗尽重试"的最终 fallback 从 `failed` 改为 **`paused`**（statusReason 记录原始错误），保留运维 resume 的路径——这与现有 pause 语义（running 无损释放为 replay、wake 取消、resume 后恢复）完全兼容；`failed` 只留给白名单内的确定性错误。同时把 lease-lost / lock-timeout 明确归类为不消耗 wake attempts 的瞬态错误。

## 四、通用性边界（应写入文档/lint，而非修代码）

这些不是缺陷，是当前设计的明确取舍；"loop 场景通用"的承诺应当以文档和 lint 把边界讲清楚：

1. **动态 fan-out 不可表达**。`transition.to` 的目标列表在 Freeze 时静态固定，"运行期对 N 个未知条目并行处理"无法用图表达——只能串行循环（state 索引）或交给厚 Agent 在单 Activation 内自行并行。这与"Graph 只表达 Kernel 必须确定执行的事实"的哲学一致，但属于用户最可能撞到的第一个边界。
2. **同 Lane 严格串行**。`maxConcurrency` 校验强制为 1，Lane 独占由 `claimReady` 的 runningLanes 实现；并行迭代必须拆 Lane，而 workspace 写路径又是单 Lane 所有——并行度受工作区所有权拓扑约束。
3. **无绝对日历/cron**。刻意不做；"计算下一次延迟 + hard park"覆盖多数场景。真实跨时区日历需求出现时按 07-20 的结论加一个小型 `wait.at` 持久能力即可，不要提前做。
4. **Join 的语义死路仍然只有运行时兜底**。某个 expects 分支走 failure 路由且不再回到 join 时，静态校验无法发现（这是语义问题）。在 H1 修复之前，实践守则应当是：**凡使用 join 的图必须同时设置 join `timeoutMs` 和图级 `maxWallTimeMs`**。GraphLint 可以加一条 warning：join 无 timeoutMs 时提示。
5. **`any` join 完成后兄弟分支不取消**，继续消耗预算直到其 join spawn 被去重丢弃。若这是有意的（分支可能有副作用要完成），文档应写明；若无意，可在 join commit 的 cancelled 集合中纳入同 forkGroup 的未完成分支。

## 五、其他小项

- `ActivationRecord.replayCount` 注释仍称 lease loss 是 "non-attempt-consuming replay"，但 `releaseExpiredClaims` 将过期租约标记 `readyReason: 'retry'`，下次 claim 消耗 attempt。07-19 的 L2 记录过，注释至今未改。代码方向是对的（防崩溃-重启无限烧钱），改注释即可。
- 事件等待的 `correlation` 在"park 提交前 lease 过期重放"时会按新 State 重算，可能与首次不同。窗口极小，记录备查即可。
- Join 成员的 `input` 中的内部键（`__resume`、`__timerDeadline` 等）会随 join 输出进入 `$output`，对下游可见。轻微命名空间泄漏，可在 `executeJoin` 组装输出时过滤 `__` 前缀键。
- journal 与外部事件 inbox 仍无修剪/归档（checkpoint 每 50 事件，但旧 journal 文件与永不匹配的 pending 事件永久保留）。07-20 已列为后续项，确认未做；对月级长周期实例是线性磁盘增长，建议排入 `loop gc`。

## 六、结论

| 维度 | 评分（满分 5） | 一句话 |
|---|---|---|
| loop 场景通用 | 4.5 | 八类场景覆盖扎实；动态并行与日历是明确边界，应文档化而非扩 DSL |
| 可靠（正确性） | 4 | commit/fencing/仲裁/校验经复核全部成立；唯一实质缺口是 H1 的 Join 唤醒丢失 |
| 稳定（长期运行） | 4 | 崩溃恢复协议严密；H2 的不可逆误杀策略与存储无修剪是长周期实例的两个真实风险 |

判断：**串行循环、定时/事件驱动、Agent 分段、人工介入场景可以放心用；fan-out/join 在 H1 修复前必须带 timeoutMs + maxWallTimeMs 双保险**。H1（约 15 行 + 一个回归测试）和 H2（fallback 改 paused）都是小改动，建议本周期内完成，之后"可靠、稳定"两项可以画勾。

---

*复审基于 2026-07-21 工作区快照；行号以当日文件为准。本轮为纯源码精读复审，未在审阅环境运行测试套件（07-20 报告记录全量 1130 项通过）；H1 的复现路径已在源码层面逐步核对，建议按文中方案构造回归测试确认。*
