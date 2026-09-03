# meta-agent-runtime 代码评审 v2 — 稳定性 / 可靠性 / 健壮性 / 资源开销 / 终端交互

审查日期：2026-09-02 · 基线 v0.9.7 · 修复后发布 v0.9.8
范围：`src/` 除 `campaign/`、`campaigns/`、`coordination/CampaignMonitor.ts` 等 campaign 相关模块（按要求排除，处于原始开发阶段）
重点深读：`cli/`、`kernel/`、`loop/`、`core/`、`infra/`、`subagent/`、`sandbox/`、`tools/`

**状态：全部 12 项已修复并随 v0.9.8 发布。**
`tsc --noEmit` 干净；`vitest run` 3588 passed / 324 files（修复前 3544 / 316，本轮新增 8 个测试文件、44 条用例）；`npm run test:integration` 6/6 通过。

新增的回归测试都验证过「去掉修复就会失败」：

| 测试文件 | 锁定的问题 |
|---|---|
| `src/cli/__tests__/streamGeneratorOwnership.test.ts` | P0-1 生成器归还（去掉 `abandonStream()` → 3 条中 2 条失败） |
| `src/infra/exec/__tests__/runShellCommandFuse.test.ts` | P1-1 超时第二保险（去掉 `armPostKillGrace()` → 12s 超时失败；有修复时 3.4s 返回） |
| `src/kernel/api/__tests__/retryAfter.test.ts` | P1-2 `Retry-After` 解析与上限 |
| `src/cli/__tests__/textWidth.test.ts` | P1-3 CJK 显示宽度、状态行不换行 |
| `src/cli/tui/__tests__/TaskTuiSignals.test.ts` | P1-4 TUI 信号注册/摘除与终端归还顺序 |
| `src/core/__tests__/SessionStoreTailRead.test.ts` | P2-1/P2-2 尾部读取不丢最新消息 |
| `src/cli/__tests__/terminalSanitizerBidi.test.ts` | P2-4 BiDi / 零宽字符过滤 |
| `src/cli/__tests__/askQuestionEof.test.ts` | P3-1 EOF 兜底 |

---

## 总体判断

这份代码库的工程纪律很高，而且是**有记忆的**：几乎每个防护点旁边都留着「当初为什么会出错」的因果注释（T3 EPIPE、T6 状态行残留、T8 冗余 timer、M2 admission 泄漏、P3-1 exit 监听器堆积、S16 denial 缓冲上限）。`StreamWatchdog`、`runShellCommand`、`withFileLock`、`ToolExecution` 的超时/中止/清理路径，写得比同类项目扎实得多。

因此这一轮的发现集中在**「已建立的正确模式没有被一致地应用」**，而不是缺少概念。三个反复出现的形态：

1. **异步生成器的所有权契约只在一半调用点被遵守。** 代码里到处都是「consumer abandoned 时 finally 会兜底」的假设（`KernelSession.ts:541` 的注释就是明证），但 `finally` 只在 `return()` / `throw()` 被显式调用时才跑。CLI 的手动驱动循环没有调用它 —— 于是那套精心设计的兜底整条不生效。这是本轮唯一的 P0。
2. **「先 kill，再等 close」缺第二道保险。** 进程组被 SIGKILL 之后如果 `close` 不来，Promise 就没有任何出口。
3. **终端宽度/信号处理在 TUI 路径上做对了，在 REPL 状态行和 tasks 入口上没有跟上。** `displayWidth()` 已经存在于 `cli/tui/frame.ts`，但 `thinkingMeter` 仍用 `.length`；`repl.ts` 已经注册了 SIGHUP，`TaskTui` 没有。

---

## P0 — 严重

### P0-1 `cli/stream.ts` 手动驱动生成器时从不调用 `gen.return()` —— 一次异常就永久卡死整个 session

**位置**：`src/cli/stream.ts:183`、`:231`、`:477-479`

```ts
let pending = gen.next()                    // :183
while (true) {
  const raced = ... await pending ...
  const step = raced
  if (step.done) break
  const event = step.value
  pending = gen.next()                      // :231  ← 预取下一步，随后才处理本步
  ...
  switch (event.type) { /* 大量 await safeStdoutWrite(...) */ }
}
} catch (err) {
  if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') return { ... }   // :478 早返回
  throw err                                                       // :479
}
```

