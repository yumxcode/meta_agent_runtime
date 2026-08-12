# meta-agent 终端 / 显示层代码审查

日期：2026-08-12 · 版本 0.8.15 · 范围：`src/cli/**`（渲染、输入、TTY、信号），约 8.2k LOC
关注点：稳定性 · 资源管理

---

## 总评

这一层的资源管理整体是干净的：定时器基本都 `unref()`、`streamPrompt` 的 `finally` 覆盖了 spinner 拆除的所有退出路径、`attachedSteer` / `runAttachedAuto` 的 raw mode 都在 `finally` 里成对恢复、`safeStdoutWrite` 的调用点**全部**都 `await` 了（我逐一查过，没有游离调用）、readline 接口只有一个所有者且 `askQuestion` 用 `WeakSet` 防重入。

真正的问题集中在**输出通路的"卡死"语义**上——不是泄漏，是某个状态一旦进入就再也出不来，而且没有任何可见征兆。最严重的一条我已经用打包产物实测复现。

---

## 高 · T1 — 转义序列消毒器没有长度上限，一段未终止的 OSC 会吞掉本回合剩余的全部可见输出

**位置**：`src/cli/terminalSanitizer.ts:24-107`（状态机）＋ `src/cli/stream.ts:112`（每回合一个持久实例）

`TerminalSanitizer` 是个逐字符状态机。进入 `osc` / `stString` 状态后，只有遇到 **BEL(0x07)、ST(`ESC \`) 或 0x9C** 才会回到 `normal`：

```ts
case 'osc': {
  if (ch === '\x07' || code === 0x9c) this.state = 'normal'
  else if (ch === '\x1b') this.state = 'oscEsc'
  break                      // ← 其余一律吞掉，且没有计数上限
}
```

而 `stream.ts` 在**整个回合**共用同一个实例（这是有意的，用于跨 chunk 拼接被切断的序列）：

```ts
const outputSanitizer = new TerminalSanitizer()   // stream.ts:112，回合级
```

关键在于：BEL / ST / 0x9C 这几个字节在正常文本里**几乎不可能出现**。所以一旦进入 `osc`，实际上永远回不来。

**实测**（用 `dist/` 产物跑的，不是推演）：

```
chunk1 -> "build ok"          // 输入 "build ok\x1b]0;my-title"
chunk2 -> ""                  // 输入 "line A\nline B\n"
chunk3 -> ""                  // 输入 "the final answer is 42\n"
c1     -> "x" ""              // 单个 C1 字节 0x9d 同样效果
```

对比：`csi` 状态能很快恢复，因为普通字母（0x40–0x7E）就是合法的 CSI 终结符——所以这个 bug **只在 OSC / DCS / APC / PM / SOS 这几条分支上致命**，而它们恰好是终结符最罕见的几条。

**用户看到的现象**：agent 说到一半突然安静，spinner 还在转（meter 走的是另一条不经过消毒器的写路径），工具照常执行，就是一个字都不再显示。回合结束后一切恢复正常。极难归因。

**触发面比看起来宽**，而且我们自己在制造它：

- `cat` 一个二进制文件、curl 进度条、tmux/screen 透传序列、latin-1 误解码出的孤立 0x9d；
- 任何设置窗口标题的构建工具（`\x1b]0;...\x07`）；
- **bash 工具自己的截断**：`src/tools/shell/bash/index.ts` 的 `trunc()` 在第 `limit` 个字符处硬切，完全可能把 `\x1b]0;title\x07` 从中间切断，**保证**送出一个未终止的 OSC。模型随后复述这段工具输出，就走进了持久消毒器。

**修复方向**：给控制序列内部消费的字符数设上限（真实终端也这么做，xterm 有类似限制）。超限就丢弃已吞掉的内容并强制回到 `normal`。建议上限取几百字符量级——合法的 OSC（窗口标题、超链接）不会超过这个数量级，而超限本身就说明这不是一段真序列。

---

## 中 · T2 — team 提醒定时器不检查"正在流式输出"，会插进模型输出中间并重画提示符

**位置**：`src/cli/repl.ts:434-470`

```ts
const teamReminderTimer = (!opts.json && isTTY)
  ? setInterval(() => {
      if (exiting || teamReminderRunning || interactiveInputActive ||
          !router.ready || router.mode !== 'robotics') return
      …
      process.stdout.write(`\n${yellow('Team 动态')}\n`)     // 直接写，不经过 safeStdoutWrite
      fresh.slice(-5).forEach(…)
      rl.prompt(true)                                        // 在流式输出中间重画 `you ›`
    }, 45_000)
