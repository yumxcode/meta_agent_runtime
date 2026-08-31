# meta-agent-runtime 全量代码评审 — 2026-08-31

**基线**：`c9731b0` · v0.9.6
**范围**：`cli` / `agentic`(kernel + modes + routing) / `robotics` / `auto` / `simple_auto` / `loop`
**排除**：`campaign`(开发中)、`campaigns`、`evolution`、`reviewer`、`evaluation`
**基线健康度**：`tsc --noEmit` 干净；`vitest run` 303 files / 3419 tests 全绿（78.8s）

维度：正确性与并发 · 安全与沙箱 · 架构与可维护性 · 性能与 token 成本

---

## 总体判断

这份代码库的持久化内核（journal + 租约 + 两代 checkpoint + 跨进程文件锁）在同类项目里属于少见的扎实。`withFileLock` 的 M1–M4 与 B4 修复链、`GraphStore.txScope` 用 `AsyncLocalStorage` 区分「并行事务」与「重入死锁」、`readJsonFile` 把 ENOENT 与其他 errno 分开处理 —— 这些都不是照抄模板能写出来的，是真正踩过坑之后的收敛。注释保留因果（"为什么改成这样"而不只是"这里做什么"）这一点，对后续交接的价值超过大多数架构文档。

**本轮 15 项发现里，没有一项属于"缺少控制"，全部属于同一类问题：一个控制在 A 路径上做对了，在结构对等的 B 路径上漏了。**

- `AttachedAutoScheduler` 的心跳有 rejection handler，`AutoScheduler` 的没有（P1-1）
- 流式中断路径补齐了 `tool_result`，`no_progress` 和 phase-hook 中止路径没补（P1-2）
- `PhysicalAnchorStore` / `PrincipleStore` 用了文件锁，三个 pending 待审库没用（P2-5）
- `commit()` 把 `decideTransition` 的抛错转成持久化失败，`resumePausedTerminal()` 没转（P3-5）
- `loop/runner.ts` 的两个心跳都有 `.catch()`，`AutoScheduler` 的没有（P1-1）

这说明缺的不是设计意识，而是**"同一个不变量在多少处被实现"这件事本身没有被机器检查**。2026-08-14 那轮评审的 P0-2 已经识别过完全同构的问题（安全控制以工具名硬编码而非以声明为准），并用 `commandField` 声明把它收敛掉了。本轮建议把同样的手法用在生命周期上（详见文末「结构性建议」）。

三条 P1 都能在真实使用中被触发，其中 P1-3 会造成用户工作成果丢失。

---

## 严重程度分布

| 级别 | 数量 | 说明 |
|---|---|---|
| P1 | 3 | 无人值守进程自毁、`--resume` 必然失败、主工作区数据丢失 |
| P2 | 5 | 静默正确性洞、无界资源增长、子代理泄漏、锁竞争放大 |
| P3 | 7 | 跨平台、错误分类、节流窗口、过时注释 |
| 观察 | 3 | 成本可预测性与长期运行退化，非缺陷 |

---

# P1 — 严重

## P1-1 `AutoScheduler` 心跳未处理 rejection，会把无人值守进程打死

**位置**：`src/core/auto/AutoScheduler.ts:237-241`

```ts
const heartbeat = setInterval(() => {
  void this.store.heartbeat(record.wakeId, token).then(owned => {
    if (!owned) controller.abort('auto continuation claim lost')
  })
}, 30_000)
```

没有 `.catch()`，也没有 `then` 的第二个参数。而 `AutoContinuationStore.heartbeat`（`AutoContinuationStore.ts:293-308`）是能拒绝的：

- `withFileLock(this.lockPath(), …)` 默认 `timeoutMs = 10_000`，超时抛 `withFileLock: timed out after 10000ms waiting for …`
- 内部 `readJsonFile` 在非 ENOENT 错误（EACCES / EIO / EMFILE）时按设计**抛出**而不返回 null

于是一次瞬时 I/O 抖动 → unhandled rejection → `cli/repl.ts:1312`：

```ts
process.once('unhandledRejection', (e) => { void disposeAndExit(1, e) })
```

**整个 CLI 退出，正在跑的 auto 会话被 `disposeAndExit(1)` 终止。**

### 为什么这是遗漏而不是设计

三处结构对等的代码都做对了：

| 位置 | 处理方式 |
|---|---|
| `AttachedAutoScheduler.ts:92-104` | `.then(onFulfilled, onRejected)` — 拒绝时 `claimLost = true` + abort |
| `loop/runner.ts:109` | `.catch(() => undefined)` |
| `loop/runner.ts:127-130` | `.catch()` + 连续失败计数，≥3 次才判定租约丢失 |
| `GraphKernel.ts:523-531` | `.catch()` + `HEARTBEAT_FAILURE_TOLERANCE = 3` |

而 `AutoScheduler.ts:130-132` 自己的注释就写着「the CLI treats unhandledRejection as fatal」—— 作者在**相邻 100 行内**已经为 `runClaim` 的返回 promise 做了这件事，唯独漏了定时器里的这一个。

### 触发概率不低

