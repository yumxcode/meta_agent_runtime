# meta-agent 代码审查报告

日期：2026-08-12 · 版本 0.8.14 · 范围：`src/`（85k LOC，已排除 `campaign/`、`campaigns/`、`coordination/Campaign*`）
关注点：逻辑 bug · 资源管理 · 程序健壮性

---

## 总评

这份代码库的防御性水平明显高于同类项目：绝大多数定时器都 `unref()` 了、abort listener 在 `finally` 里成对摘除、`atomicWriteJson` 统一了写入原子性、`withFileLock` 用 rename 做无竞争的 stale 抢占、`SubAgentRunner` 的清理路径覆盖了所有 return/throw 分支。代码里大量 `M1-fix` / `L2` / `P1-8` 注释说明这些位置已被反复审过。

因此本轮的发现集中在**上一轮审查没覆盖到的一类模式**：**同步检查 → await → 同步登记**。多处准入/去重逻辑在检查与登记之间插入了 `await`，在单线程 JS 里依然构成 TOCTOU——因为模型可以在一个 tool batch 里并发触发同一入口。

按严重度排序如下。

---

## 高 · H1 — `spawnSubAgent` 并发准入 TOCTOU：队列上限与总预算可被击穿

**位置**：`src/subagent/SubAgentBridge.ts:577-696`

```ts
const outstandingTasks = this.activeTaskIds.size + this.queuedStarts.size   // 577  ← 检查
if (!isInternal && outstandingTasks >= maxOutstandingTasks) throw …

if (… this.settledCostUsd + this.reservedBudgetUsd + requestedBudget > max) throw   // 597  ← 检查

  await this._worktreeCoordinator.allocate(…)   // 649  ← await
  await writeTask(record)                       // 661  ← await

else this._reserveBudget(taskId, requestedBudget)                    // 672  ← 登记
this.queuedStarts.set(taskId, { record, abortController, … })        // 696  ← 登记
```

**为什么会真的触发**：`spawn_sub_agent` 声明 `isConcurrencySafe: true`（`src/subagent/tools/spawn_sub_agent.ts:22`），而 `ToolOrchestration.runTools` 对连续的并发安全工具用 `Promise.all` 成批执行，批大小默认 10（`src/kernel/tools/ToolOrchestration.ts:113-123`，`RuntimeEnv.toolUseConcurrency(10)`）。模型一轮里发 N 个 `spawn_sub_agent`，N 次调用会在任何一个 `await` 返回之前全部通过第 577/597 行的检查。

**后果**：
- `maxConcurrentSubAgents + maxQueuedSubAgents` 上限被击穿最多 N−1 个任务；
- bridge 级 `maxTotalSubAgentBudgetUsd` 被超额预留最多 N−1 份 `maxBudgetUsd`；
- `isolated_write` 场景下同时多分配 N−1 个 git worktree。

auto 模式下 `costLedger.tryReserveTask()`（593 行，**同步**）能兜住 session 级预算——这也说明作者已经意识到了同步预留的必要性；但 bridge 级预算和队列上限没有同样的保护，非 auto 模式则完全没有兜底。

**修复**：把容量检查 + 占位放进同一个同步块（`await` 之前），例如先 `this.queuedStarts.set(taskId, placeholder)` + `this._reserveBudget(...)`，失败路径在 `catch` 里回滚。

---

## 高 · H2 — 重试去重的 `await` 窗口：一次失败可能派发两条重试链

**位置**：`src/subagent/SubAgentBridge.ts:986-999`

```ts
if (this.retryScheduledFor.has(taskId)) return    // 986  ← 检查
const rec = await readTask(taskId).catch(…)       // 987  ← await
…
this.retryScheduledFor.add(taskId)                // 999  ← 登记
```

注释写明"one physical task can schedule at most one retry"，而上一行注释又写明"Event and poll delivery are **intentionally redundant**"。两条冗余通路（`CampaignEventBus` 的 `subagent:failed` 与 poll tick）正是设计上会同时到达的——`_onFailed` 里的 `_clearPollTimer` 是同步的，但一个已经在 `await readTask` 里的 poll tick 无法被撤回。

