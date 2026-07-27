# meta-agent 全方位代码审核报告（长期稳定运行视角）

日期：2026-06-10 ｜ 范围：kernel 机制、CLI 交互、资源调度、内存管理
基线：`npx tsc --noEmit` 通过；`vitest run` 484/484 通过。

---

## 总体评价

代码库整体质量很高：自动压缩有熔断器与 PTL 重试、子代理有并发/队列/预算三重上限、终态任务有 LRU 与 TTL 清理、记忆系统有行/字节双重截断、API 客户端的退避 sleep 可被 abort 打断、JSON 持久化为原子写 + 按 taskId 串行链。大量 `S*`/`P1-*`/`H*` 注释表明此前已做过多轮稳定性整改。

以下按严重程度列出本次发现的问题。

---

## P0 — 可使整个进程崩溃/任务错误终止

### 1. 工具超时后的 unhandled rejection 会杀死整个 CLI 进程

`src/kernel/tools/ToolExecution.ts:152-169`

超时通过 `Promise.race([callPromise, timeoutPromise])` 实现。超时分支 reject 后，
**`callPromise` 成为无人观察的 promise**。对不感知 abortSignal 的工具（自定义工具、
某些 MCP 调用），其底层操作继续运行，之后一旦 reject（网络错误、子进程失败），
就触发 `unhandledRejection`。

而 CLI 注册了：

```ts
// src/cli/index.ts:3083
process.once('unhandledRejection', (e) => { void disposeAndExit(1, e) })
```

→ 一次工具超时 + 延迟失败 = 整个长跑会话退出。这是当前对"长时间稳定运行"
威胁最大的单点。

**修复**（一行）：race 之前或超时触发时挂上观察者：

```ts
const callPromise = tool.call(parsedInput, callContext)
callPromise.catch(() => {})   // 防止 race 落败方变成 unhandled rejection
```

### 2. 压缩后保留消息中的陈旧 `usage.inputTokens` 污染 token 估算

`src/kernel/api/TokenCount.ts:20-35` + `src/kernel/loop/KernelLoop.ts` + `PostCompact.ts`

`tokenCountWithEstimation` 优先读取**最近一条 assistant 消息的 `usage.inputTokens`**。
但 `buildMessagesToKeepAfterCompact` 原样保留当前轮的 assistant⇄tool_result 尾部——
**`usage` 字段未被剥离**，其中 `inputTokens` 反映的是压缩前的完整上下文（可能 ≈ 18 万）。

后果链（已逐行核对，`MessagesToKeepAfterCompact.test.ts` 未覆盖此场景）：

- **反应式压缩被废掉**：PTL 触发 → 反应式压缩成功 → `continue` → 循环顶部
  `shouldAutoCompact` 用陈旧估算（仍 > 窗口）→ 再次压缩（对摘要做摘要，浪费一次
  flash 调用）→ 阻塞检查仍用陈旧估算 → `isAtBlockingLimit` → 本轮以
  `blocking_limit` 失败——**尽管上下文实际已被压小**。
- **主动压缩误终止**：autocompact 阈值与 blocking limit 之间只有 ~10k 余量。
  一轮内大 tool_result 把估算从阈值下方顶过 blocking limit 时，压缩虽然执行了，
  同一迭代内的阻塞检查仍读旧值 → 误报 PROMPT_TOO_LONG 终止。
- `compact_boundary` 事件的 `previousTokens` 显示也失真。

**修复**：二选一（推荐前者）：
1. `buildMessagesToKeepAfterCompact` 返回前克隆 assistant 消息并删除 `usage`；
2. `tokenCountWithEstimation` 反向遍历时遇到 `isCompactSummary`/`isCompactBoundary`
   即停止信任 usage，改用 roughTokenCount。

---

## P1 — 影响正确性/可观测性

### 3. AnthropicClient 流中途重试会重放已 yield 的事件

`src/kernel/api/AnthropicClient.ts:216-268`

重试循环包裹了**整个流消费**。若流在产出若干事件后才出错且可重试，重试会重新发起
请求并从头 yield：

- 终端上用户看到重复的文本输出（accumulator 的 block 会被 `content_block_start`
  重置，历史不受损，但 UI 重复）；
- 极端情形：首条消息已 `message_stop`（已计入 assistantMessages 与 usage/cost），
  之后流再出错并重试 → 同一回复被推入两份、费用双计。

**修复**：一旦从流中 yield 过任何事件，就不再走重试分支（记录 `yieldedAny` 标志，
直接抛给 KernelLoop 的 stream-error 恢复机制处理——那条路径本来就会注入错误并重试，
且不会重放 UI）。

另：`DebugWriter` 仅在正常 return / catch 中关闭；消费者中途 `break`/抛弃 generator
时文件句柄泄漏（仅 debug 模式）。建议用 `try/finally` 包住流循环。

### 4. FileStateCache 名为 LRU 实为 FIFO

`src/kernel/session/FileStateCache.ts:33-40`

