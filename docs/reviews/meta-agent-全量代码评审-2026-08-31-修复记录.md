# 2026-08-31 全量评审 — 修复记录

**基线**：`c9731b0` (v0.9.6) → 本次修复
**范围**：评审报告 [meta-agent-全量代码评审-2026-08-31.md](./meta-agent-全量代码评审-2026-08-31.md) 中的 15 项发现
**状态**：**15 项全部修复**
**验证**：`tsc --noEmit` 干净；`vitest run` 308 files / 3438 tests 全绿（修复前 303 / 3419，新增 5 个测试文件、19 个用例）

---

## 复核结论

15 项逐条回读源码复核，**全部成立**。其中 P1-3 在复核过程中修正了报告的处置建议（见下），其余与报告一致。

---

# P1

## P1-1 `AutoScheduler` 心跳未处理 rejection ✅

`src/core/auto/AutoScheduler.ts`

心跳改为显式处理 rejection，语义与 `GraphKernel.executeWithHeartbeat` 对齐：**明确的「不属于你」是权威判定，I/O 失败不是**。

- 新增 `HEARTBEAT_FAILURE_TOLERANCE = 3`：连续 3 次（90s）I/O 失败才放弃认领，单次锁超时不再丢弃在飞的一整个 turn
- 新增 `inFlight` 闸门，慢心跳不再自我堆叠
- `record.claim?.token` 缺失时不再静默 `return`，补 `onEvent` 说明该记录将等待租约超时回收

**附带发现**：报告只说了"会 unhandled rejection"，复核时确认了另一半——原实现即使加上 catch，如果直接 abort，一次锁竞争就会丢弃整段 agent 工作。所以容忍计数不是锦上添花，是这个修复的主体。

回归测试：`src/core/auto/__tests__/AutoSchedulerHeartbeatFailure.test.ts`（3 例）——拒绝不产生 unhandled rejection、瞬时失败不中断 turn、持续失败仍然放弃。

## P1-2 `no_progress` / phase-hook 中止留下悬空 `tool_use` ✅

`src/kernel/loop/KernelLoop.ts`、`src/core/SessionStore.ts`

产出端与消费端都修，缺一不可（历史数据已经在磁盘上）。

**产出端**：新增 `doneBeforeTools(reason, pendingAssistantMessages, note)`，在 `done()` 之前补齐 `buildMissingToolResultMessages`。五条 return 路径全部改走它：

| 位置 | 终止原因 |
|---|---|
| post_query phase hook | `phase_hook_abort` / `phase_hook_fail` |
| 重复工具请求 | `no_progress` |
| 轮询重复 | `no_progress` |
| ABAB 交替 | `no_progress` |
| pre_tool phase hook | `phase_hook_abort` / `phase_hook_fail` |

**消费端**：`normalizeResumedHistory` 增加 `repairDanglingToolUse`，在头部裁剪与摘要拼接**之后**执行（扫描的必须是真正上线的那份消息列表）。合成的是 `is_error: true` 的 `tool_result`——把从未执行的工具报成"成功且无输出"会教会模型这次调用生效了。

**采用补齐而非丢弃**：出问题的助手消息同时携带模型的推理文本，丢掉它等于静默删除 resume 本来要抢救的上下文。

回归测试：
- `src/kernel/__tests__/NoDanglingToolUse.test.ts`（4 例）——断言的是**不变量**（`finalMessages` 无未配对 `tool_use`）而非某个调用点，将来在 append 与 runTools 之间新增的退出路径会直接在这里失败
- `src/core/__tests__/ResumeDanglingToolUse.test.ts`（3 例）——存量损坏会话可恢复、多工具批次全覆盖、正常会话不被改动

## P1-3 `reconcile()` 用陈旧 `preMergeHead` 硬重置 ✅（处置方式较报告有修正）

`src/core/auto/AutoWorktreeCoordinator.ts`

`_rollbackMainTransaction` 新增 `crashRecovery` 模式，与事务内回滚彻底分开：

| | 事务内（`_finalizeUnlocked`） | 崩溃恢复（`reconcile`） |
|---|---|---|
| `reset --hard` | ✅ 总是 | 仅当 `HEAD === preMergeHead` |
| `clean -fd` | ✅ | ❌ 从不（未跟踪文件是用户的，不是本次 merge 的） |
| `stash apply` | ✅ | ✅（`--index` 失败时降级为普通 apply） |