**后果**：同一逻辑任务派生两条独立重试链 → worktree 翻倍、预算翻倍、`auto_merge_subagent` 面对两个分支。

**修复**：把 `retryScheduledFor.add(taskId)` 提到第一个 `await` 之前；判定不该重试时再 `delete`。

---

## 高 · H3 — 空响应恢复的 `splice` 会误删 phase hook 注入的消息

**位置**：`src/kernel/loop/KernelLoop.ts:1298 → 1304 → 1385`

顺序是：

```ts
append(...assistantMessages)                       // 1298
const ph = await runPhaseHook('post_query')        // 1304  ← 可能 append(inject 消息)
…
mutableMessages.splice(                            // 1385
  Math.max(0, mutableMessages.length - assistantMessages.length),
  assistantMessages.length,
)
```

`runPhaseHook` 在 `outcome.inject?.length` 时会逐条 `append(makeTextUserMessage(text, { isMeta: true }))`（`KernelLoop.ts:750-754`）。所以 1385 行"assistant 消息一定在数组尾部"的假设在 `config.phaseHooks` 配置且返回 inject 时不成立。

**后果**：删掉 K 条注入消息 + 部分 assistant 消息，留下应被丢弃的空 assistant 消息。hook 的注入静默丢失，恢复逻辑本身也失效——而这条路径正是为"provider 返回空响应"的异常场景准备的，两个异常叠加时最难排查。

**修复**：按 `uuid` 集合过滤，而不是按尾部长度 splice：

```ts
const drop = new Set(assistantMessages.map(m => m.uuid))
const kept = mutableMessages.filter(m => !drop.has(m.uuid))
mutableMessages.splice(0, mutableMessages.length, ...kept)
```

---

## ~~中~~ → 撤回 · M1 — `_settleBudget` 无幂等保护

**位置**：`src/subagent/SubAgentBridge.ts:1253-1268`；调用点 `511 / 867 / 876 / 1388`

**这条我判断错了，先更正。** 原文声称 cancelTask 与 runner 完成回调会用同一个真实 cost 各结算一次、导致 `settledCostUsd` 翻倍。写回归测试时这条测不出来，回去逐条走 interleaving 才发现前提不成立：

`cancelTask` 在 `runners.get(taskId)` 命中时会**提前 return**（`runner.abort()` 后直接 `return true`），根本走不到 `_settleBudget`。所以：

- runner 还在跑 → cancelTask 提前返回，只有 runner 会结算；
- runner 已摘除自己 → 磁盘记录已是终态，cancelTask 首个 `readTask` 就 `return false`；
- 唯一能双结算的窗口，是 drain 已经把任务从 `startQueue` 摘下、正卡在 `await readTask` 时被 cancel。而这条路径上 cancelTask 写的是 **cost 为 0 的 `cancelled` 墓碑**，`_writeTerminal` 之后不会覆盖它，于是 runner 完成回调读回的是同一条 0 成本记录。

**两次结算携带的值必然相同，因此原本就不会多算。** 这条不是 bug。

**仍然做了改动**（标注为加固而非修复）：`_settleBudget` 加了 once-per-task 门。理由是"只结算一次"目前是四个调用点各自 early-return 结构的涌现性质，在记账函数自身没有任何表述；`AutoCostLedger.settleTask` 早就是幂等的，让 bridge 侧对齐，可以防止后续新增调用点时把双计重新引入。

对应测试没有去伪造一个调用方产生不出来的双结算，而是覆盖真实可达的性质：结算恰好释放它占用的那份预留（取消路径与完成路径各一条）。

---

## 中 · M2 — `AnthropicClient`：admission lease 与 debug 句柄在 `try` 之外获取

**位置**：`src/kernel/api/AnthropicClient.ts:210-229`

