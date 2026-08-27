# meta-agent 全量代码评审报告

> 日期：2026-08-27  
> 版本：0.9.4  
> 基线提交：`6c47986`  
> 关注点：代码稳定性、性能、资源开销、健壮性、边界条件与逻辑 Bug

## 1. 结论

当前版本不建议在修复 P0/P1 问题前直接发布。

本轮确认：

- P0 严重问题 1 个；
- P1 高风险问题 2 个；
- P2 中风险问题 8 个；
- 测试与工程质量问题 3 组。

其中 5 个问题已通过最小脚本动态复现。最高风险集中在：

1. 持久化 ID 没有路径边界校验，可覆盖或删除目标根目录之外的数据；
2. Job 状态写入没有按 Job 串行，已完成任务可能被旧的 `running` 状态覆盖；
3. 进程重启后，`loadSession()` 恢复出的活动 Job 没有执行中断归一化，等待者会永久挂起。

整体工程基础较好：TypeScript 类型检查通过；原子写入、文件锁、流式请求 watchdog、工具结果大小限制和多数资源清理路径已经形成统一设施。当前问题主要出现在这些设施之间的生命周期衔接处，而不是基础能力完全缺失。

## 2. 评审范围与方法

### 2.1 范围

本轮覆盖当前会进入实际执行链路的运行时代码，包括：

- Kernel、Session、Job 与 Sub-agent 生命周期；
- 文件持久化、锁、恢复与清理；
- 工具执行、文件工具、MCP；
- Provider 调用、超时、流式 watchdog；
- Telemetry、CLI 参数与运行时环境变量；
- Graph Loop、Robotics、Reviewer、Evaluation 等生产模块；
- 完整测试、mock 集成测试与发布检查。

按要求，本报告只覆盖当前会进入执行链路的生产模块；尚处开发阶段且当前不会执行的模块不纳入结论，也不列出相关发现。

### 2.2 代码规模

- TypeScript 文件：769 个；
- TypeScript 总行数：161,474 行；
- 测试文件：284 个；
- 审查基线：`6c47986`。

### 2.3 验证手段

- 静态走读核心状态机、持久化、并发、超时和清理路径；
- `npm run typecheck`；
- 完整 `vitest`，并在沙箱外重跑需要本地 TCP 监听的测试；
- `npm run test:integration`，使用空的临时 `META_AGENT_HOME` 隔离用户配置；
- `npm run version:check`；
- `npm run check:manifest`；
- 对高风险问题编写临时最小复现脚本，不修改仓库源码。

## 3. 维度结论

| 维度 | 结论 | 主要风险 |
| --- | --- | --- |
| 稳定性 | 不满足发布要求 | Job 恢复永久等待、终态持久化倒退、锁初始化失败遗留锁 |
| 性能 | 存在可扩展性瓶颈 | 全量并发加载历史 Job、Session 全局索引锁造成跨会话阻塞 |
| 资源开销 | 存在无界增长路径 | MCP stderr、遥测请求、进程监听器、全量文件读取 |
| 健壮性 | 部分回调未隔离 | 进度观察者异常会把成功 Job 变成失败 |
| 边界条件 | 存在严重缺口 | Store ID 路径穿越，`NaN`/带后缀数字被错误接受 |
| Bug | 已确认多个可触发问题 | 路径覆盖、状态回写倒退、恢复挂起、测试环境不隔离 |

## 4. P0 — 严重问题

### P0-1. Store ID 路径穿越，可覆盖或删除根目录外的数据

**位置**：

- `src/jobs/JobStore.ts:23-29`
- `src/core/SessionStore.ts:100-105`
- `src/core/SessionStore.ts:498-508`
- `src/index.ts:99-103`

`JobStore` 直接把 `sessionId` 和 `jobId` 传给 `path.join()`：

```ts
function sessionDir(sessionId: string): string {
  return join(jobsRoot(), sessionId)
}

function jobPath(sessionId: string, jobId: JobId): string {
  return join(sessionDir(sessionId), `${jobId}.json`)
}
```