`pending = gen.next()` 在处理事件**之前**发出。此后 switch 体内任何一次 throw、或 `ERR_STREAM_PREMATURE_CLOSE` 的早返回，都会在「`pending` 未被消费 + `gen.return()` 未被调用」的状态下离开循环。`for await` 会在 break/throw 时自动调用 `return()`；手写循环不会。

**后果链**（`SessionRouter.submit` → `AgenticSession.submit` → `KernelSession.submitMessage` → `runKernelLoop` 整条挂在各自的 `yield` 上，所有 `finally` 永不执行）：

| 泄漏点 | 位置 | 具体后果 |
|---|---|---|
| `_submitInFlight` 不复位 | `kernel/KernelSession.ts:542` | **此后每次 `submitMessage()` 都抛 `Cannot call submitMessage() concurrently`（`:248`）**。REPL 的 catch（`repl.ts:1675-1679`）只打印 `Error:` 然后继续循环 —— 用户每输入一句都撞同一个错，**只有 `/clear` 能恢复**，而错误信息完全指不到真正原因。 |
| 模型调用租约不释放 | `kernel/api/AnthropicClient.ts:315-321` → `infra/modelCallAdmission.ts:85-102` | `release()` 不调用 → heartbeat interval 继续为一个没人在用的租约续期，**宿主级并发额度永久少一个**（unref 过，所以不会阻止退出，也就不会被发现）。同时 `DebugWriter` 句柄泄漏。 |
| `autoRuntimeTimer` 不清 | `kernel/loop/KernelLoop.ts:2133` | 残留最长 ≈2h（该 `finally` 的注释恰好写了「长驻宿主里会 linger」，但它自己也依赖 `return()`）。 |
| 轨迹 run 永远半开 | `kernel/KernelSession.ts:541-563` | 那段专门为 "consumer abandoned" 写的补录逻辑（`outcome: 'abandoned'`）**结构上不可达**。 |

**触发面**：`ERR_STREAM_PREMATURE_CLOSE` 这一分支的存在说明这条路径在实践中出现过——每命中一次就卡死一次。此外 `safeStdoutWrite` 对非 EPIPE 的流错误会 rethrow（`cli/term.ts:90`，如重定向到磁盘写满 ENOSPC），`JSON.stringify(event.toolInput)`（`:247`、`:303`）遇到异常输入也会抛。

**建议修复**：

```ts
} finally {
  void pending?.catch(() => {})            // 观测掉可能的 rejection（CLI 视 unhandledRejection 为致命）
  await gen.return(undefined).catch(() => {})   // 让整条链的 finally 跑起来
  ...现有清理
}
```
`ERR_STREAM_PREMATURE_CLOSE` 的早返回同样要走这条路径。建议补一条回归测试：让 `submit()` 在第二个事件后抛错，断言随后 `submitMessage()` 不再抛并发错误。

### P0-2（同类，较轻）`KernelSession.ts:419-462` 捕获消费者抛回的异常后也没有关闭内层生成器

```ts
let step = await gen.next()
while (!step.done) { ...; yield event; step = await gen.next() }
} catch (err) { loopError = err }     // :461-462
```
消费者从 `yield event` 抛进来时异常被吞进 `loopError`，但对内层 `gen`（`runKernelLoop`）没有 `return()`，于是 `KernelLoop.ts:2133` 的 `clearTimeout` 不执行。修法同上：`await gen.return?.(undefined).catch(() => {})`。

---

## P1 — 高

### P1-1 `runProcessGroup` 超时 kill 之后没有第二道保险

**位置**：`src/infra/exec/runShellCommand.ts:184-234`

```ts
const timer = setTimeout(() => { timedOut = true; killGroup() }, opts.timeoutMs)   // :184
...
child.on('close', (code, signal) => finish(() => resolve({...})))                  // :221
```

Promise 只在 `close` / `error` 上 settle，而 `close` 要等到**所有 stdio 流关闭**。定时器只 kill 一次、之后不再有任何出口。如果被执行的命令派生了 `setsid` 的孙进程（守护化的 dev server、`nohup`、部分安装脚本），该孙进程逃出进程组、SIGKILL 打不到、并继续持有继承来的 stdout/stderr fd —— `close` 永不触发，**`timeoutMs` 完全失效，bash 工具无限挂起**。abort 路径同理。