```ts
const modelAdmission = await acquireRegisteredModelCall(…)   // 210  ← 拿到 host 级并发槽 + 心跳 interval
const writer = await DebugWriter.open(…)                     // 215  ← 打开 2 个文件句柄
if (writer) await writer.writeRequest(…)                     // 217  ← 可能抛
…
try { … } finally {
  await modelAdmission?.release()                            // 313  ← 唯一释放点
  if (writer) await writer.close()
}
```

210/215/217 三行在 `try` 之外。`writeRequest` 抛错（`debug: true` 且 ENOSPC / EDQUOT / EACCES）会让：

- `modelAdmission` 永不 `release()` → **host 级模型并发槽被永久占住**，且 `acquireRegisteredModelCall` 内部的 `setInterval` 心跳（`src/infra/modelCallAdmission.ts:62-67`）泄漏；
- `.jsonl` / `.md` 两个 FileHandle 泄漏。

`DeepSeekClient.processStream`（`:357-359`）有同形状的句柄泄漏，但不涉及 admission。

**修复**：把 210 行之后的所有语句移入 `try`。

---

## 中 · M3 — `GraphStore` 用 `readJsonFile` 做 journal 存在性探测，会销毁并静默覆盖损坏事件

**位置**：`src/loop/graph/runtime/GraphStore.ts:592-593`、`786-793`

```ts
let sequence = await this.readLastSequenceLocked() + 1
while (await readJsonFile<SequencedGraphJournalEvent>(this.journalPath(sequence))) sequence++
await atomicWriteJson(this.journalPath(sequence), record)
```

`readJsonFile`（`src/infra/persist/index.ts:52-72`）对"文件存在但 JSON 解析失败"的处理是：**把文件 rename 成 `<path>.<ts>.corrupt` 然后返回 null**。用它当存在性探测，等于让探测本身带上破坏性副作用：

1. 损坏的 journal 事件被隔离走；
2. `while` 循环在该 sequence 停下；
3. 新事件直接写到这个 sequence 上——**序号被静默复用，日志少了一条事件，且不产生 gap**。

`readLastSequenceLocked`（786-793）用同一模式向前扫描，问题相同。

值得注意的是 `isDeterministicGraphError` 里专门有 `/journal sequence gap/` 的判定（`src/loop/runner.ts:230`），说明系统本来是期望能检测出 gap 的——这条路径恰好把可检测的 gap 变成了静默覆盖，属于"崩溃恢复机制被自己的读工具绕过"。

**修复**：存在性探测改用 `stat()` / `access()`；探测到存在但不可解析时显式抛错（走 deterministic 分支 → 实例 `failed` 而不是伪装成健康）。

---

## 中 · M4 — `isInsideWorkspace` 用字符串前缀，而同文件里已有正确的段比较实现

**位置**：`src/tools/fs/workspaceGuard.ts:61`、`89`

```ts
export function pathIsUnder(absolutePath, root) {          // 40  ← 正确：按 path 段比较
  const rel = relative(root, absolutePath)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function isInsideWorkspace(path, workspaceRoot) {   // 58
  …
  return target === workspace || target.startsWith(workspace.endsWith(sep) ? workspace : workspace + sep)  // 61  ← 字符串前缀
}
```

补了分隔符之后在 POSIX 上与 `pathIsUnder` 等价，所以不是当前的活跃漏洞。但 `pathIsUnder` 就写在上面 20 行处、文件注释还专门讲了"两个调用点长出私有副本然后漂移"的历史——留着两套语义就是下一次漂移的入口。Windows 上大小写与分隔符混用（`C:\proj` vs `c:/proj`）会漏判。

**修复**：`isInsideWorkspace` / `resolveInsideWorkspace` 统一改调 `pathIsUnder`。

---

## 中 · M5 — `_dispose` 里 `retryScheduledFor` 的写入是死代码

**位置**：`src/subagent/SubAgentBridge.ts:502-507`

```ts
for (const [taskId, timer] of this._retryTimers) {
  this.retryScheduledFor.add(taskId)   // 503
  clearTimeout(timer)
}
this._retryTimers.clear()
this.retryScheduledFor.clear()          // 507  ← 立刻抹掉 503 的效果
```