**与报告建议的差异**：报告建议 HEAD 移动时**拒绝并报错**。复核时发现这会破坏一个合法场景——事务在提交 squash 之后、写记录之前崩溃，HEAD 合法地领先一个提交。而从 git 看，"我们刚提交的 merge" 与"用户崩溃后自己提交的" 完全无法区分。

最终采用：**HEAD 移动时不重置，但仍然完成事务剩余部分（恢复 stash）**。这在两种情况下都是对的——如果那个提交是我们的，说明 merge 其实成功了，本就该留在 HEAD；如果是用户的，那是唯一一份。无论哪种，用户的工作都不会丢，且事务以一致状态收尾而不是被弃置。

回归测试：`src/core/auto/__tests__/AutoWorktreeCoordinator.test.ts`
- 原有的 "recovers an interrupted merge transaction" 用例**原本编码的正是这个数据丢失行为**（它 `git commit` 之后期望 reconcile 重置回去），已按新契约更新
- 新增 "rolls back an interrupted merge that never committed"——HEAD 未动时仍然正常回滚
- 新增 "never destroys commits the user made after an interrupted merge"——用户崩溃后的 2 个提交 + 1 个未跟踪文件，启动会话后全部完好

---

# P2

## P2-1 intent 列举无界并发 + EMFILE 被静默吞成"不存在" ✅

`src/infra/persist/index.ts`、`GraphStore.ts`、`WakeStore.ts`、`AutoContinuationStore.ts`

**根因修在共享层**：`readJsonFile` 的 `tolerateUnreadable` 语义是"这条记录坏了，跳过"，而 EMFILE/ENFILE 不是记录的属性——它是进程的属性，会同时命中整批并发读，而且会自愈。现在这两个 errno **一律抛出**，不再被 tolerate。全部 20+ 个调用点同时受益。

**三处每 tick 热路径改为有界扇出**（`mapWithConcurrency` + `DEFAULT_READ_CONCURRENCY`），并对 rejected 结果**抛出而非跳过**：不完整的 prepared-intent 列表会静默停用崩溃恢复，返回一个看起来权威的部分集合比失败更糟。

- `GraphStore.listPreparedIntents`（每 tick）
- `WakeStore.listUnlocked`（每次调度轮询）
- `AutoContinuationStore.listUnlocked`（每次轮询 + 每次 hasLiveWork）

## P2-2 pending 外部事件永不回收 ✅

`GraphTypes.ts`、`CommitCoordinator.ts`、`GraphStore.ts`、`GraphKernel.ts`

- `GraphExternalEventRecord.status` 增加终态 `'expired'` + `expiredAt`
- 新增 journal 事件 `external_event_expired`（reducer / 投影修复 / checkpoint 保留三处同步）
- 新增 `CommitCoordinator.expireStaleExternalEvents(now)`，TTL 复用 7 天 webhook 重投递窗口
- `GraphKernel.tick` 在 `resumePendingExternalEvents` **之前**执行清扫——先退休再扫描，否则这一 tick 还是要为它们付钱
- checkpoint 保留规则去掉 `status === 'pending' ||` 的无条件豁免
- `recordExternalEvent` 对 `expired` 与 `consumed` 一样短路，重投递不会复活已退休的事件

**选择 journal 而非静默清扫**：「webhook 送到了但没人在听」是运维需要的诊断，不是噪声。

回归测试：`src/loop/graph/__tests__/ExternalEventExpiry.test.ts`（3 例）——过期退休、写入 journal、仍可匹配的事件绝不被误伤。

## P2-3 判官超时后不取消子代理 ✅

`src/core/auto/verify/VerifyJudge.ts`、`src/core/auto/learn/DriftAgent.ts`

轮询循环包 `try/finally`，非终态时 `dispatcher.cancelTask(...)`。

原注释说「Bounded so a stuck judge can't hang the gate forever」——闸门确实不再阻塞，但判官没停：它继续跑、继续花钱、继续占着 `internal: true` 的保留通道，而 KernelLoop 看到闸门"不可用"会重试，往同一条被占住的通道里再投一个。

顺带把 `new Promise(r => setTimeout(r, POLL_MS))` 换成可中止且 `unref` 的 `sleep(ms, signal)`。

## P2-4 每个 claim 各取一次全局事务锁做全量 snapshot ✅

`src/loop/graph/runtime/GraphKernel.ts`

`store.snapshot()` 提到 `Promise.allSettled(claims.map(...))` 外面。这些 activation 本就是同一个 `claimReady` 事务在同一份 State 下准入的，循环内取 N 次只是拿到 N 份相同视图，代价是 N 次全局锁获取 + N 次 journal 重放。