这是整个运行时唯一的 shell 入口，被 `bash` / `powershell` / `cron_create` 共用，挂住的是主 kernel loop。

**建议**：kill 之后再挂一个 grace 定时器（2–5 s）；到点用已收到的 `exit`（`exit` 只依赖进程退出，不依赖 fd 关闭）结果强制 resolve，并保留 `timedOut: true` 与「输出可能不完整」的标记。

### P1-2 LLM 重试忽略 `Retry-After` / 限流复位头

**位置**：`kernel/api/AnthropicClient.ts:298-303`，`kernel/api/DeepSeekClient.ts:308-313`

```ts
const base = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS)
const jitter = Math.random() * 0.25 * base
```

固定 1 s→30 s 指数退避，完全不读服务端的 `retry-after` 或 `anthropic-ratelimit-*-reset`。命中配额窗口（典型复位 30–60 s）时，5 次重试会在 ~45 s 内全部打完并全部失败，然后升级成 `AvailabilityFallbackTriggeredError` 触发模型降级 —— 而实际上只要按服务端说的等一下就能成功。对长跑 auto 会话意味着无谓的降级和成本。

**建议**：从 error 的 headers 取 `retry-after`（秒或 HTTP-date），`delayMs = clamp(max(backoff, retryAfterMs), 0, 上限)`；上限单列一个常量，避免恶意/异常的 header 把 agent 挂死。

### P1-3 `ThinkingMeter` 用 `.length` 而非显示宽度截断 —— 中文状态行在窄终端留残行

**位置**：`src/cli/thinkingMeter.ts:145-149`

```ts
const plain = `${spinner} ${label}`                    // 「⠋ 推理中 · ~123 tokens · 4.5s」
const limit = Math.max(1, this.columns() - WIDTH_MARGIN)
if (plain.length > limit) { ... }                     // ← UTF-16 码元数
```

`推理中` 三个 CJK 字符在终端各占 **2 列**，`.length` 只记 1。所以 `plain.length <= limit` 时物理宽度仍可能超过终端宽度 → 自动换行 → `hide()` 的 `\r\x1b[2K` 只擦一行 → **屏幕上留下残行**。这正是文件里 T6 注释要解决的问题，修法却量错了量。

仓库里已经有正确实现：`cli/tui/frame.ts:414 displayWidth()` / `:434 fit()`，注释还专门写了「CJK goal text is the common case here」。

**建议**：把 `displayWidth` / `fit` / `isWide` 从 `cli/tui/frame.ts` 提到 `cli/term.ts`（叶子模块，无循环依赖风险），`thinkingMeter` 与 `frame` 共用。

### P1-4 `TaskTui` 只在 `process.on('exit')` 上 teardown，SIGTERM/SIGHUP 会把终端留在 alt-screen + raw mode

**位置**：`src/cli/tui/TaskTui.ts:92-121`，入口 `src/cli/commands/tasks.ts:165`

```ts
process.stdout.write(ENTER_ALT_SCREEN)
process.stdin.setRawMode?.(true)
process.on('exit', this.onProcessExit)     // :97 —— 唯一的兜底
```

Node 对 SIGTERM / SIGHUP 的**默认动作是直接终止进程，不运行 `exit` 处理器**。`meta-agent tasks` 这条命令路径没有注册任何信号处理器（`tasks.ts` 里 grep 不到 SIGINT/SIGTERM/SIGHUP）。所以：`kill <pid>`、SSH 断开、关掉终端标签 → 用户回到的 shell 处在 alt-screen + raw mode，回显全无、Ctrl+C 不响应，只能 `reset`。

`repl.ts:1318-1324` 已经把这件事做对了（还专门补了 SIGHUP，注释写了 SSH 场景），TUI 路径没有跟上。Ctrl+C 本身没问题（raw 模式下走 `cli/tui/keys.ts:63` 的 ETX 分支）。

**建议**：`TaskTui.run()` 内注册 `SIGTERM`/`SIGHUP`/`uncaughtException` → `teardown()` 后再退出，`teardown()` 里移除；或复用 `repl.ts` 里那套 `disposeAndExit` 的注册逻辑。

---

## P2 — 中

### P2-1 `SessionStore` 尾部读丢弃 `bytesRead`，短读会污染最新的消息