`dispatchDue` 每 `pollIntervalMs`（默认 1s）调一次 `store.reconcileOrphans()` + `store.claimDue()`，两者都取**同一把** `this.lockPath()` 锁。`maxConcurrent > 1` 时每个在飞 claim 还各有一个 30s 心跳抢同一把锁。锁的默认等待窗口只有 10s。在慢盘、网络盘或 claim 数较多时，心跳超时是可预期事件，不是极端场景。

### 修复

对齐 `GraphKernel.executeWithHeartbeat` 的容忍语义 —— **明确的"不属于你"是权威判定，I/O 失败不是**：

```ts
let consecutiveFailures = 0
const heartbeat = setInterval(() => {
  void this.store.heartbeat(record.wakeId, token).then(
    owned => {
      if (!owned) controller.abort('auto continuation claim lost')
      else consecutiveFailures = 0
    },
    error => {
      if (++consecutiveFailures >= 3) {
        controller.abort(`auto continuation heartbeat failed: ${error}`)
      }
    },
  )
}, 30_000)
```

顺带：`runClaim` 开头 `const token = record.claim?.token; if (!token) return`（232-233 行）会让记录停在 `claimed` 直到 `reconcileOrphans` 超时回收，且不发任何事件。建议至少 `onEvent` 一条，否则这是一个完全静默的丢弃。

---

## P1-2 `no_progress` 与 phase-hook 中止会在历史里留下无配对的 `tool_use`，`--resume` 必然 400

**位置**：`src/kernel/loop/KernelLoop.ts`

主循环在 1377 行提交助手消息（含 `tool_use` 块）：

```ts
append(...assistantMessages)          // 1377
```

`append()`（819-828 行）会同步调用 `ctx.onMessagesAppended`，而 `KernelSession.ts:398-405` 把它直接 `record()` 落盘。**消息在这一刻就已经进了持久化历史。**

随后有五条 return 路径在 `runTools` 之前退出，全都没有补 `tool_result`：

| 行号 | 终止原因 |
|---|---|
| 1386 | `post_query` phase hook 请求中止 |
| 1635 | `no_progress`（重复同一工具请求 ≥ `NO_PROGRESS_REPEAT_LIMIT`）|
| 1641 | `no_progress`（轮询重复 ≥ `NO_PROGRESS_POLLING_LIMIT`）|
| 1652 | `no_progress`（ABAB 交替）|
| 1691 | `pre_tool` phase hook 请求中止 |

对比 1311-1313 行的流式中断路径 —— 它**做对了**：

```ts
if (signal.aborted) {
  const missingResults = buildMissingToolResultMessages(assistantMessages, 'Interrupted by user')
  append(...assistantMessages, ...missingResults)
```

`buildMissingToolResultMessages`（`ToolOrchestration.ts:238-253`）在全仓库只有这一个调用点。

### 恢复路径没有兜底

- `MessageNormalizer.normalizeMessagesForAPI`（33-69 行）只做过滤与同角色合并，不校验 `tool_use` / `tool_result` 配对
- `SessionStore.trimToSafeResumeBoundary`（415-428 行）只从**头部**裁剪孤儿 `tool_result`（截断窗口造成的），不处理**尾部**悬空的 `tool_use`

于是 `--resume` 后第一次请求的消息序列是 `… assistant(tool_use) → user(新提示词)`，Anthropic 与兼容端点都会以 400 拒绝（`tool_use` 块后必须紧跟 `tool_result`）。**会话再也起不来了。**

### 触发极其容易

```ts
const NO_PROGRESS_REPEAT_LIMIT = 3        // KernelLoop.ts:553
```

模型连着三轮发出完全相同的工具调用就会命中。这在长任务里是常见现象，不是边缘情况。

### 修复

两处，缺一不可：

1. **产出端**——把这五条 return 统一走一个 helper：

```ts
function stopBeforeTools(reason: LoopTerminationReason): LoopResult {
  append(...buildMissingToolResultMessages(assistantMessages, resultText))
  return done(reason)
}
```

2. **消费端**——`normalizeResumedHistory`（`SessionStore.ts:435-453`）加尾部兜底：末条助手消息若有 `tool_use` 无对应 `tool_result`，补一条合成的错误 `tool_result`（而不是丢弃该消息 —— 丢弃会连带丢掉模型的推理文本）。历史数据已经落盘，只修产出端救不了存量会话。

建议同时补一条不变量测试：**任何 `LoopResult.finalMessages` 都不含无配对的 `tool_use`**，用它锁住全部现有和未来的终止路径。这正是本轮多数问题的通用解法。

---

## P1-3 `AutoWorktreeCoordinator.reconcile()` 会用陈旧的 `preMergeHead` 对用户主工作区 `reset --hard`

**位置**：`src/core/auto/AutoWorktreeCoordinator.ts:558-566` → `638-653`

```ts
for (const record of [...this.records.values()]) {
  if (record.phase === 'merging' && record.preMergeHead) {
    const rollbackError = await this._rollbackMainTransaction(
      record.preMergeHead, record.stashCommit,
    )
```

