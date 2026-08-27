# meta-agent 全量代码评审 — 修复记录

> 日期：2026-08-27
> 版本：0.9.4
> 基线提交：`6c47986`
> 对应评审：[meta-agent-全量代码评审-2026-08-27.md](./meta-agent-全量代码评审-2026-08-27.md)

## 1. 结论

评审列出的 P0 / P1 / P2 / P3 共 13 项，以及测试与工程质量 3 组，已全部修复并配套回归测试。

验证状态：

```text
npm run typecheck        PASS
npm run version:check    PASS
npm run check:manifest   PASS
npm test                 294 files / 3282 tests，全绿
npm run test:integration  11 passed + 6 passed，全绿
```

对比修复前基线（284 files / 3180 tests，4 files / 6 tests 失败），新增 10 个测试文件、102 个测试用例。

## 2. 逐项修复

### P0-1 Store ID 路径穿越

新增 `src/infra/persist/storeId.ts`，提供两道彼此独立的防线：

- `validateStoreId()` —— 对**输入**做白名单校验。除 `..`、路径分隔符、绝对路径、NUL 之外，还拒绝 Windows 特有的别名形式（盘符 `C:`、NTFS ADS `name:stream`、会被 Win32 静默去除的结尾点和空格），并限制单段长度 200 字节。
- `resolveWithinRoot()` —— 对**输出**做 containment 检查。用 `resolve()` + `relative()` 判定，覆盖多段拼接、符号链接根目录，以及白名单未预见的情况。

两者都 fail closed，抛 `StoreIdError` 而非清洗输入 —— 静默改写 ID 会让两条逻辑上不同的记录落到同一个文件，把一次响亮的失败换成一次安静的数据丢失。

应用范围超出评审列出的位置，覆盖了同类的全部实例：

| 位置 | 处理 |
| --- | --- |
| `JobStore` | constructor / save / load / delete 全部校验；`loadAll()` 过滤非法目录项而非整体失败 |
| `SessionStore` | `sessionDir()` / `historyPath()` 校验；`sessionExists()` 对非法 ID 返回 false 而不抛（谓词应当回答"否"）；`deleteSessions()` 过滤后再删，一个坏 ID 不会中断整批删除 |
| `CampaignStateStore` | 同类问题，campaign ID 同样进入递归 `rm()` |
| `DebugWriter` | 同类问题，但改为**返回 null 而非抛出** —— 它位于模型调用路径上（`AnthropicClient` 在首个请求前打开它），抛出会把"调试日志配置错误"升级成"API 调用失败" |

`validateStoreId` / `isValidStoreId` / `resolveWithinRoot` / `StoreIdError` 从包根导出，供自行生成 ID 的调用方复用同一规则。

**回归测试**：`storeId.test.ts`（22 例）、`JobStorePathSafety.test.ts`（6 例）。后者直接复刻评审的复现调用，并断言相邻文件字节不变。

### P1-1 Job 状态写入乱序

`RuntimeJob` 新增 per-job `persistChain`，每次 `_transition()` 把写入挂到该 Job 上一次写入之后，而不是与之竞争。非终态转换仍然立即返回（模型到终端的路径不该付磁盘延迟）；终态转换 await 整条链，因为链是 FIFO，这同时保证了此前所有写入都已落盘。

`EngineeringJob` 增加单调 `revision`（可选字段，旧记录读作 0），`_persistSnapshot()` 拒绝低于已落盘 revision 的快照。写链已经解决进程内顺序，revision 是给绕过链的路径兜底 —— `_persistWithRetry` 的尽力而为尾部写入，以及未来可能直接持久化的调用方。

链在单个链节失败后仍然存活（`persistPromise.catch(() => false)`），一次持久化错误不会卡死该 Job 后续所有写入。

**回归测试**：`JobManagerRecovery.test.ts` 中 6 例。核心一例注入评审描述的确切时序偏斜 —— 让 `running` 写入慢 60ms、`completed` 写入快 —— 并断言磁盘终态为 `completed`。

### P1-2 `loadSession()` 中断归一化

抽出 `_normaliseInterruptedJob()`，`reattach()` 与 `loadSession()` 共用。写入 `failed`、`completedAt`、`wallTimeMs` 和明确错误原因，并在**注册进内存之前**持久化 —— 这样任何并发的 `poll()` / `awaitJob()` 都观察不到"已中断但无 Executor"的中间状态。