**位置**：`src/core/SessionStore.ts:537-546`

```ts
const buffer = Buffer.alloc(maxBytes)              // 零填充
await fh.read(buffer, 0, maxBytes, info.size - maxBytes)   // ← 返回值被丢掉
raw = buffer.toString('utf-8')
```

POSIX `read()` 允许短读（网络文件系统、文件被并发截断、信号打断）。此时 buffer 尾部保留零填充，`toString` 把 NUL 字符拼进最后若干行 → `JSON.parse` 失败 → 被计入 `dropped` 并只打一条 warn。**丢掉的恰好是最新的消息**，用户看到的是「resume 之后少了最后几轮」。

**建议**：`const { bytesRead } = await fh.read(...)`；`raw = buffer.subarray(0, bytesRead).toString('utf-8')`。

### P2-2 resume 会把最多 64 MiB 历史一次性物化到堆上

**位置**：`src/core/SessionStore.ts:40`（`DEFAULT_MAX_RESUME_BYTES = 64 * 1024 * 1024`）、`:537-563`

`raw` 字符串（中文内容在 V8 里按两字节/字符存，峰值可达 ~128 MB）+ `raw.split('\n')` 的数组 + `parsed` 的对象数组**同时**存活，然后再进 `rehydrateImagesFromStorage` / `normalizeResumedHistory`。对一个交互式 CLI 来说这是很陡的启动内存尖峰，而且发生在用户按下回车之前。

**建议**：改成 `createReadStream` + `readline` 逐行解析（边界处理反而更简单，顺带解决 P2-1），或把默认值降到个位数 MiB —— 消息条数上限（`META_AGENT_MAX_RESUME_MESSAGES`）才是语义正确的闸门，字节数只是防御性兜底。

### P2-3 `SubAgentBridge._dispose` 的超时 Promise 既不 unref 也不清除

**位置**：`src/subagent/SubAgentBridge.ts:562-565`（`DEFAULT_DESTROY_WAIT_MS = 10_000`，`:52`）

```ts
await Promise.race([
  Promise.allSettled(running.map(([, runner]) => runner.wait())),
  new Promise(resolve => setTimeout(resolve, Math.max(0, waitMs))),   // 输了也不清
])
```

即使所有 runner 立刻结束，这个 10 s 定时器仍在事件循环里。退出路径上（`repl.ts` 的 `disposeAndExit` → `router.dispose()`）表现为**按 Ctrl+D 之后要等约 10 秒才出现 "Goodbye"**，看起来像卡死。15 s 的 hardExit 熔断只是让它不至于永远挂着。

**建议**：`const t = setTimeout(...); try { await Promise.race([...]) } finally { clearTimeout(t) }`。

### P2-4 `TerminalSanitizer` 不处理双向文本控制符与零宽字符

**位置**：`src/cli/terminalSanitizer.ts`

状态机把 C0/C1/CSI/OSC/DCS 都剥干净了，但 U+202A–202E（LRE/RLE/PDF/LRO/RLO）、U+2066–2069（isolate）、U+200B–200F、U+FEFF 都是普通可打印码位，原样输出。模型输出、网页内容、工具结果都会经过这里，攻击者可以让终端里**显示的命令和实际字符序列不一致**（Trojan-Source 的终端版本）—— 而 `tool_use` 预览（`cli/stream.ts:303`）正是用户用来判断「要不要批准这条命令」的那一行。

**建议**：在 `normal` 分支里对上述码位直接 `break`（丢弃），或替换为可见占位符 `�`。

---

## P3 — 低 / 可维护性

### P3-1 `askQuestion` 不带 signal 时没有任何超时或关闭兜底
`src/cli/prompts.ts:97-100`。`rl.question` 的回调在 rl 被 `close()` 时不会触发，promise 永挂。REPL 里靠 `rl.on('close')` → `process.exit(0)` 兜住了，但任何非 REPL 的复用者会静默挂死。建议：要么强制要求传 signal，要么在 rl 的 `'close'` 上 reject。

### P3-2 `repl.ts` 里四个近乎同体的 paste 清理函数
`finishPasteNotice` / `clearPasteNotice` / `endCurrentPasteDisplaySegment` / `discardCurrentPasteCandidate`（`:884-945`）。九行几乎逐字相同，差异只有「是否先 render」「是否清 `_pasteSegments`」「是否清 `_pendingOrderedSubmit`」。这里已经是全文件返工最多的地方（T8 注释就在这段）。建议收敛成一个带 flags 的函数，让三处差异变成显式参数而不是靠读者比对。