```ts
private async _rollbackMainTransaction(preMergeHead: string, stashCommit?: string) {
  await this._git(['merge', '--abort']).catch(() => undefined)
  await this._git(['reset', '--hard', preMergeHead])
  await this._git(['clean', '-fd', '--', '.', ':(exclude).meta-agent/**', ':(exclude).loop/**'])
```

而 `routing/AgenticBackendFactory.ts:301` 在**每次 agentic / auto 后端构建时无条件执行**：

```ts
if (worktrees.enabled) {
  await worktrees.reconcile()
```

### 事故序列

1. auto 会话合并子代理分支，`_updateRecord(record, { phase: 'merging', preMergeHead })` 先落盘（356-361 行），之后才开始 merge
2. 进程在 merge 中途崩溃 / 被 kill / 机器掉电 → 记录永久停在 `phase: 'merging'`
3. 用户回到项目，手工解决冲突、继续开发、提交若干次
4. 用户下次跑 `meta-agent`（**任何** agentic 或 auto 会话）
5. `reconcile()` 执行 `git reset --hard <崩溃前的 HEAD>` + `git clean -fd`

**第 3 步的所有提交与未跟踪文件被静默丢弃。**

### 正常路径是安全的，崩溃后的路径不是

正常事务确实做了保护 —— 365-380 行在 merge 前 `git stash push --include-untracked`，回滚时 `stash apply --index` 还原。这个设计是对的。

但保护的**时间窗只覆盖到崩溃那一刻**。第 3 步产生的工作不在任何 stash 里，回滚时也没有任何检查确认 HEAD 是否还停在事务开始时的位置。代码把「崩溃前记录的 preMergeHead」当成了「当前仍然有效的回滚点」，这两件事在跨越一次进程重启后不再等价。

`clean -fd` 不带 `-x`，所以 `.gitignore` 覆盖的文件（构建产物、`.env`）能活下来；被删的是**未跟踪且未忽略**的文件 —— 也就是用户刚写还没 `git add` 的新文件，恰好是最没有副本的那一类。

### 修复

回滚前必须验证回滚点仍然成立，不成立就拒绝自动处理：

```ts
const head = await this._git(['rev-parse', 'HEAD'])
const stillAtTransaction =
  head === record.preMergeHead ||
  await this._gitExitZero(this.projectDir, ['merge-base', '--is-ancestor', head, record.preMergeHead])

if (!stillAtTransaction) {
  // HEAD 已经前进到事务之外 —— 有人在崩溃后继续工作过。
  // 自动回滚会丢掉那些工作，交给人。
  await this._updateRecord(record, {
    phase: 'conflicted',
    preMergeHead: undefined,
    error: `HEAD moved to ${head} after the interrupted merge; refusing to reset --hard. `
         + `Resolve manually, then run: meta-agent worktree clear ${record.taskId}`,
  })
  continue
}
```

`clean -fd` 也建议在崩溃恢复路径上整体去掉 —— 事务内回滚时它是必要的（清掉 merge 自己产生的文件），跨重启回滚时它只会删用户的东西。

另有一处相邻风险，同一函数域：614-625 行的孤儿清扫按 `readdirSync(this.worktreeBase)` 对**不在 `this.records` 里**的每个目录执行 `worktree remove --force` → `rmSync(recursive, force)` → `branch -D sub/<entry>/code`。若 `this.records` 只是本进程视图而非跨进程持久化并集，两个并发 CLI 实例会互删对方正在使用的 worktree。`_exclusive` + `_requireRegistryPersist` 看起来是为此准备的，建议补一条并发测试显式锁定这个不变量。

---

# P2 — 高

## P2-1 `listPreparedIntents()` 每 tick 无界并发打开全部 intent 文件，且 EMFILE 被静默吞成"文件不存在"

**位置**：`src/loop/graph/runtime/GraphStore.ts:474-480`

```ts
async listPreparedIntents(): Promise<ActivationCommitIntent[]> {
  const ids = await listJsonIds(this.paths.intentsDir)
  const intents = await Promise.all(ids.map(id =>
    readJsonFile<ActivationCommitIntent>(join(this.paths.intentsDir, `${id}.json`),
      { tolerateUnreadable: true })))
```

`CommitCoordinator.recoverPrepared()` 在 `GraphKernel.tick()` 的第一步（120 行）就调用它，也就是**每 tick 一次**。

### 积压是必然的

- `INTENT_RETENTION_MS = 7 * 24 * 60 * 60_000`（7 天）
- `pruneSettledIntentsLocked` 节流到每 `HOUSEKEEPING_INTERVAL_MS = 10min` 一次，每次只检查 `HOUSEKEEPING_BATCH = 500` 条

活跃实例累积数千个 intent 文件是常态。`Promise.all` 会**同时**发起数千个 `open()`。

### 更严重的是正确性，不只是性能

`tolerateUnreadable: true` 的语义（见 `infra/persist/index.ts` readJsonFile 的 B1 注释）是"枚举时跳过读不了的条目"。但它对 **EMFILE / ENFILE 一视同仁**：

