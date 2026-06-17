# meta-agent 全面代码评审报告

日期：2026-06-16
评审范围：系统稳定性、健壮性、内存管理、死代码、各系统逻辑正确性、错误处理、并发安全、幂等性、性能
覆盖子系统：kernel/core 运行时主干、并发与状态存储层、coordination/jobs/subagent/routing、robotics 子系统、tools & providers
方法：源码静态走读（`src/`，约 51k 行 TS）；与既有审查文档（`docs/code-review-*`、`docs/reviews/*`）对照，剔除已修复项。

---

## 总体评价

代码质量整体很高，并发与稳定性已经过多轮整改（源码中大量 `S*` / `P1-*` / `H*` / `M*` 标注即为历史修复痕迹）。值得肯定的工程实践：

- **原子持久化**：所有 JSON 落盘统一走 `atomicWriteJson`（写临时文件 + rename），崩溃不会损坏正式文件。
- **跨进程文件锁**：`withFileLock` 用 `wx` 原子创建 + rename 抢占陈旧锁，避免双进程同时进临界区。
- **熔断与上限**：自动压缩有失败计数与 PTL 重试；子代理有并发/队列/预算/墙钟四重上限；终态 Job 有 LRU + TTL 清理。
- **可中断退避**：DeepSeek/压缩的 sleep 均可被 abort 打断。
- **再入保护**：`CampaignMonitor` 轮询有 `tickInFlight` 守卫且 `unref()`。
- **幂等写入**：`SessionStore.append` 按 `appendFrom` 下标增量写；`completeTask` push 前 `includes` 去重。
- 上一轮（2026-06-10）的 P0「工具超时后 unhandledRejection 杀进程」已修复（`ToolExecution.ts:160` 的 `void callPromise.catch(()=>{})`）。

下面按严重程度列出本轮**新发现**的问题。每条给出文件:行、问题、影响与修复方向。

---

## 高 — 数据丢失 / 丢失更新（建议优先修）

### H1. 损坏的 `team.json` 会被静默覆盖为空白板（数据丢失）

`src/robotics/team/TeamStore.ts:959`（`read`）→ `:955`（`ensure`）→ `:276`（`init`）

`read()` 在 `JSON.parse` 失败时 `catch` 返回 `null`：

```ts
private async read(): Promise<TeamState | null> {
  const raw = await fileText(this.statePath)
  if (!raw) return null
  try { return migrateTeamState(JSON.parse(raw)) as TeamState | null }
  catch { return null }   // ← 损坏文件 == 不存在
}
```

而任何写操作都经 `ensure()`：`await this.read() ?? await this.init(github)`。当 `team.json` 因**崩溃半写**或**git 合并冲突标记**（`<<<<<<<`）而无法解析时，`read()` 返回 `null` → `init()` 再次 `read()` 仍为 `null` → 直接用 `defaultState()`（空 tasks/units）`writeAll()` **覆盖**原文件。整张协作看板（所有 task、attempts 历史）被清空。

对比 `core/persist/readJsonFile`：它在解析失败时会把坏字节重命名为 `<file>.corrupt` 并告警，绝不静默丢弃。`TeamStore` 缺了这层保护，而 team.json 恰恰是多人共享、最易出现合并冲突的文件。

**修复**：`read()` 区分「文件不存在」与「存在但损坏」。损坏时不要返回 `null` 让上游覆盖——应像 `readJsonFile` 一样隔离为 `.corrupt` 并**抛错**，让调用方停下来由人工/git 恢复，而不是用空板覆写。

### H2. `CampaignStateStore` 部分写操作绕过锁与 reload → 丢失更新

`src/coordination/CampaignStateStore.ts:439`（`setSampledPoints`）、`:450`（`registerPendingTasks`）

`completeTask` / `failTask` / `transitionPhase` / `markFailed` 都走 `_withLock(async () => { await this.reload(); …mutate…; await this._writeState() })`，即「跨进程锁 + 先 reload 再改写」。但下面两个方法直接改内存 `_state` 并 `_writeState()`，**既不取锁也不 reload**：

```ts
async registerPendingTasks(taskIds: string[]): Promise<void> {
  this._state.pendingTaskIds = [...new Set([...this._state.pendingTaskIds, ...taskIds])]
  this._state.updatedAt = new Date().toISOString()
  await this._writeState()                 // ← 无 _withLock、无 reload
}
async setSampledPoints(points: DesignPoint[]): Promise<void> {
  this._state.sampledPoints = points
  await this._writeState()                 // ← 且未更新 updatedAt
}
```