```

守卫条件里**没有 `_isStreaming`**。该变量就在同一个 `runRepl` 作用域内（声明在 956 行，回合开始时置 true、`finally` 里置 false），条件也完全对齐——`_isStreaming` 仅在 `isTTY && !opts.json` 时置位，与这个定时器的创建条件一字不差。

后果有三层，都发生在 robotics + team 模式的长回合里：

1. 提醒文本插进模型正在流的句子中间；
2. `rl.prompt(true)` 在回合未结束时画出 `you ›`，用户以为可以输入了；
3. 它没有先 `pauseActiveThinkingMeter()`，而 meter 每 120ms 用 `\r\x1b[2K` 重画同一行——两者抢同一行，提醒会被擦掉一部分，留下半截文字。

**修复**：守卫里加 `_isStreaming`；写之前 `pauseActiveThinkingMeter()`；`rl.prompt(true)` 仅在非流式时调用。

---

## 中 · T3 — 全进程没有 stdout `'error'` 处理，读端关闭时 EPIPE 会变成 uncaughtException

**位置**：`src/cli/term.ts:47-51`，以及 `repl.ts` 里 66 处直接 `process.stdout.write` / `console.log`

```ts
export async function safeStdoutWrite(text: string): Promise<void> {
  if (!text) return
  if (process.stdout.write(text)) return
  await once(process.stdout, 'drain')      // ← 'error' 会让它 reject
}
```

**实测**：把输出接给一个提前退出的读者（`node x.mjs | head -c 1`），`once(stdout, 'drain')` 以 `EPIPE` reject。

`safeStdoutWrite` 的调用点我逐个查过，**全部都 await 了**，所以这条路径上的 EPIPE 会落进调用方的 try/catch，只是打一行 `Error: write EPIPE`，不算崩溃。

真正的问题是另一条：`ThinkingMeter.hide()` / `render()` 和 `repl.ts` 里那 66 处**直接调 `process.stdout.write`**。管道上的 EPIPE 是以 `'error'` 事件形式抛出的，而全代码库没有任何 `process.stdout.on('error')`（我 grep 过，零处）——没有监听器的 `'error'` 事件会被 EventEmitter 直接 throw，成为 uncaughtException，命中 `repl.ts:1276` 的 `process.once('uncaughtException') → disposeAndExit(1, e)`，用户看到 `Fatal: write EPIPE`。

`meta-agent … | head`、`| less` 然后按 q，是完全正常的用法。

**修复**：进程启动时挂一个 `process.stdout.on('error', …)`，对 `EPIPE` 静默退出（约定俗成的 CLI 做法），其余错误照常上报。

---

## 中低 · T4 — 无 REPL 时的裸 stdin 一次性读取没有 EOF / 超时 / abort 处理

**位置**：`src/cli/router.ts:115-130`

```ts
// Fallback (no REPL readline, e.g. piped/headless): raw stdin one-shot read.
process.stdout.write(banner)
return new Promise<boolean>(resolve => {
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  const onKey = (key: string) => { … resolve(confirmed) }
  process.stdin.once('data', onKey)     // 只等 'data'
})
```

注释明说这条路径是给 "piped/headless" 准备的——但管道场景下如果 stdin 已经 EOF，`'data'` 永远不会触发，只有 `'end'` 会，而没人监听 `'end'`。这个 Promise 永久挂起，整个升级确认卡死，且没有 abort 通道。

（raw mode 本身在非 TTY 上是安全的：`setRawMode` 对管道是 undefined，`?.()` 直接短路。）

**修复**：同时监听 `'end'` / `'close'` 按"拒绝"处理，并接受一个 `AbortSignal`。

---

## 低

| # | 位置 | 说明 |
|---|---|---|
| T5 | `thinkingMeter.ts:109-121` | `render()` 文档写着 "Build the status line string… Exposed for tests"，但函数体最后会 `this.write(line)`。测试里调 `render()` 断言返回值会顺带往 stdout 写。建议拆成纯函数 `format()` + `render()` 调它。 |
| T6 | `thinkingMeter.ts:21` | `CLEAR_LINE = '\r\x1b[2K'` 只清一行。窄终端下状态行折行时 `hide()` 会留残迹。当前 label 最长约 40 字符，实际风险低。 |
| T7 | `repl.ts:1275-1277` | 注册了 SIGTERM / uncaughtException / unhandledRejection，**没有 SIGHUP**。SSH 断连时 bracketed paste 模式和 raw mode 不会恢复，留给存活的 shell。终端窗口直接关闭的场景无所谓。 |
| T8 | `repl.ts:866` | `finishPasteNotice()` 里 `_pasteNoticeTimer = null` 是冗余的——上一行 `renderPasteNotice()` 已经 `clearTimeout` 并置 null，且 `pasteNoticeActive()` 保证了定时器非空时一定会走到那里。无害，但读起来像是在防一个不存在的漏清。 |

---

## 复核过但确认**没有**问题的点

记录下来避免下次重复审：

- **`streamPrompt` 的 spinner 拆除**（`stream.ts:435-440`）——`finally` 覆盖 return / throw / interrupt 全部路径，`clearInterval` + `meter.hide()` + 清空全局注册表，齐全。
- **meter 与真实输出的互斥**——`stream.ts` 里每一个会写内容的 event 分支（text / tool_use / tool_result / api_retry / system_message / compact_*）都先 `meter.hide()`，逐条查过，没有遗漏。
- **`attachedSteer` 的 raw mode**（`attachedSteer.ts:116-125`）——记录进入前的 `isRaw` 并在 `dispose()` 还原；`runAttachedAuto` 在 `finally` 里调 `dispose()` 和 `removeListener('SIGINT')`。且它主动把 raw 模式吞掉的 0x03 重新 `emit('SIGINT')`，Ctrl+C 不会失效。
- **`safeStdoutWrite` 无游离调用**——`grep -v "await safeStdoutWrite"` 结果为空。
- **`askQuestion` 的僵尸 prompt 防护**（`prompts.ts:83-95`）——带 signal 时用 readline 原生的 `{ signal }` 取消，配 `WeakSet` 标记，超时的 `ask_user` 不会吞掉用户下一行输入。
- **`singleTurn` 的 steer 轮询器**（`singleTurn.ts:181-219`）——unref'd，`finally` 里 `clearInterval`，还做了最后一次 drain 避免迟到的纠正泄漏到下一次运行。
- **paste 相关定时器**——`_pasteNoticeTimer` 的 6 个清理点都成对，`unref()` 了。

---

---

## 修复状态（v0.8.16）

全部已实施。`tsc --noEmit` 干净，`vitest run` 212 文件 / **2114** 用例通过（较上版 +15）。

| 条目 | 做法 | 测试 |
|---|---|---|
| T1 消毒器卡死 | 控制序列内部消费加 4096 字符上限，超限丢弃已吞内容并回到 `normal`，**当前字符按正常文本重新解释**所以输出正好从这里恢复；状态迁移统一走 `enter()`，只有回到 `normal` 才重置计数，序列间迁移不重置 | `terminalSanitizer.test.ts` +5 |
| T2 team 提醒插字 | 守卫加 `_isStreaming`；await 之后**再检查一次**（回合可能在轮询期间开始）；写前 `pauseActiveThinkingMeter()` | — |
| T3 EPIPE | `installBrokenPipeGuards()` 在 CLI 入口挂 stdout/stderr 的 `'error'`，EPIPE / ERR_STREAM_DESTROYED 静默 `exit(0)`，其余错误照常上抛；`safeStdoutWrite` 额外吞掉等待 drain 时的 EPIPE reject | — |
| T4 裸 stdin 挂起 | 同时监听 `'end'` / `'close'` 按"拒绝"处理，加 120s 上限，统一 `finish()` 清理 | — |
| T5 render 副作用 | 拆出纯函数 `format()`，`render()` 调它再决定是否写 | `thinkingMeter.test.ts` +1 |
| T6 状态行折行 | 按终端宽度截断（**在着色前的可见文本上**截，否则转义字节会被算进长度导致过早截断） | `thinkingMeter.test.ts` +3 |
| T7 SIGHUP | 补 `process.once('SIGHUP')`；并把终端恢复（meter 擦除 + bracketed paste + raw mode）提到 `router.dispose()` **之前**——dispose 有 15s 熔断，原来崩溃时终端要么迟 15s 恢复要么根本不恢复 | — |
| T8 冗余置空 | 删掉并说明为什么不需要 | — |
| W8 CRLF 双倍行距 | 见 [windows-porting-review-2026-08-12.md](windows-porting-review-2026-08-12.md)；CR 后紧跟的 LF 吞掉，裸 CR 仍转换行 | `terminalSanitizer.test.ts` +6 |

### T1 / W8 用打包产物验证过

```
CRLF      -> "line1\nline2\n"        （修复前 "line1\n\nline2\n\n"）
bareCR    -> "50%\n100%"             （进度条重绘行为保持不变）
recovered -> "the final answer is 42"（未终止 OSC 超限后恢复输出）
```

### 一处需要说明的取舍

T1 超限时**丢弃已经吞掉的内容**而不是把它当文本吐出来。理由：那些字节确实是控制序列的一部分（我们只是没等到终结符），原样打印到终端反而可能触发真正的转义解释——正是这个模块存在的目的。代价是极端情况下丢一小段内容，比起"整回合静默"是明确的改善。

### 未采纳

T2 我没有给它写"定时器在流式期间不写入"的单测。这个定时器是 `runRepl` 里的一个闭包，没有导出，要测它得把整个 REPL 立起来并伪造 45 秒——测试本身的复杂度和脆弱性会超过它保护的那三行守卫。守卫的正确性靠的是 `_isStreaming` 与定时器创建条件严格同域（两者都是 `isTTY && !opts.json`），这一点写在代码注释里比写在测试里更有用。
