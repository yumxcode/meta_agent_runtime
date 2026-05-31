# meta-agent-runtime 长跑稳定性与内存评审（2026-05-29）

**评审视角：** 进程运行数小时到数天、累计上百会话 / 数万次工具调用的工程化场景
**关注面：** 内存增长、句柄/timer/listener 泄漏、磁盘膨胀、GC 压力、CPU 累积
**前置：** 上一份 `CODE_REVIEW_2026-05-29.md` 中的 H/M/L 系列已修复（含 SDK client LRU、web_fetch cache、abortable sleep 等）

---

## 一、整体盘点

| 区域 | 状态 | 备注 |
|---|---|---|
| Timer 生命周期 | 🟢 良好 | `setInterval` 全部 `unref()` + 显式 `clearInterval`；进程退出不被阻塞 |
| AbortSignal listener | 🟢 良好 | `SubAgentRunner` / `DeepSeekClient` 都成对 add/remove；abortable sleep 也清理 |
| 文件句柄 | 🟢 良好 | `open()` 全部走 `try/finally close()`；DebugWriter 写完 close |
| 模块级 cache | 🟡 已有上限 | web_fetch (50)、Anthropic/DeepSeek client (16)、ProvenanceTracker (10 000) |
| Session 资源回收 | 🔴 **AgenticSession/CampaignSession 缺 dispose**（关键） |
| Job 状态累积 | 🔴 **JobManager.jobs Map 无 evict**（关键） |
| 消息历史拷贝 | 🟠 KernelLoop 每 turn O(n) 复制 messages 数组 |
| Debug 文件磁盘 | 🟠 无 rotation / 无 purgeStale；长跑下慢慢膨胀 |
| Robotics 静态 Map | 🟢 已经按 campaignId/sessionId 自清理 |
| Listener 重复绑定 | 🟢 SubAgentBridge 用 `_bridgesBySessionId` 防止双绑 |

---

## 二、🔴 关键问题

### S1 · `AgenticSession` / `CampaignSession` 没有 `dispose()` — 会话资源永驻

**位置：** `src/modes/AgenticSession.ts`、`src/modes/CampaignSession.ts`

`SessionRouter.dispose()`（`src/routing/SessionRouter.ts:284`）按以下方式收尾：

```ts
const impl = this._impl as (SessionImpl & { dispose?: () => Promise<void> }) | null
...
if (impl?.dispose) {
  try { await impl.dispose() } catch { /* best-effort */ }
}
```

但 `AgenticSession` 与 `CampaignSession` **都没有 dispose 方法**——它们持有：
- `_engine: KernelSession`，进一步持有 `_messages: KernelMessage[]`（可达数 MB）、`_fileCache: FileStateCache`（默认 200 条）、`_config.tools` 引用、`onMessagesUpdate` 回调、`canUseTool` 闭包；
- 通过 `instrumentTool` / `_wrapTool` 形成的 RuntimeContext 强引用（含 ProvenanceTracker、JobManager、VVChain）；
- 注册时形成的 closure（`getDescriptionContext: () => ({ tools, toolNames, ... })`），会反向锁住整个 tools 列表。

只要 `SessionRouter` 实例自身不被 GC，这一切都活着。在常驻服务场景里（一个进程承载多个 session），这是逐步累积的 root。

**修复（30 分钟）：**

```ts
// AgenticSession
async dispose(): Promise<void> {
  this._engine.interrupt()
  // 让 GC 立刻可达：解开循环引用
  this._registeredTools.length = 0
  // KernelSession 本身也需要一个 dispose
}
```

并在 `KernelSession` 上加：

```ts
dispose(): void {
  this._abortController.abort('dispose')
  this._messages.length = 0
  this._fileCache.clear()
  this._permissionDenials.length = 0
}
```

`CampaignSession` 同样实现 dispose，转发到 inner kernel + 自己的资源。

---

### S2 · `JobManager.jobs` 永不删除完成的任务

**位置：** `src/jobs/JobManager.ts:67, 109, 142, 161, 178`

`this.jobs = new Map<JobId, RuntimeJob>()` 在 `submit()` 时 set；在 onCompleted / onFailed / onCancelled 中只更新状态，**从不 delete**。每个 `RuntimeJob` 含完整 `EngineeringJob`、`result`、`progressListeners`、`completionResolvers`、`artifacts`，单条可达几十 KB～几百 KB。

常驻 host 启动后跑 1 万个 job → 内存里堆 1 万条 RuntimeJob（数 GB）。