503 行想表达的是"dispose 期间不许再派发重试"，但 507 行立刻清空。实际拦截靠的是 `destroyed = true`（986 行 `_maybeRetryFailed` 开头 + 重试 timer 回调里的 `if (this.destroyed) return`），所以目前没有真实故障。但意图与实现不符，且 `cancelAll`（915 行）用的是同一模式却**不**清空——两处行为不一致，容易在后续改动中踩坑。

**修复**：删掉 507 行的 `clear()`（与 `cancelAll` 对齐），或删掉 503 行并在注释里指明依赖 `destroyed`。

---

## 低 · 其余观察

| # | 位置 | 说明 |
|---|---|---|
| L1 | `kernel/tools/ToolOrchestration.ts:170` | control 中断后为未执行调用填的错误文案写死为 "parked by an earlier self_timer call"，但 control 可能来自其它控制工具。模型会读到误导性归因。 |
| L2 | `core/auto/AutoWorktreeCoordinator.ts:698-703` | `_dropStashByCommit` 用 `stash list` 的下标定位再 `stash drop stash@{i}`。`_exclusive` 只串行化协调器自身；用户或主 agent 在同仓库并发操作 stash 会导致 drop 错条目。建议改用 `git stash drop` 前重新校验 SHA。 |
| L3 | `core/auto/AutoWorktreeCoordinator.ts:343-427` | `_mergeTransaction` 在**主工作树**上 `stash push` / `merge`，而主 agent 的 bash / write_file 工具此刻可以并发写同一目录。协调器锁管不到这些。建议 merge 期间冻结主 agent 写工具，或至少在 merge 前后比对工作树 HEAD/dirty 状态并 fail-fast。 |
| L4 | `tools/shell/bash/index.ts:223-228` | `if (stdout.length < captureLimit) stdout += …` 先判后加，单块最多超出一个 pipe 缓冲（~64KB）。因为 `captureLimit = limit * 2` 且最终仍会 `trunc` 到 `limit`，实际只是多占内存；但把 `META_AGENT_MAX_TOOL_OUTPUT_CHARS` 调小后超出比例会很显著。另：达到上限后不再喂 decoder，也不 `pause()` 流，超长输出仍会持续消耗管道读取。 |
| L5 | `kernel/loop/KernelLoop.ts:641` | `let allPermissionDenials` 从未重新赋值，应为 `const`。 |
| L6 | `kernel/loop/KernelLoop.ts:590-597` | `stableStringify` 无深度上限。工具输入由模型生成，理论上可构造深嵌套触发栈溢出。`loop/expr/Expr.ts` 已经为同类问题加了深度上限，这里可以对齐。 |

---

## 复核过但确认**没有**问题的点

以下几处初看可疑，逐行核对后确认实现是正确的，记录下来避免下次重复审：

- **`ToolExecution` 的 `timedOutRunning` 计数**（`:220-256`）——`callSettled` 在微任务里置位、`registeredAsTimedOutRunning` 在宏任务定时器里置位，闭包读取时序正确，不会漏减或重复减。
- **`SubAgentRunner._run` 的 `finally`**（`:632-643`）——durationTimer、两个 abort listener、lineage 持久化、session dispose、sandbox handle 全部覆盖，且覆盖了所有 `return` 分支。
- **`withFileLock` 的 stale 抢占**（`infra/persist/index.ts:216-243`）——用 `rename` 而非 `unlink` 做原子认领，释放前用 ownerToken 比对，心跳 `unref`。正确。
- **`acquireDaemonLock`**（`loop/daemon.ts:153-192`）——`writeFile(tmp)` + `link()` 保证"存在性检查"与"内容写入"的原子性，避免半写锁文件把函数永久卡死。正确。
- **`LinuxSandboxExecutor.create`**（`sandbox/LinuxSandboxExecutor.ts:96-108`）——嵌套 bwrap 检测 fail-closed，仅在 `allowUnsandboxedFallback` 时降级。正确。
- **`AnthropicClient` 的重试 listener**（`:236 / :311`）——每次 attempt 的 forwarder 在 per-attempt `finally` 里摘除，不会在长生命周期 signal 上累积。正确。
- **`tools/ui/*` 的 session-scoped Map**——`SessionRouter.ts:408-410` 与 `:560-563` 确实调用了三个 `deleteXxxForSession`，不是泄漏。
- **`SubAgentTaskStore._writeChains`**——`releaseWriteChain` / `cleanupTask` 会 `delete`，且调用点覆盖了终态路径。不是泄漏。