### P3-3 输入行渲染依赖 readline 私有字段，失效是静默的
`repl.ts:684-726`、`:800-827`、`:841-858` 全程操作 `rl.line` / `rl.cursor` / `rl._refreshLine()`。`_refreshLine` 是 Node 私有 API，代码里写成 `mutableRl._refreshLine?.()` —— 一旦 Node 改名，**不会报错，只会静默降级**：粘贴占位符不刷新、光标乱跳、`[已粘贴N字]` 的原子删除失效。建议启动时自检一次 `typeof (rl as any)._refreshLine === 'function'`，false 时整体降级为「不显示占位符」并在 debug 日志里说明原因。

### P3-4 `processAlive(pid)` 的 PID 复用
`src/trajectory/recorder.ts:~463`。lease 回收用 `process.kill(pid, 0)` 判活，PID 被复用时会把崩溃 holder 的 lease 误判为活的。当前有 mtime 兜底（`LEASE_STALE_MS`）所以最终会回收，风险可接受 —— 记录备查即可；若要彻底，lease 记录里加上进程启动时间（`/proc/<pid>/stat` 的 starttime 或 `ps -o lstart`）。

### P3-5 `ToolExecution` 用字符串匹配判断超时
`src/kernel/tools/ToolExecution.ts:363`：`timedOut: errorMsg.includes('timed out')`。工具自身错误信息里带这个短语（很常见，比如转发下游 HTTP 超时）就会被误标为 kernel 超时，进而影响 `AutoStallGuard` 的判断。建议定义 `ToolTimeoutError` 子类，用 `instanceof` 判定。

### P3-6 `ReadlineOutput._write` 的 drain 等待没有错误出口
`src/cli/repl.ts:139-141`：`this.target.once('drain', done)`。若 stdout 在背压期间 error/destroy，`drain` 不再触发，这个 `_write` 的 callback 永不调用，Writable 就此堵死（后续所有 readline 渲染消失）。实践中被 `cli/term.ts:64-77` 的 stdout error 守卫兜住了（EPIPE 直接 exit，其余 rethrow → uncaughtException → `disposeAndExit`），所以不会真的挂住；但作为纵深防御建议同时监听 `'error'` / `'close'` 并 `callback(err)`。

### P3-7 `stream.ts` 的 steer race 每个事件新建一个永不 settle 的 promise
`src/cli/stream.ts:194`。`steering.waitArmed()` 在未 armed 时把 `_steerNotify` 覆盖为新的 resolve（`repl.ts:1004` 单槽），上一个 promise 从此不可能 settle。`Promise.race` 结算后这些对象会被 GC 回收，所以不是泄漏，但一次长 turn 会产生数千个一次性 promise + 闭包的分配churn。可以把 armed 通知改成一个复用的 `EventEmitter`/单例 deferred。

---

## 做得好、建议保持的地方

- **`kernel/api/StreamWatchdog.ts`** —— 对「SDK 的 timeout 在 headers 到达后就失效」这一真实盲区的处理是教科书级的：双预算（首 token / idle）、resolving sentinel 而非 rejecting（明确为了不触发 CLI 的致命 unhandledRejection）、`return()` 刻意不 await 并写清了为什么。
- **`infra/exec/runShellCommand.ts`** —— 把 cwd jail、凭证过滤、OS 沙箱、进程组、有界+脱敏捕获收敛成唯一入口，并在头注释里写明「为什么散着放会必然出事」。除 P1-1 外无可挑剔。
- **`infra/persist/index.ts` 的 `withFileLock`** —— 心跳前先校验 token 归属（B4）、release 前 read-then-unlink（M1）、`staleMs` 下限与心跳周期的推导（`MIN_LOCK_STALE_MS`），都是同类实现里少见的严谨。
- **`kernel/tools/ToolExecution.ts:276-282`** —— 明确观测 race 输方的 rejection，并写清「CLI 把 unhandledRejection 当致命」。**P0-1 恰好是同一类问题在另一处没有被覆盖** —— 说明这条规则值得抽成一条 lint / 评审清单项。
- **中断与终端归还的顺序**（`repl.ts:1292-1316`）：先 `pauseActiveThinkingMeter` / `disableBracketedPaste` / 退出 raw mode，再做可能耗时数秒的 `router.dispose()`，最后 15 s 熔断。这个顺序是对的，值得推广到 `TaskTui`（见 P1-4）。