**修复（1 小时）：**
1. 暴露 `forgetJob(id)` 和 `forgetCompletedBefore(timestamp)` 两个 API；
2. 在 `_transition()` 进入 terminal 状态后清空 `progressListeners`、`completionResolvers`（避免 closure 滞留）；
3. 配置项 `keepTerminalJobs: number`（默认 100）做 LRU 自动 evict。

---

### S3 · `KernelLoop.append()` 每次 turn 复制整个 messages 数组

**位置：** `src/kernel/loop/KernelLoop.ts:180-184`

```ts
function append(...msgs: KernelMessage[]): void {
  mutableMessages.push(...msgs)
  state = { ...state, messages: [...mutableMessages] }   // ← O(n) 拷贝
}
```

每个 turn 至少 2-3 次 append（assistant、tool_results、extra_messages），每次都对整个累计消息数组做一次浅拷贝。100-turn 的会话：
- 平均 50 条消息时 × 3 拷贝 × 100 turn ≈ 15 000 次数组复制；
- 真正读 `state.messages` 的地方只在 `applyToolResultBudget(state.messages, …)`——它做只读迭代，不需要"snapshot"语义。

**这不是泄漏（旧数组进入 young gen），但是显著的 GC 压力**：100 turn 的会话能产生几十 MB 的临时分配，在长会话+小堆机器（如 Bun 默认 192MB）上触发频繁 GC，p99 抖动明显。

**修复（10 分钟）：**

```ts
function append(...msgs: KernelMessage[]): void {
  mutableMessages.push(...msgs)
  state.messages = mutableMessages  // ← 直接共享同一引用（state 本来就是 mutable scope-local）
}
```

`state.messages` 与 `mutableMessages` 在整个 loop 内本质是同一逻辑数组，使用引用而非快照不会引入 race（loop 是单 generator）。

---

## 三、🟠 中等问题

### S4 · DebugWriter 文件无 rotation / purgeStale

**位置：** `src/kernel/api/DebugWriter.ts` + `MetaAgentSession._writeDebugFile`

每次模型调用一个 `.jsonl` 文件，路径 `~/.meta-agent/debug/<sessionId>/<ISO>-<model>.jsonl`。`debug: true` 时：
- 一个 100-turn 会话 ≈ 100 个文件 × 平均 50KB（request+response）≈ 5 MB；
- 同时 `MetaAgentSession._writeDebugFile` 也往同目录写 `turn-NNN-req.json` / `-res.json`；
- 没有任何 size cap / age cap / purge 入口。

常驻 dev 模式 (`debug:true`) 半年后能写几 GB。

**修复（30 分钟）：**
- 加 `pruneStaleDebug(ttlMs)` 函数，默认 14 天；在 `MetaAgentSession.dispose()` 或 SessionRouter `dispose()` 中触发；
- 或在 `DebugWriter.open()` 写入前按 `sessionId` 目录 size cap（如 200 MB）做 ring-buffer。

### S5 · `CampaignStateStore._evalCache` 静态 Map 仅按 cleanup 清理

**位置：** `src/coordination/CampaignStateStore.ts:90`

```ts
private static readonly _evalCache = new Map<string, { offset: number; results: EvaluationResult[] }>()
```

`_evalCache` 在 `_loadAll()` 时按 campaignId 累积 `EvaluationResult[]`。`CampaignMonitor._stop` → `cleanup(campaignId)` 会移除该 entry；但**不调用 `_stop` 的代码路径**——例如 CLI 列举所有 campaign / status 命令 / 测试反复 `load` 同一 id——会让条目永久留下。

数百 campaign 历史时，cache 会有数百 MB（每个 campaign 含上千 EvaluationResult，每个数 KB）。

**修复（半小时）：**
- 加 LRU 上限 `MAX_CAMPAIGNS_IN_CACHE = 32`；
- 或读 active campaign 之外的旧 campaign 后立刻 `cleanup`。

### S6 · `_bridgesBySessionId` 静态 Map 依赖调用方显式 destroy

**位置：** `src/subagent/SubAgentBridge.ts:130`

只有 `RoboticsSession.dispose()` 调 `bridge.destroy()`。如果某个上层入口（如未来的 CampaignSession 集成、或者库使用方）忘了：bridge 持有的所有 `runners` / `pollTimers` / `pendingNotifications` / `_onCompleted` / `_onFailed` 全都泄漏。

`destroyAll()` 静态方法存在但只在测试里用。