---

---

## 修复状态（v0.8.15）

全部已实施，`tsc --noEmit` 干净，`vitest run` 212 文件 / 2099 用例通过。

| 条目 | 状态 | 新增/修改测试 |
|---|---|---|
| H1 准入 TOCTOU | 已修：`admittingTaskIds` 同步占位，检查+占位+预留全在首个 `await` 之前，失败路径回滚 | `AdmissionConcurrency.test.ts` ×3 |
| H2 重试去重 | 已修：`retryScheduledFor.add` 提到 `await readTask` 之前；不重试时**不**释放槽位（避免抹掉 `cancelTaskFamily`/`cancelAll` 的墓碑，顺带去重了重复的失败通知） | — |
| H3 空响应 splice | 已修：按 uuid 过滤 | `EmptyResponseRecoveryWithPhaseHook.test.ts` |
| M1 结算幂等 | **判断有误，见上**；仍作为加固保留 | `AdmissionConcurrency.test.ts` ×2（覆盖可达性质） |
| M2 client try 边界 | 已修：Anthropic + DeepSeek 两处 | — |
| M3 journal 探测 | 已修：改用 `access()`；损坏项保留在盘上，读取时抛 `journal sequence gap`（deterministic → 实例 `failed`） | `GraphJournalCorruption.test.ts` |
| M4 containment 语义 | 已修：两个入口改调 `pathIsUnder` | `workspaceGuardContainment.test.ts` |
| M5 dispose 死代码 | 已修：保留墓碑、删掉紧随其后的 `clear()`，与 `cancelAll` 行为一致 | — |
| L1 skip 文案 | 已修：按 control kind + 实际触发工具生成 | `ToolParkControl.test.ts` 加断言 |
| L2 stash drop | 已修：drop 前用 `rev-parse` 复核 ref 仍指向目标 commit，位移则重读重试 | — |
| L4 bash 截断 | 已修：精确截到 `captureLimit`，decoder 继续喂以保持多字节状态 | — |
| L5 / L6 | 已修：`const`；`stableStringify` 加深度上限 64 | — |
| L3 merge 与主 agent 并发写 | **未修** — 见下 | — |

### 三条高危修复都验证过"能测出旧 bug"

不是只看新测试变绿，而是把旧实现逐条塞回去确认测试会红：

- H1 队列：移除 `admittingTaskIds` 计数 → 8 个并发 spawn 全部被准入（上限 2）。
- H1 预算：把 `_reserveBudget` 移回 `await` 之后 → 6 个 $0.25 请求全过（上限 $1.00）。
- H3：换回尾部 splice → phase hook 注入的消息被删掉，断言失败。
- M3：探测换回 `readJsonFile` → 新事件写到序号 2，复用了损坏项的编号并孤立了序号 3。

### 未修：L3

`AutoWorktreeCoordinator.merge()` 会在**主工作树**上 `stash push` / `merge`，而主 agent 的 bash / write_file 此刻可以并发写同一目录；`_exclusive` 只串行化协调器自身的操作，管不到工具调用。

这不是能靠局部改动收敛的问题——要么在 merge 期间冻结主 agent 的写工具（需要 KernelSession 侧的协作），要么把 merge 挪到独立工作树里做。两条都是设计层面的取舍，不适合夹在一次 bug 修复里顺手改，留作单独议题。