---

## 修复清单（v0.9.8）

| 项 | 改动 |
|---|---|
| P0-1 | `cli/stream.ts` 新增 `abandonStream()`：在 `finally` 里对未耗尽的生成器 `interrupt()` + `gen.return()`（不 await，理由同 `StreamWatchdog.closeSource`），并观测掉孤儿 `next()` 的 rejection |
| P0-2 | `kernel/KernelSession.ts` 把 loop 生成器提到 try 外，`catch` 里归还它，正常耗尽时置空 |
| P1-1 | `infra/exec/runShellCommand.ts` 新增 `POST_KILL_GRACE_MS = 3000` 第二保险：kill 前无条件 arm，到点用 `'exit'` 记录的 code/signal 强制 resolve；`flushDecoders()` 抽出共用 |
| P1-2 | `kernel/api/Errors.ts` 新增 `retryAfterMsFromError()`（delta-seconds / HTTP-date / `anthropic-ratelimit-*-reset`，大小写无关，`MAX_RETRY_AFTER_MS = 120s` 封顶），两个 client 取 `max(退避, 服务端提示)` |
| P1-3 | 新建 `cli/textWidth.ts` 作为唯一宽度实现（`displayWidth` / `fit` / `clampWidth` / `wrapToWidth`）；`thinkingMeter` 改用列宽截断，`tui/frame.ts` 与 `term.ts` 改为复用并再导出 |
| P1-4 | `cli/tui/TaskTui.ts` 注册 SIGTERM / SIGHUP / SIGINT：先归还终端再 `process.exit(128+n)`，`teardown()` 里摘除 |
| P2-1/P2-2 | `core/SessionStore.ts` 改为 `createReadStream + readline` 逐行解析；尾部窗口显式丢弃首行残行，不再依赖被忽略的 `bytesRead`，也不再同时持有整串 + split 数组 + 对象数组 |
| P2-3 | `subagent/SubAgentBridge.ts` dispose 的超时 Promise 改为 `unref` + `finally clearTimeout`，退出不再空等 10s |
| P2-4 | `cli/terminalSanitizer.ts` 丢弃 BiDi 覆写/隔离（U+202A–202E、U+2066–2069）与零宽字符（U+200B–200F、U+FEFF） |
| P3-1 | `cli/prompts.ts` `askQuestion` 增加 `'close'` 兜底，EOF 时 resolve 空串（而非 reject——rejection 在本 CLI 是致命的） |
| P3-2 | `cli/repl.ts` 四个同体的 paste 清理函数收敛为 `resetPasteState({ render, dropSegments })` + 四个自解释的一行包装 |
| P3-3 | `cli/repl.ts` 启动探测 readline 私有字段（`_refreshLine` / `line` / `cursor`）；缺失时停用粘贴占位符与 Shift+Enter 插入，改为原样回显而不是静默半失效 |
| P3-4 | `trajectory/recorder.ts` 补注释说明 `processAlive` + 心跳新鲜度必须同时成立，PID 复用被 `LEASE_STALE_MS` 兜住 |
| P3-5 | `kernel/tools/ToolExecution.ts` 新增 `ToolTimeoutError`，`timedOut` 改为 `instanceof` 判定，不再字符串嗅探 |
| P3-6 | `cli/repl.ts` `ReadlineOutput._write` 的 drain 等待补 `'error'` / `'close'` 出口，并给实例挂 error 监听避免二次崩溃 |
| P3-7 | `cli/repl.ts` steer 通知改为复用单个 deferred，长 turn 不再每个事件分配一个永不 settle 的 promise |

---

## 未覆盖范围（本轮未深读）

`campaign/`、`campaigns/`、campaign 相关的 `coordination/CampaignMonitor.ts`（按要求排除）；`loop/graph/`（GraphDistiller / GraphStore / CommitCoordinator 共约 5k 行，是独立的 v2 图运行时，建议单独一轮）；`robotics/`、`evaluation/`、`evolution/`、`reviewer/` 只做了模式化扫描，未逐文件精读。