`Map.set` 对已存在的 key **不改变插入顺序**，`record()` 重读文件不会刷新其"新近度"；
淘汰 `keys().next()` 删除的是最早首次读取的条目。长会话中反复读取的热点文件可能先于
冷文件被逐出，使压缩后的"已读文件提醒"丢失热点文件。

**修复**：`record()` 先 `delete(path)` 再 `set(path, …)`。

### 5. KernelLoop 的 api_retry 事件可能永远不被 yield

`src/kernel/loop/KernelLoop.ts:602-652`

`retryEvents` 只在 `for await` 收到下一个流事件时才被 drain。若请求在产生任何流事件
前重试多次后最终失败，所有重试通知丢失——用户只看到沉默后的失败，不知道经历了 5 次
退避。建议在 catch/循环后补一次 drain。

---

## P2 — 长期运行的缓慢退化与边界

### 6. CLI `seenTeamReminderEvents` 无上限增长

`src/cli/index.ts:2701,2749-2754`。45s 轮询，每个 team 事件 key 永久留存。
周级 robotics 会话会缓慢累积。建议加上限（如保留最近 2000 条）或按时间戳剪枝。

### 7. `withRetry`（src/kernel/api/Retry.ts）是死代码

全仓无调用方（AnthropicClient/DeepSeekClient 各自内联了带 abort 的重试）。
其 `sleep` 不感知 abort，若未来被复用是隐患。建议删除或补上 abortableSleep。

### 8. no-progress 守卫可被交替循环绕过

`KernelLoop.ts:930-951` 只统计**连续相同**的工具签名。模型 A→B→A→B 振荡时
计数器不断复位，只能靠 maxTurns/预算兜底。可改为对最近 N 个签名做窗口去重统计。

### 9. 转向（steer）消息会顶替压缩锚点

steer 以 `isMeta: false` 注入（必要——需要模型读到），因此成为"最后一条真实用户
消息"。压缩时 `buildMessagesToKeepAfterCompact` 逐字保留的用户文本将是这条纠正
指令而非原任务。原任务靠摘要与首条用户锚点间接保留，多数情况可接受，但值得知晓：
长任务中段 steer 后立刻压缩，模型对原任务的把握会变弱。可考虑同时保留最后一条
非 steer 的真实用户消息。

### 10. 退出路径缺少硬超时

`disposeAndExit`（cli/index.ts:3071-3079）await `router.dispose()` 无超时。
SubAgentBridge 自带 10s 上限，但 robotics 的 git/worktree 清理等若挂起，进程
将永不退出。且 `process.once` 意味着 dispose 期间的第二个异常无人处理。
建议：`setTimeout(() => process.exit(code), 15_000).unref()` 兜底。

---

## 专项评估

### CLI 交互
质量好：bracketed paste + PasteAccumulator 解决了粘贴误提交；SIGINT 双击退出 +
300ms 输入排空窗口；steer（Ctrl+G）通过 race 不中断流；terminal sanitizer 防转义
注入；输出有 50k 字符可见上限 + drain 背压。问题见 #6、#10。

### 资源调度
- **SubAgentBridge**：并发(4)/队列(64)/总预算三重闸 + 预算预留/结算、启动节流、
  陈旧任务启动时标失败、dispose 带 10s 等待——设计完善。
- **JobManager**：终态任务 LRU(200) + 持久化重试(3 次退避) + 失败兜底标记，
  awaitJob 对"无 result 的终态"立即 reject 防永久挂起——良好。
- **ToolOrchestration**：并发批次受 env 钳制 [1,64]；executeToolCall 全路径捕获
  （除 #1 的 race 泄漏）。
- 子代理 5 分钟墙钟上限 + 工具 3 分钟默认超时构成双层防挂。

### 内存管理
- 进程内：消息数组靠压缩收敛（S3 消除了每轮 O(n) 拷贝）；权限拒绝上限 1000；
  通知队列上限 100；Anthropic 客户端缓存 LRU(16)；provenance 热缓存 10k 条
  批量逐出；写链 `releaseWriteChain` 防 promise 链累积。dispose 链
  （KernelSession→AgenticSession→MetaAgentSession→Router→CLI）完整。
- Agent 记忆：MEMORY.md 200 行/25KB 截断、topic 文件 24KB/总量 64KB 上限、
  扫描上限 500 文件——均有界。
- 残留点见 #4、#6。

---

## 建议修复顺序

| 优先级 | 项 | 工作量 |
|---|---|---|
| P0 | #1 callPromise.catch 防 unhandled rejection | 1 行 |
| P0 | #2 剥离 messagesToKeep 的 usage（+ 回归测试） | ~20 行 |
| P1 | #3 流中途已 yield 则禁用客户端层重试；DebugWriter finally | ~15 行 |
| P1 | #4 FileStateCache 真 LRU | 2 行 |
| P1 | #5 retryEvents 失败路径补 drain | ~5 行 |
| P2 | #6/#7/#8/#9/#10 | 各 ≤20 行 |