`join()` 只做路径拼接与规范化，不保证结果仍处于 `jobsRoot()` 内。`SessionStore` 的目录计算采用同一模式，并会在删除时执行递归 `rm()`。

`JobStore` 又是根包公开导出的 API，因此只要调用方把未校验的 ID 传入，就可以突破预期存储边界。

**动态复现**：

```text
new JobStore("..").save({ jobId: "config", ... })
```

在临时 `META_AGENT_HOME` 中，上述调用成功把父目录的 `config.json` 覆盖为 Job 记录：

```json
{"case":"jobstore-parent-overwrite","overwritten":true}
```

**影响**：

- 覆盖运行时配置、状态或其它可写 JSON 文件；
- 破坏恢复数据并造成跨子系统数据污染；
- `SessionStore.deleteSession()` 在类似输入下可能递归删除逃逸后的目录；
- 如果 ID 来源可被外部输入影响，该问题具备安全边界意义。

**修复建议**：

1. 提供统一的 `validateStoreId()`，只接受明确字符集，例如 `[a-zA-Z0-9_-]+`；
2. 拒绝空字符串、`.`、`..`、路径分隔符、绝对路径和 NUL；
3. 使用 `resolve(root, id)` 计算最终路径，并通过 `relative()` 再做 containment 检查；
4. 对所有公开 Store 的 constructor、load、save、delete 入口执行同一校验；
5. 增加路径穿越、Windows 分隔符和双重编码回归测试。

## 5. P1 — 高风险问题

### P1-1. Job 状态写入乱序，终态会被旧状态覆盖

**位置**：

- `src/jobs/JobManager.ts:451-475`
- `src/jobs/JobManager.ts:544-584`
- `src/jobs/JobStore.ts:40-45`

每次 `_transition()` 都独立启动一次 `_persistWithRetry()`：

```ts
const persistPromise = this._persistWithRetry(jobId, { ...rt.job })
```

活动状态写入为 fire-and-forget；终态只等待自己的 `persistPromise`，不会等待同一 Job 之前的写入完成。原子 rename 只能防止文件内容撕裂，不能保证多个独立写入按状态机顺序落盘。

**动态复现**：人为让 `running` 写入比 `completed` 慢，最终结果为：

```json
{
  "writes": ["submitted", "completed", "running"],
  "finalPersistedStatus": "running"
}
```

此时 `awaitJob()` 已向调用方返回成功，但重启后磁盘记录显示任务仍在运行。

**影响**：

- 已完成 Job 在恢复时被误判为中断或卡死；
- 完成结果与持久化状态不一致；
- 可能触发重复执行、错误告警或永久等待；
- I/O 延迟、失败重试和网络文件系统会显著放大触发概率。

**修复建议**：

- 为每个 `jobId` 建立单独的持久化 Promise 链；
- 终态写入必须排在此前写入之后，并等待链完成；
- 在记录中增加单调 `revision`，拒绝旧 revision 覆盖新 revision；
- 增加“旧状态延迟完成后不能覆盖终态”的确定性测试。

### P1-2. `loadSession()` 不归一化中断 Job，`awaitJob()` 永久挂起

**位置**：

- `src/jobs/JobManager.ts:18-22`
- `src/jobs/JobManager.ts:336-354`
- `src/jobs/JobManager.ts:402-422`
- `src/jobs/JobManager.ts:430-447`

文件头明确声明 `loadSession()` 与 `reattach()` 都会把进程中断时仍为活动状态的 Job 归一化为 `failed`。实际只有 `reattach()` 实现了该逻辑；`loadSession()` 直接把 `submitted/queued/running` 放回内存。

这些 Job 已经没有对应 Executor。`awaitJob()` 看到非终态状态后仍会注册 resolver，但后续没有任何代码能够触发它。

**动态复现**：

```json
{
  "loadedStatus": "running",
  "poll": "running",
  "awaitOutcome": "still-pending"
}
```

**影响**：进程重启后的批量恢复路径可能永久阻塞调用方，并使活动 Job 数量持续增长。

**修复建议**：