```
fd 耗尽 → readJsonFile 返回 null → filter 掉 → recoverPrepared 认为没有待恢复 intent
```

**已经 prepare 但尚未 commit 的 activation 永远不会被恢复。** 这不是一条日志噪声 —— 这是崩溃恢复协议在压力下静默失效，而压力（fd 耗尽）恰恰是崩溃恢复最可能被需要的时刻。

而且这是自激的：intent 越多 → 并发越高 → 越容易 EMFILE → 恢复失败 → intent 继续堆积。

### 修复

同一文件里已经有现成的工具（`infra/persist/index.ts` 的 `mapWithConcurrency`，注释里 P2-4 记录的正是 job/session store 的同类问题）：

```ts
const results = await mapWithConcurrency(ids, DEFAULT_READ_CONCURRENCY, id =>
  readJsonFile<ActivationCommitIntent>(join(this.paths.intentsDir, `${id}.json`)))
```

并且**不要 tolerate EMFILE**。建议给 `readJsonFile` 增加一档区分：损坏（跳过）vs 资源耗尽（重试或抛出）。把两者归为同一个 `tolerateUnreadable`，等于用"容错"掩盖了"过载"。

同一文件 `WakeStore.ts:156`、`AutoContinuationStore.ts:525` 是同构写法，一并处理。

---

## P2-2 pending 外部事件永不回收，tick 成本随时间单调上升

**位置**：`GraphStore.ts:1051-1053`，`CommitCoordinator.ts:836-845`

checkpoint 的保留规则对 `pending` 状态**没有到期条件**：

```ts
const externalEvents = [...snapshot.externalEvents.values()]
  .filter(event => event.status === 'pending' ||
    now - (event.consumedAt ?? event.createdAt) < EXTERNAL_EVENT_RETENTION_MS)
```

而事件匹配要求 `event.createdAt < activation.wakeAt`：

```ts
function matchingEventActivations(activations, event) {
  return [...activations].filter(activation =>
    activation.status === 'waiting' &&
    activation.event?.name === event.name &&
    structurallyEqual(activation.event.correlation, event.correlation) &&
    (activation.wakeAt === undefined || event.createdAt < activation.wakeAt))
}
```

**迟到于 wait 截止时间的事件永远匹配不上，却永远保持 pending。** 同理，correlation 打错、或对应 activation 已被取消的事件也一样。

`resumePendingExternalEvents()` 在每 tick 被调用两次（`GraphKernel.tick` 的 153 行和 238 行），每次全量扫描所有 pending 事件，并对每个候选做 `structurallyEqual` → `canonicalJson` 递归比对。单条 payload 上限 1 MB、深度上限 64（`CommitCoordinator.ts:772-775`），乘以永久累积的条数。

长跑实例的 tick 成本因此单调上升，且这条增长不在任何 housekeeping 预算内。

### 修复

给 pending 事件加 TTL，复用现有常量即可：

```ts
const expiry = now - EXTERNAL_EVENT_RETENTION_MS
const externalEvents = [...snapshot.externalEvents.values()].filter(event =>
  event.status === 'pending'
    ? event.createdAt >= expiry
    : now - (event.consumedAt ?? event.createdAt) < EXTERNAL_EVENT_RETENTION_MS)
```

更彻底的做法是在 tick 里把过期 pending 显式转成 `status: 'expired'` 并写一条 journal 事件 —— 这样"事件送到了但没人接"在审计轨迹里是可见的，而不是悄悄消失。webhook 场景下这个可见性很重要。

---

## P2-3 verify / drift 判官超时后不取消子代理，独占 internal 保留通道

**位置**：`core/auto/verify/VerifyJudge.ts:296-305`、`core/auto/learn/DriftAgent.ts:231-240`

```ts
const MAX_WAIT_MS = limits.maxDurationMs + 60_000
const deadline = Date.now() + MAX_WAIT_MS
while (!TERMINAL_STATUSES.has(status)) {
  if (signal.aborted || Date.now() > deadline) break     // 只是 break
  await new Promise(r => setTimeout(r, POLL_MS))
  const polled = await deps.dispatcher.getStatus(rec.taskId)
  …
}
if (latest.status !== 'completed') return undefined      // 判官仍在跑
```

`deadline` 到达后只是停止轮询。`SubAgentBridge.cancelTask`（887 行）存在，但从未在这两处被调用。

`abortSignal: signal` 覆盖了**父级中止**的情况（`SubAgentBridge.ts:745` "If parent is aborted, cancel this sub-agent"），但覆盖不了**本地 deadline 到期**这条路径。

### 为什么正常情况下不出事，出事时正好最糟

子代理自身配了 `maxDurationMs: limits.maxDurationMs`，而 `MAX_WAIT_MS = maxDurationMs + 60_000`。正常情况下 runner 的墙钟上限会先触发，早 60s 结束。

问题恰恰在于：**这条 deadline 存在的唯一理由，就是防备 runner 自己的上限没生效。** 而在那个情况下，代码放弃了等待却没有回收资源。注释写的是「Bounded so a stuck judge can't hang the gate forever」—— 闸门确实不再阻塞了，但判官没停。