持久化失败时仍然注册归一化后的内存记录：对等待 `awaitJob()` 的调用方来说，拿到确定的拒绝比磁盘副本是最新的更重要，而下一轮恢复会再次归一化。

文件头的崩溃一致性契约同步更新 —— 它此前声称两条路径都会归一化，而实际只有一条，这个谎言正是缺陷本身。

**回归测试**：8 例，覆盖三种 `ACTIVE_STATUSES`、`awaitJob()` 确定性拒绝（用定时器 race，回归会失败而不是挂起整个套件）、终态记录不被误改，以及 `reattach()` 与 `loadSession()` 的结果一致性。

### P2-1 进度监听器异常隔离

两层防护：

- `JobManager.onProgress` 逐个 try/catch 每个监听器，异常只进 `console.warn`；
- `JobExecutor` 的 `reporter` 也包了一层，覆盖任何其它 `ExecutorCallbacks` 实现。

顺带修了同类的一处：`callbacks.onStarted(jobId)` 在 `this.running++` 之后同步调用且无保护，抛出会逃逸出 `_run()` 并永久泄漏一个并发槽位。

**回归测试**：3 例，含"抛出的监听器排在健康监听器之前时，后者仍然收到全部进度"，以及"隔离不等于沉默"（诊断日志必须留痕）。测试用 gate promise 让 handler 等待观察者注册完毕，否则断言会空洞地通过。

### P2-2 并发参数校验

新增 `ExecutorConfigError`，constructor 用 `requirePositiveInt` / `requireNonNegativeInt` 校验，非有限值 / 非整数 / 越界一律抛出而非静默修正 —— 一个接受工作却永不执行的池，比一个拒绝启动的池更糟。

错误信息对 `NaN` 特殊处理（`'NaN (check the parse that produced it)'`），因为 `String(NaN)` 读起来像笔误而不像诊断。

`maxQueued` 默认值改为在校验后基于 `this.maxConcurrent` 计算，避免默认表达式引用未校验的参数。

**回归测试**：5 例，含"修好校验但没弄坏执行器"的正向用例。

### P2-3 严格数字解析

新增 `src/infra/env/strictNumber.ts`。独立成模块是因为三个层次需要同一条规则，而它们不该互相依赖：`RuntimeEnv`、`core/timeouts`（刻意不依赖 RuntimeEnv 以保持 infra→core 单向分层）、以及 `cli/args`。

- 整数：`/^[+-]?\d+$/` 全串匹配，并要求 `Number.isSafeInteger` —— 超过 2^53 解析有损，我们会用的数字将不是写下的数字，拒绝优于四舍五入。
- 浮点：`/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/` 全串匹配，拒绝 `Infinity` / `NaN`。

被拒绝的值会**告警**而非静默吞掉（每个变量每进程最多一次，因为访问器在热路径上）。理由是危险方向的不对称：拼错一个安全上限，读起来正好是"把安全关掉"。

覆盖 `readIntEnv` / `readIntEnvOr` / `readFloatEnv` / `timeouts.envValue` / `--max-turns` / `--max-budget-usd` / `--ui-port`。

**回归测试**：13 例，含评审给出的三个确切字符串，以及 `parseInt` 会静默重新解释的形式（`0x10` → 0、`1e3` → 1、`1.9` → 1）。

### P2-4 有界并发读取

`src/infra/persist/index.ts` 新增 `mapWithConcurrency()`，默认并发 16 —— 按文件描述符预算而非吞吐量选的：macOS 默认 `ulimit -n` 是 256，且恢复过程要与宿主自身的描述符（socket、MCP stdio 管道、日志）共存。

`JobStore.loadAll()` 改用它。结果保序，异常按项捕获，语义与 `allSettled` 一致。

**回归测试**：5 例，含"峰值不超过上限"**且**"峰值大于 1"（否则修复等于把 EMFILE 换成串行恢复）、保序、以及非有限上限回落到默认值。

### P2-5 MCP stderr 上限