- 抽取 `normaliseInterruptedJob()`，由 `reattach()` 和 `loadSession()` 共用；
- 写入 `failed`、`completedAt`、`wallTimeMs` 和明确错误原因；
- 在注册进内存前先持久化归一化结果；
- 为所有 `ACTIVE_STATUSES` 增加批量恢复测试。

## 6. P2 — 中风险问题

### P2-1. 进度监听器异常会改变 Job 业务结果

**位置**：

- `src/jobs/JobManager.ts:213-220`
- `src/jobs/JobExecutor.ts:181-183`
- `src/jobs/JobExecutor.ts:230-253`

`JobManager` 同步调用每个进度监听器，没有隔离监听器异常：

```ts
for (const listener of rj.progressListeners) listener(p)
```

异常会从 `reportProgress()` 返回到 Job handler，随后被 Executor 当作 handler 失败处理。

**动态复现**：一个监听器抛出 `observer exploded` 后，原本会成功的 Job 状态变为 `failed`。

**修复建议**：逐个捕获观察者异常；错误只进入诊断日志或回调错误通道，不能改变 Job 状态。

### P2-2. 并发参数接受 `NaN`，导致任务永远排队且队列上限失效

**位置**：`src/jobs/JobExecutor.ts:94-142`

```ts
this.maxConcurrent = Math.max(1, Math.floor(maxConcurrent))
this.maxQueued = Math.max(0, Math.floor(maxQueued))
```

`Math.max(..., NaN)` 仍为 `NaN`。之后：

- `running < maxConcurrent` 永远为 `false`；
- `queue.length >= maxQueued` 永远为 `false`。

结果是所有任务只入队、不执行，队列保护同时失效。

**动态复现**：

```json
{"started":0,"freeSlots":null,"totalPending":1}
```

其中 JSON 中的 `null` 来自 `NaN` 序列化。

**修复建议**：constructor 首先验证 `Number.isFinite()` 和 `Number.isInteger()`；无效输入应抛出配置错误，不应静默修正。

### P2-3. 数字解析接受非法后缀，配置笔误可能关闭安全上限

**位置**：

- `src/infra/env/RuntimeEnv.ts:58-102`
- `src/core/timeouts.ts:283-289`
- `src/cli/args.ts:397-415`

`parseInt()` 和 `parseFloat()` 接受前缀合法、后缀非法的字符串。例如：

- `META_AGENT_JOB_TIMEOUT_MS=0oops` 被解析成 `0`，关闭 Job watchdog；
- `--max-turns=3junk` 被接受为 3；
- `--max-budget-usd=1oops` 被接受为 1。

**修复建议**：整数使用严格正则加 `Number()`，浮点使用完整字符串校验；错误配置应告警或拒绝启动。

### P2-4. Job 历史恢复使用无界并发读取

**位置**：

- `src/jobs/JobStore.ts:60-70`
- `src/jobs/JobManager.ts:430-446`

`loadAll()` 对目录内全部 Job 文件直接执行 `Promise.allSettled(ids.map(...))`。Job 文件没有磁盘级数量上限，终态 LRU 只限制内存 Map，并不清理磁盘。

长生命周期 Session 重启时可能同时打开数千个文件，造成：

- `EMFILE`；
- 大量 Promise、字符串和 JSON 对象同时驻留；
- 恢复阶段明显延迟；
- 与 P1-2 叠加时，大量历史活动记录不会被淘汰。

**修复建议**：采用固定并发度读取、分页恢复和磁盘 TTL/数量上限。

### P2-5. MCP stderr 缓冲无上限

**位置**：`src/tools/mcp/mcpConfigFile.ts:346-357`

stdout 已有响应字节和未终止行上限，但 stderr 只是不断执行：

```ts
stderrLine += chunk
```

异常或恶意 MCP 服务持续输出但不换行时，字符串会无限增长，最终可能导致 OOM。

**修复建议**：为 stderr 单行和总量设置上限，使用固定大小 ring buffer；超限后截断、降频或终止子进程。