叠加放大：`config.internal = true` 表示这是**预留的专用侧通道**（注释：「the completion gate must never be starved by research/worker sub-agents」）。而 `KernelLoop.ts:1519` 会按 `autoGateMaxAttempts`（默认 2）重试闸门，往一条已被卡死判官占住的通道再投一个判官。`MAX_VERIFY_ROUNDS` 轮下来可以堆出多个泄漏的判官，每个都在烧预算。

### 修复

```ts
} finally {
  if (!TERMINAL_STATUSES.has(latest.status)) {
    await deps.dispatcher.cancelTask(rec.taskId, 'verify gate deadline exceeded')
      .catch(() => undefined)
  }
}
```

另外 `await new Promise(r => setTimeout(r, POLL_MS))` 没有 `unref()`，也不感知 signal，中止时最多多等 500ms。同文件已有的可中止延时模式（`AutoScheduler.abortableDelay`）可以直接复用。

---

## P2-4 `GraphKernel.tick` 为每个 claim 各取一次全局事务锁做全量 snapshot

**位置**：`src/loop/graph/runtime/GraphKernel.ts:181-185`

```ts
const results = await Promise.allSettled(claims.map(async activation => {
  const live = await this.options.store.snapshot()      // ← 每个 claim 一次
  let result: NodeExecutionResult
  try {
    result = await this.executeWithHeartbeat(activation, signal =>
      this.executor.execute(activation, live, signal))
```

`snapshot()` = `withTransaction`（抢全局文件锁）+ `reconcileLocked`（读 journal 尾、重放事件、每 50 条写 checkpoint）。

`maxActivations = N` 时每 tick 多出 N 次锁获取 + N 次全量重建，而这 N 次拿到的**本来就是同一份状态** —— 这些 claim 是同一 tick、同一 `claimReady` 事务里派发的。

### 竞争放大

同一把锁上还有：

- `commit()` 在锁内跑 `decideTransition`，超时 `TRANSITION_EVALUATION_TIMEOUT_MS = 30_000`
- 每个 running activation 每 `DEFAULT_ACTIVATION_HEARTBEAT_MS = 10_000` 一次 `store.heartbeat()`
- 锁等待窗口 `timeoutMs: 60_000`

一个跑满 30s 的 transition 会让这一波所有 snapshot 和心跳排队。心跳虽有 `HEARTBEAT_FAILURE_TOLERANCE = 3` 兜底，但连续 3 次 60s 超时后 activation 会被判定租约丢失，整段 agent 工作被丢弃并重放 —— 纯粹因为锁竞争。

`releaseExpiredClaims` 还会把租约过期的 activation 标成 `readyReason: 'retry'`，而 `claimReady` 对非 `continuation` / `replay` 的 readyReason 会 `attempt + 1`（`GraphStore.ts:398-400`）—— 基础设施抖动因此消耗业务重试次数。

### 修复

把 snapshot 提到 `map` 外面，语义等价：

```ts
const live = await this.options.store.snapshot()
const results = await Promise.allSettled(claims.map(async activation => {
  …this.executor.execute(activation, live, signal)
```

配套建议（见文末观察三）：`heartbeat()` 目前也走 `reconcileLocked()` 全量重建，但租约续期是纯投影操作，不需要权威快照。

---

## P2-5 robotics 三个 pending 待审库无跨进程锁，并发提案静默丢失

**位置**：
- `robotics/ExperiencePendingStore.ts`
- `robotics/PhysicalAnchorPendingStore.ts`
- `robotics/PrinciplePendingStore.ts`

三者都持有内存数组，用 `atomicWriteJson` 全量快照覆写，**没有 `withFileLock`**：

```ts
private async _persist(snapshot: PendingExperience[]): Promise<void> {
  if (!this._filePath) return
  if (snapshot.length === 0) { await rm(this._filePath, { force: true }).catch(() => undefined); return }
  await atomicWriteJson(this._filePath, snapshot)
}
```

对照同目录下的正式库：

| 文件 | withFileLock | atomicWriteJson |
|---|---|---|
| `PhysicalAnchorStore.ts` | 2 | 5 |
| `PrincipleStore.ts` | 2 | 4 |
| `ExperiencePendingStore.ts` | **0** | 2 |
| `PhysicalAnchorPendingStore.ts` | **0** | 2 |
| `PrinciplePendingStore.ts` | **0** | 2 |

`atomicWriteJson` 保证的是"不会写出半个文件"，不是"不会覆盖别人的写"。写前也没有重读合并 —— 内存快照被当作权威。

### 影响与设计意图直接冲突

README 把待审缓冲区描述为整个知识系统的信任边界：「AI 负责高召回地提议，人负责高精度地把关」。而 pending 库正是"高召回提议"的落点。丢一条 = 丢一条经验/锚点，**且完全无声** —— 用户不会知道有过这条提案。

触发场景不假设：
- 同项目并行跑 `meta-agent` 与 `meta-agent-glm`（README 明确支持双账号）
- 多个 CLI 实例开在同一项目
- 并发子代理各自提案（README 明确支持并发子代理）

### 修复