两个维度都设限：累积缓冲 1 MiB（未终止行不能无限增长），单行回显 8 KiB（一条巨大日志不能刷屏）。上限远小于 stdout 的 64 MiB，因为 stdout 承载协议载荷、stderr 承载人类可读日志 —— 1 MiB 不换行的诊断文本已经是病态。

超限**不**拆除服务器：stderr 是诊断信息，丢日志远好于因此杀掉一个正常工作的 MCP 连接。溢出时每轮只告警一次。顺带补上了 stderr handler 缺失的 `this._child !== child` 陈旧代次检查。

### P2-6 MCP client 替换

替换收敛为 `registerMcpClient()` 一处，按序执行：装新 → 关旧 → 失效旧缓存。关闭放在替换**之后**，这样重入注册表的 close handler 看到的是新 client 而非半移除的旧 client。

`unregisterMcpClient()` 与 `disposeMcpClients()` 同样补上缓存失效。

配置加载器里的 `mcpClients.delete()` 删除 —— 它不仅泄漏进程和缓存，还运行在 `buildClient()` **之前**，所以一条构建失败的配置会拆掉正在工作的服务器却不放任何东西回去。

**回归测试**：5 例，含"重复注册同一实例是 no-op"（不能关掉活着的 client）。

### P2-7 OTLP 超时、背压与排空

Sink 侧：

- 单飞写链（`inFlight`），任意时刻最多一个请求在途；
- 每请求 10s `AbortSignal` 超时；
- 待发队列上限 32 批，超限丢**最旧**的（collector 慢时，最近的事件才是描述当前故障的那些），并汇总上报丢弃数；
- 成功响应也 drain body，避免 keep-alive 下 socket 与缓冲滞留。

Recorder 侧：用计数器 + barrier promise（而非每事件一个 Promise 对象，那正是无界增长的另一半）跟踪 `observe()` 发起的 fire-and-forget 写入，`finish()` 先排空再写 summary，排空本身有 5s 上限 —— 遥测永远不值得阻塞进程退出。

**回归测试**：6 例，含"collector 永不响应时 `close()` 仍然返回"（用 race 保证回归时失败而非挂起）、"40 批打到停滞的 collector，实际请求 ≤ 6"。

### P2-8 文件锁初始化失败清理

`open` → `writeFile` → `close` 三步包进嵌套 try/finally。初始化失败时关闭 handle 并只删除**本次创建**的 sentinel（`wx` 保证它是我们的，否则 open 会以 EEXIST 失败）。

`close()` 在写入成功后失败**不**撤销获取 —— 字节已在 page cache、mtime 已设置，锁是有效的 —— 但仍然告警，所以用分别处理而非一刀切的 catch。

**回归测试**：5 例。用 `vi.hoisted` + `vi.mock('fs/promises')` 注入故障（`vi.spyOn` 无法 patch ESM 导出）。含描述符泄漏检查：25 次失败获取后，`/proc/self/fd` 增量必须 < 10。

已实测：这 3 个断言对原始代码全部失败、对修复后全部通过。

### P3-1 exit listener 累积

改为具名的 `destroyGlobalStoreOnExit` + `_exitHandlerInstalled` 一次性安装。具名是可移除的前提，标志位是"只装一次"的前提（Node 不替我们去重）。`resetShellSessionStore()` 对称地 `removeListener()`。

**回归测试**：5 例，含 30 轮 create/reset 后监听器数量必须回到基线。

### P3-2 SessionStore 全局索引锁

`append()` / `replace()` 拆成两相：

1. **历史写入**，只持有 per-session 锁。序列化与全量重写（最大 64 MiB）都在这一相，因此不再阻塞其它 session。
2. **索引提交**，持有全局锁，临界区极短。

分歧检测随第一相一起下移。不持索引锁读 `index.json` 是安全的 —— 它只经 `atomicWriteJson` → rename 写入，读者看到的永远是某个完整版本；而在**保护后续写入的同一把锁**下做检查，比原先的安排严格更一致：两个进程 append 同一 session，现在会在 check-then-write 这一对上串行化。

原安排靠持有索引锁横跨两相换来的是"淘汰不能在历史写入与 upsert 之间删掉这个 session"。这一点由两条独立保障接管：