**这不只是浪费 I/O**：那把锁同时被 `commit()`（最长 30s）和每个 running activation 的心跳争用，冗余流量把心跳推向失败容忍上限，而心跳放弃会丢弃一整段已完成的 Agent 工作并消耗一次 attempt。

## P2-5 robotics 三个 pending 待审库无锁 + 静默持久化失败 ✅

新增 `src/robotics/pendingPersistence.ts`，三个 store 共用。

**两个缺陷写了三遍，现在只修一次**：

1. **无跨进程锁 + 盲目全量覆写** → `withFileLock` + 按 `pendingId` 读-合并-写
2. **静默失败**（写链两端各一个空 `.catch(() => {})`）→ 记录 `degradedReason` + 一次性 `console.warn`

**合并语义**：`keep = (磁盘上本进程从未见过的条目) ∪ (本进程当前队列)`。追踪"见过的 id"是删除能生效的前提——纯并集会把用户刚审核掉的条目全部复活，因为它们还在被合并的那个文件里。限制己方权威范围到确实加载或创建过的 id，既保住其他进程的并发提案，又让自己的删除生效。

**CLI 退出提示同步修正**（`src/cli/repl.ts`）：`N 条待审核 — 下次可以继续审核` 是一个承诺，只有在数据落盘时才成立。持久化降级时改为显示警告，而不是重复一句队列已经无法兑现的保证。

---

# P3

| 编号 | 修复 | 位置 |
|---|---|---|
| P3-1 | 新增 `encodeRecordId()`，对 `[A-Za-z0-9._-]` 之外的字符做百分号编码。可逆、单射（朴素替换会把不同 key 映射到同一文件，静默合并两个 commit intent）、对已有安全 id 是恒等（无需迁移） | `GraphStore.ts` |
| P3-2 | `isDeterministicGraphError` 递归 `AggregateError.errors` | `loop/runner.ts` |
| P3-3 | drift 闸门失败时把节流窗口**部分**归还（`DRIFT_GATE_RETRY_BATCHES = 5`）。原来消费整窗使得 `autoDriftFailureLimit` 实际需要 N×30 个 batch，止损几乎跑不到；全额归还又会让持续失败变成判官热循环 | `KernelLoop.ts` |
| P3-4 | abort 检查移到 verify/drift 重试循环体首（`skipped` 分支的 `continue` 原本会绕过它）；新增 `AUTO_GATE_RETRY_DELAY_MS = 2000` 退避 | `KernelLoop.ts` |
| P3-5 | `resumePausedTerminal` 的 `decideTransition` 加 try/catch，转成持久化 `failed`。原来插件抛错会逃出事务，实例卡在 paused 且每次 `loop resume` 重放同一个抛错——正是 `commit()` 注释里描述的失败模式 | `CommitCoordinator.ts` |
| P3-6 | 重写 `journalEntryExists` 注释。结论不变，但理由更新为"存在性探测不应依赖解析成功"（quarantine 已改 opt-in，原因果链失效） | `GraphStore.ts` |
| P3-7 | `filesystemSize` 改迭代 + 有界扇出 | `loop/cli.ts` |

回归测试：`src/loop/graph/__tests__/RecordIdEncoding.test.ts`（4 例）——含"单射性"用例，锁死朴素 sanitise 方案。

---

---

# 追加：实际使用中发现的问题（同日）

用户在一次 2 小时 auto 运行中遇到：任务正常推进（accept-cost 27828→65.9），到达墙钟上限后循环正确打印了
`Auto run reached its 7200000ms wall-clock limit. Progress was checkpointed; resume the session to continue.`，
紧接着 CLI 却打印：

```
✗  执行过程中发生错误。 请检查以下错误信息，调整指令后重试。
```

## 根因

`KernelSession.subtypeMap`（`kernel/KernelSession.ts:915-938`）把 **10 种** 终止原因压平成同一个
`error_during_execution`，而 `cli/stream.ts` 分支判断的是 **subtype**——尽管 `stopReason`
一路带着精确原因传到了 CLI（`core/types.ts:58`）。于是同一条横幅覆盖了：计划内挂起、用户 Ctrl+C、
无进展死循环、verify 未通过、闸门不可用、运行时错误。

三处同时出错：