与正式库对齐，并且必须是**读-改-写**而不是覆写：

```ts
private async _persist(): Promise<void> {
  if (!this._filePath) return
  await withFileLock(this._filePath, async () => {
    const onDisk = await readJsonFile<PendingExperience[]>(this._filePath!) ?? []
    const merged = dedupeByPendingId([...onDisk, ...this._pending])   // 并集，不是覆盖
    if (merged.length === 0) { await rm(this._filePath!, { force: true }).catch(() => {}); return }
    await atomicWriteJson(this._filePath!, merged.slice(-MAX_PENDING_ENTRIES))
  })
}
```

合并后的截断也要留意：`_trimToLimit`（174-178 行）用 `splice(0, …)` 丢最旧的，而 `add()`（73-74 行）在到达 `MAX_PENDING_ENTRIES = 500` 时**抛错**。两条路径对同一个上限给出相反的语义（一个静默丢弃、一个硬失败），合并逻辑要明确选一个。

**同一文件还有一处独立问题**：`_persistSoon`（168-171 行）的持久化链两端各挂一个空 `.catch(() => {})`：

```ts
this._persistTail = this._persistTail
  .catch(() => {})
  .then(() => this._persist(snapshot))
  .catch(() => {})           // ← 磁盘写失败，无人知晓
```

磁盘写失败（ENOSPC、EACCES、只读挂载）**完全静默**：内存里 `count` 照常显示"N 条待审"，`repl.ts:1228-1234` 在退出时照常提示"下次用 `/experience review` 继续审核"，但文件根本没落盘，下次启动一条都没有。这条链吞掉的正是用户唯一能察觉数据丢失的信号。建议至少记一个 degraded 标志并在退出提示里反映出来 —— `GraphStore` 对轨迹投影就是这么做的（`trajectoryPersistenceDegraded` + 一次性 `console.warn`），可以直接照搬。

---

# P3 — 中

## P3-1 `commitKey` 含 `:`，Windows 上落不成文件，崩溃恢复静默失效

`GraphStore.ts:452` → `961`：

```ts
const commitKey = `${activation.id}:${activation.continuationVersion}`
private intentPath(commitKey: string): string {
  return join(this.paths.intentsDir, `${commitKey}.json`)
}
```

NTFS 上 `:` 是备用数据流（ADS）分隔符。`act-<uuid>:0.json` 会被写成文件 `act-<uuid>` 的一个名为 `0.json` 的数据流：

- `listJsonIds` 用 `readdir` 枚举，**看不到 ADS**
- `recoverPrepared()` 因此永远返回空 → **Windows 上的崩溃恢复完全失效，且不报错**

`docs/reviews/windows-porting-review-2026-08-12.md` 覆盖了 bash 缺失、路径扫描、`envPolicy: 'empty'`、`rename` 语义，但没有这一条。

**修复**：分隔符换成 `-` 或 `__`（`activation.id` 本身是 `act-<uuid>`，不含这两者，唯一性不受影响）。注意这是磁盘格式变更 —— 需要一个迁移或双读窗口，否则升级时在途的 intent 会读不到。

## P3-2 `AggregateError` 被 `isDeterministicGraphError` 误判为瞬时错误

`GraphKernel.ts:264-267` 抛出：

```ts
throw new AggregateError(kernelFailures, `graph tick finished with ${kernelFailures.length} kernel failures`)
```

`runner.ts:219` 只看顶层 message：

```ts
const value = error instanceof Error ? error.message : String(error)
```

`"graph tick finished with 2 kernel failures"` 匹配不上任何模式 → 判为瞬时 → 退避重试 5 次 → 标记实例 `paused` 并提示 `"inspect infrastructure and run loop resume"`。而真实原因可能是 `activation '…' cannot commit from succeeded` 这类确定性内核不变量违反，藏在 `.errors` 里。

结果：浪费 5 次重试，且把排障方向指向基础设施 —— 而问题在图或内核状态机。

**修复**：

```ts
function isDeterministicGraphError(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some(isDeterministicGraphError)
  }
  …
}
```

## P3-3 drift 闸门不可用时，节流窗口在闸门跑之前就被消费

`KernelLoop.ts:1931-1933`：

```ts
if (checkpointAdvanced && enoughBatches) {
  lastDriftToolBatchCount = toolBatchCount          // 先推进
  lastDriftCheckpointRevision = checkpointRevision
  … 之后才知道闸门是否可用（1956 行）
```

闸门不可用时 `consecutiveDriftGateFailures++`，但窗口已经消费掉了。下一次 drift 检查需要**再攒 `DRIFT_TURN_INTERVAL`（30）个 tool batch 且 checkpoint 再次推进**。

于是 `autoDriftFailureLimit` 名义上的"连续 N 次失败即停"，实际需要跑 N × 30 个 tool batch —— 在 `autoMaxToolBatches = 300` 的默认预算下，N=3 就已经吃掉整个 auto run 的 30%。这个止损几乎不会在预算内触发。

**修复**：失败路径回滚这两个游标，或给失败重试用一个独立的短节流（例如 5 个 batch），让止损在有意义的时间尺度内生效。