### P2-6. 替换 MCP client 时不关闭旧进程，工具缓存也不会失效

**位置**：

- `src/tools/mcp/registry.ts:228-241`
- `src/tools/mcp/mcpConfigFile.ts:570-579`

`registerMcpClient()` 直接覆盖 Map；配置加载器替换时直接 `delete()`。两条路径都不会关闭旧 stdio client，也没有清除旧的 tool-list cache。

**影响**：旧 MCP 子进程、端口、文件锁可能继续存活；替换后短时间仍可能返回旧工具定义。

**修复建议**：所有替换统一走一个 `replaceMcpClient()`，先关闭旧 client，再失效对应缓存，最后注册新 client。

### P2-7. OTLP 遥测缺少超时、背压和关闭排空

**位置**：

- `src/kernel/telemetry/recorder.ts:68-87`
- `src/kernel/telemetry/sinks.ts:148-172`

Recorder 对每条遥测记录 fire-and-forget；OTLP `fetch()` 没有 AbortSignal 或超时，也没有 single-flight 写链。Collector 卡死时：

- 每达到一个 batch 都可能新增一个未完成 HTTP 请求；
- 长时间运行会积累请求与闭包；
- `finish()` 在写 summary 时可能永久等待；
- 已启动但未跟踪的记录请求不会在关闭时排空。

**修复建议**：增加请求超时、单写链、最大待发送 batch 数和丢弃策略；Recorder 在 `finish()` 中等待已登记的写入完成。

### P2-8. 文件锁初始化失败会遗留锁文件和文件描述符

**位置**：`src/infra/persist/index.ts:289-298`

获取锁时依次执行：

```ts
const handle = await open(lockPath, 'wx')
await handle.writeFile(...)
await handle.close()
```

如果 `writeFile()` 或 `close()` 失败，当前代码不会在 `finally` 中关闭句柄，也不会删除刚创建的锁文件。后续调用只能等待 stale 回收或直接超时。

**修复建议**：锁文件初始化使用嵌套 `try/finally`；初始化失败时关闭 handle，并仅删除本次创建的 sentinel。

## 7. P3 — 性能与生命周期加固项

### P3-1. ShellSessionStore 重置会累积进程 exit 监听器

**位置**：`src/infra/exec/ShellSessionStore.ts:553-569`

每次重新创建全局 Store 都注册新的 `process.once('exit')`；`resetShellSessionStore()` 只销毁 Store，不移除此前注册的监听器。

完整测试稳定触发：

```text
MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
11 exit listeners added to [process].
```

旧监听器还引用全局变量，退出时可能对最新 Store 重复执行多次 `destroyAll()`。

**修复建议**：使用命名的单例 cleanup handler；reset 时显式 `removeListener()`，或永久只注册一次进程级监听器。

### P3-2. SessionStore 的全局索引锁造成跨 Session 头阻塞

**位置**：

- `src/core/SessionStore.ts:362-403`
- `src/core/SessionStore.ts:411-441`

`append()` 和 `replace()` 持有全局 `index.json` 锁期间，还会进行历史序列化、完整 history 重写、索引更新和淘汰目录删除。任一大型 Session 发生 divergence 或 compaction 时，所有其它 Session 的持久化都要等待。

默认恢复允许读取最多 64 MiB 历史；完整重写与 JSON 序列化在全局锁内执行时，会造成明显的跨会话延迟放大。

**修复建议**：缩短全局索引锁临界区；优先在 per-session history 锁下准备写入，再以明确锁顺序进行短索引提交。调整前需补充并发删除与索引淘汰测试。

## 8. 测试与工程质量

### 8.1 完整 Vitest 当前不是全绿

在允许本地 TCP 监听的环境中执行完整测试：

```text
Test Files  4 failed | 280 passed (284)
Tests       6 failed | 3174 passed (3180)
```

剩余 6 个失败集中在 macOS 临时目录的词法路径与真实路径不一致：

```text
/var/folders/...
/private/var/folders/...
```

相关位置：