1. **它不是错误**——运行到达配置上限并保存了工作
2. **建议的操作是错的**——"调整指令后重试"会丢弃一个存在意义就是 `--resume` 的检查点
3. **"请检查以下错误信息"指向不可能存在的信息**——`errors` 仅在循环**抛出**时填充，按原因终止时永远为空

附带两项：`isError` 为真触发 `analyzeAbnormalTermination`，即对计划内停止和用户主动中断**收费做 LLM 诊断**；
`terminationReasonLabel` 收到的是 subtype，所以诊断提示词里写的是
「可能是无进展死循环、verify 未通过、被外部依赖阻塞，或运行时错误」——让模型去猜一个运行时已经知道的事实。

## 修复

新增 `src/cli/termination.ts`，按 `stopReason` 分类（subtype 仅作旧生产者的回退）：

| 类别 | 原因 | 呈现 | 付费诊断 |
|---|---|---|---|
| `suspended` | `auto_runtime_limit`、`auto_tool_batch_limit` | ⏸ + **resume 命令** + 提高上限的环境变量 | 否 |
| `interrupted` | `aborted_streaming`、`aborted_tools` | ⏹ 已中断 | 否 |
| `limit` | `max_turns`、`max_budget_usd`、`max_output_tokens`、`blocking_limit` | 保留原有的按项建议 | 否 |
| `abnormal` | `no_progress`、`verify_exhausted`、闸门不可用、`phase_hook_fail`、`error` | ✗ + 精确原因 | **是** |

- `warrantsTerminationDiagnosis` 取代 `isError` 作为诊断门控
- `terminationLabel` 改吃 `stopReason`，诊断提示词拿到确定原因而不是四选一的猜测
- 无 `errors` 时不再声称"请检查以下错误信息"
- 新增 `infra/duration.ts`：`7200000ms` → `2h`（毫秒是机器单位，而读的人正在排查为什么停了）
- `resumeCommand()` 输出完整命令——原提示说"resume the session"却不给 session id，正确但不可用

**同时发现并修复一个更实质的缺口**：`autoMaxRuntimeMs` / `autoMaxToolBatches` 在 `KernelConfig` 里声明了，
但**全仓库没有任何调用方设置过**——没有 CLI flag、没有环境变量。也就是说这两个上限实际是不可达的常量，
用户被告知撞上了一个自己无法移动的墙。现补 `META_AGENT_AUTO_MAX_RUNTIME_MIN`（1–1440 分钟）与
`META_AGENT_AUTO_MAX_TOOL_BATCHES`（1–100000），显式 config 仍然优先。

回归测试：`src/cli/__tests__/TerminationClassification.test.ts`（15 例）——覆盖五个类别的映射、
subtype-only 回退、未知原因安全落到 `abnormal`、共享同一 subtype 的原因标签互不相同、时长格式化与 resume 命令。

---

## 未处理项（报告中的「观察」，非缺陷）

三条属于成本可预测性与长期运行退化的建议，需要独立设计决策，本次未动：

1. **`maxTurns` 不约束 API 调用次数** —— 各 `continue` 分支各自有界但相乘。建议加 `apiCallCount` 硬上限，让"最坏情况花多少钱"成为配置里能读出的数字。
2. **`heartbeat()` 走全量 `reconcileLocked()`** —— 租约续期是纯投影操作，可降到 O(1)。P2-4 已经缓解了竞争，但根因还在。
3. **`.loop/` 已完成实例不自动归档** —— `prepareAndClaim` 每 tick 遍历全部实例。建议 daemon 启动时自动归档超期终态实例。

---

## 结构性改动小结

本轮 15 项里有 6 项是"同一不变量在多处实现、漏了其中一处"。修复相应地把控制点向内收敛，而不是补第 N 个副本：

| 原分散点 | 收敛为 |
|---|---|
| 5 条退出路径各自记得补 `tool_result` | `doneBeforeTools()` 一个函数 + 一条不变量测试 |
| 3 个 pending store 各写一遍锁与合并 | `PendingSnapshotWriter` 一个类 |
| 20+ 处 `tolerateUnreadable` 各自误吞 EMFILE | `readJsonFile` 一处 errno 分流 |
| 2 个判官各自忘记 `cancelTask` | 两处 `finally`（仍是两份，但已被测试覆盖） |

`NoDanglingToolUse.test.ts` 断言的是性质而非调用点——这是报告结尾建议的第一条，也是这批问题最通用的解法：**让不变量由机器检查，而不是由后来人记得**。

---

*修复人：Claude · 2026-08-31 · 验证：tsc 干净 / 3438 tests 全绿*