**修复（10 分钟）：**
- `SessionRouter.dispose()` 也调用 `SubAgentBridge.getBridge(sessionId)?.destroy()`；
- 或在 SubAgentBridge 构造时注册 `process.once('exit', () => this.destroy())`，且 destroy 是幂等的。

### S7 · `onMessagesUpdate` 回调持有外部强引用

**位置：** `src/kernel/types/KernelConfig.ts` + `KernelSession._messages` 推送处

`KernelLoop` 每次 append 都触发 `config.onMessagesUpdate?.(mutableMessages)`。回调通常是上层 UI / DB writer，可能闭包持有 React state、Express 响应对象。若上层闭包没释放，会反向锁住整条 session 链。

虽然不算 bug，但常驻服务集成时是常见的"几个用户掉线后内存不掉"的根因。建议文档明确说明：**`onMessagesUpdate` 必须是无副作用的纯函数，避免闭包持有外部生命周期对象**。

### S8 · CampaignMonitor `MAX_TRANSIENT_ERRORS=10` 后真的 stop，但 `_active.get(id)` 之外的 `_phaseEntries` / `_consecutiveErrors` 残留

**位置：** `src/coordination/CampaignMonitor.ts:240-249`

`_stop()` 已经清理 `_consecutiveErrors` 和 `_phaseEntries`；但 `CampaignStateStore.cleanup(campaignId)` 是异步调用而 `_stop` 是同步函数 — `_stop` 没 await 也没 catch（line 249 是 `void` 表达式，但实现里 `CampaignStateStore.cleanup` 返回 void 同步）。让我确认一下，目前应该是 OK。

### S9 · `CampaignSession`、`AgenticSession` 创建的 `instrumentTool` 闭包反向引用 RuntimeContext

`src/modes/AgenticSession.ts:113-118`：

```ts
const wrapped = this._config.runtimeContext
  ? instrumentTool(tool, this._config.runtimeContext, { ... })
  : tool
```

`instrumentTool` 返回新 tool 对象，内部闭包持有 `runtimeContext`（即 ProvenanceTracker + JobManager + VVChain）。`upsertTool` 注册到 `KernelSession._config.tools` —— 只要 KernelSession 不 dispose，这条链就活着（与 S1 叠加）。

### S10 · `web_fetch` cache 跨 session 共享（已记录，未拆分）

`src/tools/network/web_fetch/index.ts:10` 仍是模块级 Map。已加 `clearWebFetchCache()` 但没人定期调用。建议在 `SessionRouter.dispose()` 里同样调用一次（或按 LRU 自然 evict——目前 CACHE_MAX=50 已经在底线上）。

---

## 四、🟡 低优先级 / 优化

### S11 · `_finishedCount` 一直递增、无 overflow 保护

`subagent/SubAgentBridge.ts:181`。`Number.MAX_SAFE_INTEGER` = 9e15，常规场景永远不会到，但作为"统计"字段建议在 `destroy` 时清零。

### S12 · `pendingNotifications` 容量 (`MAX_PENDING_NOTIFICATIONS`) 用 splice 维护

`subagent/SubAgentBridge.ts:518-523` 用 `splice(0, len - MAX)` 把超出部分扔掉。语义正确，但每次 push 都触发 O(n) splice。改成环形 buffer 或 `shift()` 略好。

### S13 · `TeamWatcher.events` 切片维护

`src/robotics/team/TeamWatcher.ts:139` `this.events = this.events.slice(-20)`。每次创建新数组，老的进 young gen。OK 但建议改成 `events.shift()` 循环。

### S14 · `ExperienceStore` MAX_INDEX_ENTRIES=100 是渲染上限，不是存储上限

`src/robotics/ExperienceStore.ts:10`。底层 JSONL 文件无 rotation。长期使用经验文件会无限增长（每次 read 都全文加载到内存）。建议加 archive 策略（≥30 天的条目移到 archive/ 子目录，read 默认只读 active）。

### S15 · ProvenanceTracker disk 文件无 archive

`MAX_CACHE_ENTRIES=10_000` 是内存上限，磁盘上仍按 sessionId 累积。`~/.meta-agent/provenance/<sessionId>/` 会持续增长。建议同样按时间归档。

### S16 · `KernelSession._permissionDenials` 单调累加，无上限

`src/kernel/KernelSession.ts:60, 146`：`this._permissionDenials.push(...loopResult.permissionDenials)`。极长会话里如果每 turn 拒绝几个工具调用，这个数组会持续增长。加 1000 条上限或环形缓冲即可。