## P3-4 闸门重试的 `skipped` 分支跳过 abort 检查，且无退避

`KernelLoop.ts:1519-1538`（verify）与 `1936-1955`（drift）同构：

```ts
for (let attempt = 1; attempt <= autoGateMaxAttempts; attempt++) {
  try {
    const candidate = await config.verifyGate({…})
    if (candidate.skipped) { unavailableNote = …; continue }   // ← 跳过下面的 abort 检查
    …
  } catch (err) { unavailableNote = errorNote(err) }
  if (signal.aborted) break
}
```

`continue` 绕过循环末尾的中止检查。同时两条失败路径都没有退避 —— 闸门若因缺 API key 之类的原因瞬时抛错，会立刻连打 `autoGateMaxAttempts` 次。

**修复**：abort 检查移到循环体首；失败之间加一个小退避。

## P3-5 `resumePausedTerminal` 的 `decideTransition` 无 try/catch，与 `commit()` 不对称

`CommitCoordinator.ts:319-328` 裸调用 `decideTransition`。而同文件 168-184 行的 `commit()` 明确处理了这件事，注释写得很清楚：

> Transition evaluation runs reducer/function plugin code. A thrown error here must become a durable failed commit — letting it escape leaves the prepared intent poisoned and recoverPrepared replays the same throw on every tick, wedging the instance forever.

`resumePausedTerminal` 面对完全相同的插件代码，却让异常逃出事务。实例卡在 `paused`，每次 `loop resume` 重放同一个抛错，永远起不来 —— 正是上面那段注释描述的失败模式。

**修复**：套用 `commit()` 的持久化失败处理，把抛错转成一次 `failed` 状态变更 + journal 事件。

## P3-6 `journalEntryExists` 的注释因果链已过时

`GraphStore.ts:1288-1301` 的 M3-fix 注释说：

> readJsonFile() quarantines a file it cannot parse (renames it to `<path>.<ts>.corrupt`) and returns null. Both journal scans used it as their existence probe, so probing a CORRUPT entry deleted it…

但 quarantine 现在是 **opt-in**（`infra/persist/index.ts` 的 `quarantineCorrupt` 参数，注释里明确说明了为何改成 opt-in），而 GraphStore 的所有 `readJsonFile` 调用都没有传这个参数。

结论（不该用解析式读取做存在性探测）仍然成立，但给出的理由已经不对。这类注释比没有注释更危险 —— 后来人会据此推断 `readJsonFile` 仍有重命名副作用，从而做出错误的重构决策。

同时该注释也没提到 `readJsonFile` 现在对 EACCES/EIO/EMFILE **抛出**而非返回 null（B1 改动），这一层对 journal 扫描的影响没有被记录。

**修复**：重写这段注释，把理由更新为"存在性探测不应依赖解析成功；损坏条目必须留在原地以触发 `journal sequence gap`"。

## P3-7 `filesystemSize` 无界递归 + 无界并发

`loop/cli.ts:632-640`：

```ts
async function filesystemSize(path: string): Promise<number> {
  …
  const entries = await readdir(path).catch(() => [])
  const sizes = await Promise.all(entries.map(entry => filesystemSize(join(path, entry))))
```

深目录栈溢出、宽目录 EMFILE。仅影响 `loop status` / `loop gc` 的体积展示，不影响执行，但对 `.loop/` 下积累了大量实例的工作区会明显变慢。建议改迭代 + `mapWithConcurrency`。

---

# 观察 — 非缺陷，但影响成本可预测性与长期运行

## 观察一：`maxTurns` 不约束 API 调用次数

`KernelLoop` 的 `state.turnCount` 只在**完成一次工具批次**后递增（1771 行）。以下 `continue` 分支都不递增：

| 位置 | 分支 | 各自的界 |
|---|---|---|
| 1304 | fallback 模型切换 | 墓碑标志，1 次 |
| 1364 | 流式错误恢复 | `maxStreamErrorRecoveries`（默认 2）|
| 1429 / 1436 | max_output_tokens 升级与恢复 | `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` |
| 1488 | 空响应恢复 | `maxStreamErrorRecoveries` |
| 1588 | verify 拒绝 | `MAX_VERIFY_ROUNDS` |
| 1281 | 反应式压缩后重试 | `hasAttemptedReactiveCompact`，1 次 |

每个分支单独有界，但**计数器会在成功后重置**（1372-1374、1498-1500），所以它们是相乘而非相加的关系：`MAX_VERIFY_ROUNDS × (1 + maxStreamErrorRecoveries + 空响应恢复次数)`。

唯一的横向兜底是 `budgetExceeded()`，而它只在 1505（无工具路径）和 2018（工具路径末尾）两点检查 —— 即**恒定存在"一个 turn 的超支"**，且这个 turn 的成本还要加上 `additionalBudgetUsd()` 里的并发子代理预留。

建议在循环顶部加一个 `apiCallCount` 硬上限（比如 `maxTurns * 3`）。这不改变任何现有语义，但让"最坏情况花多少钱"变成一个可以在配置里读出来的数字，而不是六个常量的乘积。