- 淘汰只删除空闲超过 grace window（默认 24h）的目录，而我们刚刚写过它；
- `deleteSession()` 在 `rm()` 前获取该 session 的 history 锁，因此根本无法与第一相交错。

两相**从不同时持有两把锁**，所以该方法不可能与 `loadHistory()` / `deleteSession()`（它们按 index → history 嵌套）构成锁环。

**回归测试**：`SessionStoreConcurrency.test.ts` 7 例，含 12 session 并发持久化后索引无丢失更新、2000 条消息的大 session 走分歧重写路径时小 session 的 append 不被排队、同 session 并发 append 后每行仍是合法 JSON、以及 delete 与 append 竞争时不留半删目录。

### 8.1 macOS 真实路径测试

新增 `src/__tests__/tempDir.ts`，提供 `makeTempDirSync()` / `makeTempDir()`，返回已 realpath 的临时目录。

修复了评审列出的 3 个文件，并在用符号链接 TMPDIR 复现 macOS 条件后，发现并修复了同类的第 4 个（`A1EdgeCases.test.ts` 的 write mutex 用例）。

未对全部 113 个用 `mkdtemp` 的测试文件做无差别替换 —— 只有那些把路径与运行时产物比较、或喂给工作区守卫的测试需要它。

验证方式：`TMPDIR=<symlink>` 下跑全套，294 files / 3282 tests 全绿。

> 注：评审在 macOS 上观察到的 `cli/guards.test.ts` 两例，经复现确认是**测试环境构造的假象** —— 若把符号链接 TMPDIR 指向 `/tmp` 下，会命中 `isWorkspaceLocalPath` 对 `/tmp` 的良性豁免。macOS 真实的 `/private/var/folders/…` 不匹配该豁免，这两例在 macOS 上本就正常。

### 8.2 mock-test 凭证隔离

在**任何 `src/` 导入之前**清除全部 5 个 provider 环境变量，并把 `META_AGENT_HOME` 指向空临时目录（该值在模块求值时捕获，所以隔离块必须位于 import 之上，值导入改为 `await import()`；`import type` 会被编译期擦除，无需改动）。

"无 API key 应抛错"用例不再自己做局部清理 —— 那正是让结果依赖开发者 shell 的原因。

已实测：`ANTHROPIC_API_KEY=... ZHIPU_API_KEY=... DEEPSEEK_API_KEY=... npm run test:integration` → 11 passed / 0 failed。

### 8.3 mock-server 结构化 content

新增 `messageText()`，同时解析 `string` 与 `[{type:'text', text:'…'}]` 两种 content 形态。两者都是真实 API 的一部分，所以两者都处理，而不是把运行时钉回旧格式。

已实测：6 passed / 0 failed（此前工具调用与热注册两例失败）。

## 3. 验收标准对照

| 评审第 11 节标准 | 状态 |
| --- | --- |
| 公开持久化 API 对 `..` / 绝对路径 / 分隔符 fail closed | ✅ 双层防线 + 22 例测试 |
| 任意延迟顺序下磁盘状态不从终态倒退 | ✅ 写链 + revision，注入时序偏斜验证 |
| 重启后无无 Executor 的活动 Job，`awaitJob()` 立即有确定结果 | ✅ 共用归一化，race 定时器验证 |
| 观察者回调抛错不改变业务状态 | ✅ 两层隔离 + 诊断留痕 |
| 并发数 / 超时 / 预算拒绝 `NaN`、Infinity、非法后缀、越界 | ✅ `ExecutorConfigError` + `strictNumber` |
| Job 恢复 / 遥测 / MCP 缓冲有明确数量或字节上限 | ✅ 16 并发 / 32 批 + 10s / 1 MiB + 8 KiB |
| 重复创建重置全局资源不增加 process listener | ✅ 30 轮循环验证回到基线 |
| `npm test`、`test:integration`、`typecheck` 全绿 | ✅ |
| 回归测试含故障注入与确定性并发时序 | ✅ 见各项说明 |

## 4. 说明

本次修复未改变任何公开 API 的成功语义。唯一的行为收紧是：非法 store ID 现在抛 `StoreIdError` 而非静默写到预期之外的位置，非法并发配置现在抛 `ExecutorConfigError` 而非静默变成 `NaN`。两者都是评审明确要求的 fail-closed 方向。