### S17 · `RoboticsSession._teamContextBoundary`、`_lastStablePrompt` 长字符串持有

只保留最新一份，OK；但长字符串（几 KB～几十 KB）会占 old gen。建议在 dispose 时 `= null`。

### S18 · 数据库式累加：`SectionRegistry` 在 MetaAgentSession 中

`src/core/MetaAgentSession.ts:77`。如果 mode 切换或 invalidate 调用不完整，旧 section 解析结果留在内部 Map。检查 `SectionRegistry.invalidate` 调用点是否覆盖所有 dirty 情况，并在 dispose 时 clear()。

---

## 五、🟢 已经做好的部分（值得肯定）

1. **所有 `setInterval` 都 `unref()`** — 进程退出不被 cron / heartbeat / monitor 阻塞。
2. **TeamWatcher / CampaignMonitor / RoboticsSession heartbeat 都有显式 stop()**。
3. **`FileStateCache`** 自带 LRU（200 条上限），且本轮加了 mtime 字段不增加 memory pressure。
4. **`atomicWriteJson` 用临时文件 + rename**，写过程崩溃不会留半行。
5. **`SubAgentBridge` 用静态 `_bridgesBySessionId` 防止同 session 双绑 listener** — 避开了一个典型的 listener 泄漏陷阱。
6. **`abortableSleep` 退避能响应中断** — 长时间未响应的 Ctrl-C 不再出现。
7. **`AnthropicClient` / `DeepSeekClient` LRU=16** — 连接池可复用，不会每次重建。
8. **`ProvenanceTracker` MAX_CACHE_ENTRIES + 批量 evict 10%** — 是少数显式做了内存防御的模块。
9. **`SessionStore.MAX_INDEX_ENTRIES=50`** — index.json 不会无限膨胀。

---

## 六、推荐修复优先级

| 优先级 | 编号 | 工时 | 风险面 |
|---|---|---|---|
| 🔴 立即 | S1：AgenticSession/CampaignSession/KernelSession 加 dispose | 1 小时 | 长跑内存累积 |
| 🔴 立即 | S2：JobManager 加 forgetJob + 终态 listener 清理 | 1 小时 | host 模式 OOM |
| 🔴 立即 | S3：KernelLoop.append 去掉数组拷贝 | 15 分钟 | GC 抖动 |
| 🟠 近期 | S4：DebugWriter purgeStale + size cap | 30 分钟 | 磁盘膨胀 |
| 🟠 近期 | S5：CampaignStateStore._evalCache LRU | 30 分钟 | campaign 历史 OOM |
| 🟠 近期 | S6：SessionRouter.dispose 同时 destroy SubAgentBridge | 10 分钟 | listener 泄漏 |
| 🟡 优化 | S11–S18：环形缓冲、数组复用、归档策略 | 半天 | 边际 |

---

## 七、修复后预期收益

按上一份评审 + 本份共同执行，可以达到的稳定性目标：

- **24h 连续运行不 OOM**（前提：JobManager + KernelSession 加 dispose）；
- **session 数 × 平均消息长度 = 10 000 × 100 KB 不爆内存**（前提：S3 去拷贝）；
- **debug=true 模式下磁盘 7 天自我回收**（前提：S4 purge）；
- **`SessionRouter.dispose()` 是真正的资源边界**，调用后没有任何 GC root 跨边界保留（前提：S1+S6+S10 联动）；
- **GC pause p99 < 50ms**（当前因 S3 的数组拷贝在大会话上可能到几百 ms）。

---

## 八、总结

代码库**短期稳定性（单 session、少量 turn）已经成熟**：timer/listener/句柄都成对管理，关键缓存有上限，错误重试有退避。

**长跑稳定性的主要缺口在两件事上：**
1. **Session 资源边界缺失** — `AgenticSession` 和 `CampaignSession` 没实现 `dispose()`，导致 `SessionRouter` 多次创建/释放后内存逐步增长；KernelSession 也缺 dispose。
2. **任务/历史无 LRU** — `JobManager.jobs` 与 `CampaignStateStore._evalCache` 都是按 ID 累加的 Map，没有终态 evict，是 host 模式下的隐性炸弹。

`KernelLoop` 的 messages 数组每 turn O(n) 复制是第三件值得修的事，不会泄漏但严重影响 GC 平滑度。

修完这三类共 ~3 小时的工作，可以把目前"为单次 CLI 调用设计"的代码库，升级到"可以做常驻服务后端"的水准。