## 观察二：`heartbeat()` 为续租做了全量快照重建

`GraphStore.heartbeat`（422-434 行）走 `reconcileLocked()`，代价是 O(journal since checkpoint)，还可能顺带写 checkpoint。但它实际只需要：读 activation 投影 → 校验 `lease.token` → 写回新的 `expiresAt`。函数自己的注释也说「Lease renewal is ephemeral scheduler state」。

每个 running activation 每 10s 一次，直接抬高了 P2-4 描述的锁竞争。建议退化成 O(1) 的投影读写路径。

## 观察三：`.loop/` 下已完成实例不自动归档，tick 成本随历史线性增长

`prepareAndClaim`（`runner.ts:49-94`）每 tick 遍历 `listGraphInstanceRecords` 的全部结果。终止态实例在 53 行短路（不做 snapshot），但仍要读每个 `instance.json`。`loop gc` / `loop archive` 都是手动的。

长期运行的工作区里，历史实例数只增不减，每个 tick 都要为它们付出一次目录遍历 + N 次文件读。建议给 `gc` 加一个可选的自动触发（比如 daemon 启动时对超过 30 天的终止态实例做一次归档）。

---

# 结构性建议

本轮 15 项发现里，至少 6 项（P1-1、P1-2、P2-5、P3-2、P3-5，以及 P2-3 的 finally 缺失）是**同一个不变量在多处实现、漏了其中一处**。这与 2026-08-14 那轮的 P0-2 完全同构 —— 当时的解法是把「按工具名判断」换成「按 `commandField` 声明判断」，让控制点从 3 处收敛到 1 处。同样的手法可以用在这里：

**1. 用不变量测试替代逐点审查。** 三条最值得加的：

- 任何 `LoopResult.finalMessages` 都不含无配对的 `tool_use`（锁死 P1-2 的全部 5 条路径和未来新增的路径）
- 任何 `setInterval` 里发起的 promise 都必须有 rejection handler（可以用 ESLint 规则 `no-floating-promises` + `@typescript-eslint/no-misused-promises` 覆盖大半，剩下的用一条 grep 断言）
- 任何 `spawnSubAgent` 的调用点，在非终止态退出时必须调用 `cancelTask`

**2. 把"心跳"抽成一个组件。** 目前有 5 处独立实现（`AutoScheduler`、`AttachedAutoScheduler`、`loop/runner.ts` ×2、`GraphKernel`），语义各不相同：有的容忍 3 次失败，有的容忍 0 次，有的根本不处理失败。抽成 `createLeaseHeartbeat({ renew, onLost, failureTolerance })` 之后，P1-1 这类问题在类型层面就不可能再出现。

**3. 给持久化 key 加一层文件名编码。** `commitKey`（P3-1）不会是最后一个把业务标识直接当文件名的地方。在 `infra/persist` 里加一个 `encodeRecordId()`，所有 `*Path()` 强制走它。

---

# 附：确认清单

以下均已回读源码逐条确认，非静态推断：

| 编号 | 关键证据 |
|---|---|
| P1-1 | `AutoScheduler.ts:237-241` 无 handler；`AttachedAutoScheduler.ts:92-104` 有；`repl.ts:1312` 致命 |
| P1-2 | `KernelLoop.ts:1377` append → `KernelSession.ts:398` 落盘；`SessionStore.ts:415-428` 只修头部 |
| P1-3 | `AutoWorktreeCoordinator.ts:558-566, 644-645`；`AgenticBackendFactory.ts:301` 无条件调用 |
| P2-1 | `GraphStore.ts:474-480`；`GraphKernel.ts:120` 每 tick 调用 |
| P2-2 | `GraphStore.ts:1051-1053`；`CommitCoordinator.ts:844` 的 `createdAt < wakeAt` 条件 |
| P2-3 | `VerifyJudge.ts:301` 只 break；`SubAgentBridge.ts:887` 的 `cancelTask` 无调用点 |
| P2-4 | `GraphKernel.ts:182` 在 map 内；`GraphStore.ts:356` snapshot 走 withTransaction |
| P2-5 | `grep -c withFileLock` 三个 pending store 均为 0，两个正式 store 均为 2；`ExperiencePendingStore.ts:168-171` 双空 catch |
| P3-1 | `GraphStore.ts:452` 构造 + `961` 直接拼文件名 |
| P3-2 | `GraphKernel.ts:266` 抛 AggregateError；`runner.ts:219` 只读 `.message` |
| P3-3 | `KernelLoop.ts:1932-1933` 先推进游标，`1956` 才判失败 |
| P3-4 | `KernelLoop.ts:1529, 1946` 的 `continue` 绕过 `1537, 1954` |
| P3-5 | `CommitCoordinator.ts:319` 裸调用 vs `171-184` 有保护 |
| P3-6 | `GraphStore.ts:1288-1301` 注释 vs `infra/persist/index.ts` 的 `quarantineCorrupt` opt-in |
| P3-7 | `loop/cli.ts:632-640` |

---

*评审人：Claude · 2026-08-31 · 基线 `c9731b0` (v0.9.6)*