Coordinator 调 `registerPendingTasks` 的同时，Worker 可能正通过另一个实例 `completeTask`（持锁、已 reload）。后者基于磁盘最新态写入；前者基于**陈旧的内存态**覆盖 `state.json`，把刚完成的 task 又抹回 pending（lost update）。`setSampledPoints` 还漏更新 `updatedAt`，会让僵尸检测（`listActive` 用 `updatedAt` 判断 48h 阈值）误判存活时长。

**修复**：把这两个方法也包进 `_withLock` 并在内部先 `reload()`，与其它变更方法保持同一读改写协议；`setSampledPoints` 补 `updatedAt`。

---

## 中 — 并发正确性 / 资源泄漏 / 语义不一致

### M1. `withFileLock` 长临界区会破坏互斥；释放时不校验持有者

`src/core/persist/index.ts:152`

`staleMs` 默认 30s：持锁者一旦在 `fn()` 内停留超过 30s，另一进程会判定锁陈旧并 `rename` 抢占，于是**两个进程同时处于临界区**；更糟的是 `finally` 无条件 `unlink(lockPath)`——它可能删掉的是**别人刚创建的新锁**：

```ts
} finally {
  await unlink(lockPath).catch(() => {})   // ← 不校验锁是否仍属于自己
}
```

当前所有临界区都是「reload + 原子写」这类亚秒级文件操作，**实际触发概率很低**，故定为中危。但这是潜在的正确性缺口，未来若有人把较慢的逻辑（网络、LLM 调用）放进 `withFileLock` 即会暴雷。

**修复**：锁文件写入唯一 token（已写了 `pid + ISO 时间`，可改为随机 token）；释放前 `read` 校验 token 一致才 `unlink`；对可能较慢的 `fn` 增加 mtime 心跳刷新，或显著增大 `staleMs`。

### M2. `getEvaluations` 在无过滤时返回缓存内部数组引用

`src/coordination/CampaignStateStore.ts:597`

```ts
if (!filter) return allResults     // allResults 即 cached.results（静态 LRU 缓存内的数组）
```

无过滤分支把进程级静态缓存里的数组引用直接交给调用方。任何调用方对返回值做 `push`/`sort`/`splice` 都会**就地污染缓存**，后续 tick 读到脏数据。有过滤的分支因为 `.filter()` 产生新数组反而安全。

**修复**：`return [...allResults]` 返回副本（或冻结）。

### M3. `LoopResult` 中 token 用量是「本次循环」而成本是「累计」，语义不一致

`src/kernel/loop/KernelLoop.ts:524`、`:548`

```ts
let totalUsage = emptyUsage()            // 从 0 开始（仅本次 runKernelLoop）
let totalCost  = ctx.cumulativeCostUsd   // 从累计值开始
…
return { totalUsage, costUsd: totalCost, … }
```

返回结构里 `totalUsage`（token）只统计本次循环，`costUsd` 却是跨循环累计。下游若用 `totalUsage` 估算成本或展示用量，会与 `costUsd` 对不上；预算判断 `totalCost >= maxBudgetUsd` 是对的，但报表口径混乱。

**修复**：统一口径——要么两者都「本次」，要么都「累计」，并在 `LoopResult` 字段注释里写清。

### M4. `SubAgentRunner._writeTerminal` 在 `mutateTask` 抛错时不释放写链

`src/subagent/SubAgentRunner.ts:594`

```ts
const written = await mutateTask(this.record.taskId, …)   // ← 若抛错…
if (written === null) { … ; await releaseWriteChain(...); return }
Object.assign(this.record, candidate)
await releaseWriteChain(this.record.taskId)               // ← …这行不会执行
```

`mutateTask`（磁盘写失败等）一旦抛出，`releaseWriteChain` 两个分支都被跳过，该 taskId 的 per-task 写链**永久不释放**，后续对同一任务的写入会被卡住。外层 `_run` 的 catch 会再调一次 `_writeTerminal`（同样可能抛），无助于释放。

**修复**：用 `try { … } finally { await releaseWriteChain(taskId) }` 包裹，保证无论成败都释放。

### M5. SubAgentBridge 轮询定时器对「永不进入终态」的任务不会停止

`src/subagent/SubAgentBridge.ts:603`

`_startPollTimer` 仅在 `record` 为空或进入 `TERMINAL_STATUSES` 时 `clearInterval`。若某任务的 runner 在**另一进程**崩溃、未写终态，`readTask` 持续返回非终态记录，该 `setInterval` 将**永远轮询**。定时器已 `unref()`，不会阻止进程退出，但在长驻 host 中是缓慢的句柄/CPU 泄漏。

**修复**：记录定时器启动时间，超过 `maxDurationMs`（或一个绝对上限）后主动判失败、入队通知并 `clearPollTimer`，与 `_failStaleActiveTasks` 的语义对齐。

---

## 低 — 死代码 / 健壮性 / 性能

### L1. 死代码：`MetaAgentSession._registerWrapped`