- `src/tools/fs/workspaceGuard.ts:22-27`
- `src/tools/fs/__tests__/workspaceGuardContainment.test.ts:32`
- `src/tools/__tests__/ApplyPatchTool.test.ts:250-292`
- `src/tools/fs/__tests__/FsTools.test.ts:99-102`

运行时代码执行真实路径规范化是合理的，主要问题是测试仍以词法路径作为 key 和断言值。建议测试预期统一调用 `realpath()` 或公共 canonicalize helper。

### 8.2 mock interface 测试没有完整隔离凭证来源

`examples/mock-test.ts:73-83` 的“无 API key 应抛错”测试只删除 `ANTHROPIC_API_KEY`，但运行时还支持其它 provider 环境变量和 `META_AGENT_HOME/config.json`。

因此在开发机上直接运行时出现 `10 passed / 1 failed`；使用空临时 `META_AGENT_HOME` 并清除所有 provider key 后为 `11 passed / 0 failed`。

建议测试自行保存并清除全部 provider key，同时绑定临时 `META_AGENT_HOME`，不能依赖调用者手工隔离环境。

### 8.3 mock-server 的工具调用场景已与当前消息格式脱节

隔离配置后 mock-server 测试结果：

```text
4 passed, 2 failed
```

失败项为工具调用和热注册。mock server 在 `examples/smoke-test-mock-server.ts:134-136` 只在首条消息 content 为字符串时识别 calculator 场景；当前运行时可以发送结构化 content blocks，因此 server 返回普通文本，测试自然看不到 `tool_use`。

该结果更符合测试 fixture 过期，而不是生产工具调用已经失效：对应 Kernel 与 AgenticSession 单元测试仍覆盖工具事件和完整执行链。

建议 mock server 同时解析字符串和 `[{type:'text', text:'...'}]` 两种格式。

## 9. 已通过检查

```text
npm run typecheck       PASS
npm run version:check   PASS
npm run check:manifest  PASS
```

完整测试中，解除本地监听限制后所有 HTTP MCP、MCP Apps 和 StreamWatchdog 网络测试均通过；先前在受限沙箱中的 `EPERM listen 127.0.0.1` 不属于产品缺陷。

## 10. 建议修复顺序

### 第一批：发布阻断

1. 为所有 Store ID 增加统一校验和最终路径 containment；
2. 为 Job 状态持久化建立 per-job 顺序写链或 revision；
3. 让 `loadSession()` 与 `reattach()` 共用中断归一化逻辑。

### 第二批：稳定性与资源

4. 隔离 Job progress listener 异常；
5. 严格校验并发数、超时和 CLI 数字参数；
6. 对 Job 历史恢复使用有界并发；
7. 为 MCP stderr、MCP client 替换和 OTLP 请求补齐资源上限与关闭协议；
8. 修复文件锁初始化失败清理。

### 第三批：测试与性能

9. 修复 macOS 真实路径测试；
10. 隔离 mock 测试配置与凭证；
11. 更新 mock-server 的结构化消息解析；
12. 缩短 SessionStore 全局索引锁临界区；
13. 消除 ShellSessionStore exit listener 累积。

## 11. 修复验收标准

- 所有公开持久化 API 对 `..`、绝对路径和路径分隔符输入 fail closed；
- 任意延迟顺序下，Job 磁盘状态不能从终态倒退到活动状态；
- 重启恢复后不存在无 Executor 的活动 Job，`awaitJob()` 必须立即得到确定结果；
- 观察者或通知回调抛错不能改变业务状态；
- 所有并发数、超时和预算配置拒绝 `NaN`、Infinity、非法后缀及越界值；
- Job 文件恢复、遥测请求和 MCP 缓冲均具有明确的数量或字节上限；
- 重复创建和重置全局资源不增加 process listener 数量；
- `npm test`、`npm run test:integration`、`npm run typecheck` 全绿；
- 新增回归测试必须包含故障注入和确定性并发时序，而不只覆盖正常路径。

## 12. 说明

本次评审只创建本文档，没有修改运行时代码。动态复现均使用临时目录和内存替身，不触碰用户持久化数据。