`src/core/MetaAgentSession.ts:633`

私有方法，全代码库无调用点（构造函数走的是 `registerTool`）。删除即可。

### L2. bash 工具按 chunk `toString('utf-8')` 可能在多字节边界产生乱码

`src/tools/shell/bash/index.ts:191`

```ts
child.stdout?.on('data', (chunk: Buffer) => {
  if (stdout.length < opts.captureLimit) stdout += chunk.toString('utf-8')
})
```

一个 UTF-8 字符若被拆到两个 chunk，逐块 `toString` 会在边界产生替换字符。对中文/emoji 输出尤其明显。

**修复**：用 `new StringDecoder('utf8')` 累积，`end` 时 flush。属体验性问题，非功能阻断。

### L3. `KernelLoop.append` 每次都重建 `state` 对象

`src/kernel/loop/KernelLoop.ts:543`

```ts
function append(...msgs) { mutableMessages.push(...msgs); state = { ...state, messages: mutableMessages } }
```

`state.messages` 已恒等于 `mutableMessages`，此处的浅拷贝纯属冗余分配（每轮 2–3 次）。可仅在确有字段变化时重建，或直接 `mutableMessages.push` 而不动 `state`。微优化。

### L4. `TeamStore` 乐观并发冲突无自动重试

`src/robotics/team/TeamStore.ts:995`（`writeAll` 的 updatedAt 校验）

设计上冲突即抛 `Concurrent modification…`，要求**调用方重试**。但代码库未见统一的重试包装，最终错误会直接抛给模型/用户。单机多 task 并发时表现为「偶发报错让用户重来」。可接受，但建议在工具层加一个「读-改-写」小重试（指数退避 2–3 次）以改善体验。

### L5. `DeepSeekClient.buildDeepSeekTools` 每次请求都重建工具描述

`src/kernel/api/DeepSeekClient.ts:187`

每次 `streamDeepSeekMessages` 都对全部工具 `await t.description(...)` 重建 schema。多轮会话下重复劳动；动态描述通常便宜，故为低危。可按 (sessionId, model, 工具集签名) 记忆化。

### L6. `CampaignStateStore` 静态缓存中单 campaign 的 results 数组无上限

`src/coordination/CampaignStateStore.ts:97`

`_evalCache` 按 campaign 做了 32 条 LRU，但**单个** campaign 的 `results[]` 随评估数量线性增长且不裁剪。长跑大规模 campaign 下该数组可能很大。当前由评估总数自然封顶，属可接受，但长期可考虑对历史 results 做分页/截断。

---

## 各维度小结

**稳定性**：核心循环、压缩、子代理、监视器的崩溃面已被多轮加固，主干扎实。剩余风险集中在 H1/H2 的数据面而非控制面。

**健壮性**：解析容错普遍到位（逐行 JSONL 容错、index 损坏条目过滤、`readJsonFile` 隔离），唯一明显缺口是 `TeamStore.read` 没沿用同样的隔离策略（H1）。

**内存管理**：Job 终态 LRU、campaign eval LRU、子代理通知环形截断、记忆行/字节双截断都有；待改进点见 L6、M5。

**死代码**：整体很干净（无遗留 TODO/FIXME）；仅发现 L1 一处。

**逻辑正确性**：状态机（campaign 相位、team 所有权、job 状态）转换校验严谨；H2 是唯一会破坏不变量的并发写路径。

**错误处理**：best-effort 吞错的边界把握得当（持久化失败不杀会话）；需注意 M4 的 finally 释放遗漏，以及 H1「吞错=数据丢失」的反面教训。

**并发安全**：跨进程锁 + 进程内串行链 + 乐观并发三件套设计良好；M1 是潜在但当前低触发的缺口，H2 是实打实的绕过。

**幂等性**：append-by-index、append-only JSONL、去重 push、相位转换校验均幂等；未发现幂等性破坏。

**性能**：增量字节读、KV 缓存前缀稳定化、客户端连接池复用、轮询再入守卫等都已做；剩余为 L3/L5 级别微优化。

---

## 建议修复顺序

1. H1（团队看板数据丢失）、H2（campaign 丢失更新）—— 数据面，优先。
2. M4（写链泄漏）、M5（定时器泄漏）、M2（缓存别名）—— 长驻稳定性。
3. M1（锁释放校验）、M3（用量/成本口径）—— 正确性硬化。
4. L1–L6 —— 清理与微优化，随手可改。

> 验证建议：每条修复配单测——H1 用「写入含冲突标记的 team.json 后调用 addTask，断言原 tasks 不丢」；H2 用「并发 registerPendingTasks 与 completeTask，断言无 lost update」；M4 用「mutateTask 注入抛错，断言写链可被后续获取」。
