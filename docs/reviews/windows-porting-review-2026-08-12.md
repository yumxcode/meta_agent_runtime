# meta-agent 部署到 Windows 的问题清单

日期：2026-08-12 · 基于 v0.8.16 · 范围：全代码库，从 Windows 运行角度审视

**结论先说**：当前代码在 Windows 上**不是"有些小问题"，而是核心执行路径不通**。`agentic` 模式在装了 Git Bash 的机器上勉强能跑，`auto` / `simple_auto` 完全跑不了，而且**工作区越狱防护在 Windows 上是空的**。

下面按"能不能跑"→"安不安全"→"好不好看"排序。

---

## 阻断级

### W1 — `auto` / `simple_auto` 模式在 Windows 上每一次 bash 调用都会抛错

**位置**：`src/modes/toolRuntimeGuards.ts:96-113` ＋ `src/sandbox/index.ts:82-104`

auto 系模式会把沙箱策略锁成 fail-closed：

```ts
const config = this.options.autonomy?.lockWorkspace
  ? { ...withExtra, allowUnsandboxedFallback: false }   // toolRuntimeGuards.ts:97
  : withExtra
…
if (executor.platform === 'noop' && !config.allowUnsandboxedFallback) {
  throw new Error('Sandbox requested, but no supported sandbox backend is available. …')
}
```

Windows 上 `createSandboxExecutor()` 只会返回 `NoopSandboxExecutor`（没有 bwrap，没有 sandbox-exec），于是每个需要沙箱的工具调用都命中这个 throw。

这是**设计上正确的 fail-closed**——无人值守模式不该在没有 OS 级隔离的机器上放开手脚。但结果就是"auto 模式在 Windows 上不可用"，而这一点目前没有任何地方写明：用户会在第一次工具调用时看到一条讲 bwrap/sandbox-exec 的错误信息，而这两个东西在 Windows 上根本不存在。

**建议**：启动时就明确拒绝并说清楚（"auto 模式需要 OS 级沙箱，Windows 暂不支持，请用 --mode agentic 或在 WSL 中运行"），而不是等到工具调用失败。真要支持，得引入 Windows 的隔离机制（Job Object + Restricted Token，或直接约定走 WSL2）。

### W2 — bash 工具在 Windows 上直接 `spawn('bash', …)`

**位置**：`src/tools/shell/bash/index.ts:340`、`src/sandbox/NoopSandboxExecutor.ts:26`

```ts
const execSpec = activeHandle ? activeHandle.wrapExec(command, cwd)
                              : { file: 'bash', args: ['-c', command] }
```

连 Noop 沙箱句柄也是硬编码 bash：

```ts
wrapExec(command: string, _cwd: string): SandboxExecSpec {
  return { file: 'bash', args: ['-c', command] }     // NoopSandboxExecutor.ts:26
}
```

Windows 默认没有 `bash`。装了 Git for Windows 且 PATH 里有 `bash.exe` 时能跑，但那是个 MSYS 环境——路径语义、`/c/Users` vs `C:\Users`、行尾都和模型以为的不一样。

`powershell` 工具是存在的（`src/tools/shell/powershell/index.ts`），但：

- 只有 `createShellTools()` 会同时注册两个；
- `RoboticsSession.ts:613` 和 `SubAgentRunner.ts:698` 都只注册 `createBashTool()`；
- 所有 prompt 文案都在教模型用 bash。

**建议**：按平台选择默认 shell（Windows → `cmd /c` 或 `powershell -Command`），并让 `wrapExec` 的 Noop 实现也走同一个选择逻辑。

---

## 安全级

### W3 — 工作区越狱扫描在 Windows 上完全失效（且此时它是唯一防线）

**位置**：`src/kernel/permissions/PermissionPolicy.ts:145-166、194-266`

命令行里的绝对路径扫描只认 POSIX 路径：

```ts
const absPathPattern = /(?:^|[\s'"=:])(\/(?:[^\s'"`$;&|()<>]+\/?)+)/g   // 只匹配以 / 开头
```

`looksLikeFilesystemPath()` 进一步要求首段落在 `KNOWN_OS_ROOT_DIRS`（`Users`/`home`/`etc`/`var`/…）——**完全没有盘符概念**。因此在 Windows 上：

- `type C:\Users\me\.ssh\id_rsa` — 不匹配，放行
- `copy \\server\share\secret .` — 不匹配，放行
- `powershell` 工具走的是同一个分支（`toolName === 'bash' || toolName === 'powershell'`），所以 PowerShell 命令里的 Windows 路径一律放行

同一函数里的 tmp 豁免也是硬编码 POSIX：`candidate.startsWith('/tmp/') || candidate.startsWith('/var/tmp/')`。

**为什么这条要单独拎出来**：`sandbox/index.ts` 的注释明确说过，命令扫描"是 best-effort 的手误防护，不是隔离边界"，真正的边界是 OS 沙箱。但 Windows 上**没有 OS 沙箱**（见 W1），所以在 agentic/robotics 模式下（这两个模式允许 unsandboxed fallback），这层残缺的扫描就是唯一剩下的东西。两个都不设防叠在一起，性质就变了。

**建议**：给扫描加 Windows 路径形态（`[A-Za-z]:[\\/]`、UNC `\\\\`），tmp 豁免改用 `os.tmpdir()`；并且在 Windows + agentic 模式下把"没有沙箱"的警告提到启动时。

### W4 — `'empty'` 环境策略在 Windows 上会让子进程起不来

**位置**：`src/infra/env/childProcessEnv.ts:50-53`

```ts
const MINIMAL_ENV_KEYS = ['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TZ','SHELL','TMPDIR','TEMP','TMP']
```

Windows 进程启动普遍依赖 `SystemRoot`（缺了它连 winsock 都初始化不了）、`COMSPEC`、`PATHEXT`、`USERPROFILE`、`APPDATA`、`windir`。用 `envPolicy: 'empty'` 起的子进程在 Windows 上会以很难诊断的方式失败。

（`'filtered'` 是默认值且保留全量 env，所以只有显式选 `'empty'` 的调用方受影响——目前主要是特定 MCP 配置。）

---

## 稳定性级

### W5 — 超时/中止时杀不掉进程树，留下孤儿

**位置**：`src/tools/shell/bash/index.ts:200-209`、`src/tools/mcp/mcpConfigFile.ts:258-266`

```ts
const useGroup = process.platform !== 'win32'
…
if (useGroup) process.kill(-child.pid, 'SIGKILL')   // 进程组
else child.kill('SIGKILL')                          // Windows：只杀直接子进程
```

平台判断本身是对的（Windows 没有进程组），但 fallback 只杀了直接子进程。`bash -c "npm install"` 超时后，npm 派生的整棵树会活下来——这正是当初引入进程组杀的原因，Windows 上等于没修。MCP stdio server（常是 `npx <pkg>` 包装）同理。

**建议**：Windows 分支改用 `taskkill /T /F /PID <pid>`（`/T` = 连同子进程树）。

### W6 — `atomicWriteJson` 的 rename 在 Windows 上会因共享冲突偶发失败

**位置**：`src/infra/persist/index.ts:96-108`

写临时文件再 `rename()` 覆盖目标，在 POSIX 上是原子的。Windows 的 `MoveFileEx` 虽然支持覆盖，但**目标文件被其他进程打开时会失败**（ERROR_SHARING_VIOLATION → EPERM/EBUSY）。

这个运行时是明确设计成多进程的（daemon + CLI + auto-scheduler 共享 `.loop/` 和 `.meta-agent/`），读者用 `readFile` 打开目标文件的窗口虽短但真实存在。当前实现会 unlink 临时文件后直接 rethrow，上层多半当成致命错误。

`withFileLock` 的 stale 抢占同样用 `rename()`（`persist/index.ts:226`），受同一影响。

**建议**：Windows 上给 rename 加短重试（几次 × 数十 ms）——这是 Windows 原子写的常规做法。

### W7 — 不可移植的路径与文件名假设（零散）

| 位置 | 问题 |
|---|---|
| `src/subagent/SubAgentRunner.ts:957-958` | 写白名单硬编码 `resolve('/tmp')`、`resolve('/private/tmp')`。Windows 上 `resolve('/tmp')` 变成 `C:\tmp`，既非临时目录也可能不存在。（同一列表里已有 `resolve(tmpdir())`，所以不是缺口，是噪声。） |
| `src/kernel/permissions/PermissionPolicy.ts:216-222` | `/dev/null` 等设备白名单在 Windows 无意义；`NUL` 未处理。 |
| `src/sandbox/detect.ts:146` | 读 `/proc/1/cmdline`，已用 try/catch 包住，Windows 上安全退化。 |

---

## 显示级（本轮已修）

### W8 — CRLF 让 Windows 上所有输出双倍行距 ✅ 已修

**位置**：`src/cli/terminalSanitizer.ts`

消毒器把 `\r` 映射成 `\n`（为了让进度条重绘各占一行），但对 `\r\n` 会同时输出 CR 转的换行**和**原本的 LF：

```
修复前：sanitizeTerminalText('line1\r\nline2\r\n') → "line1\n\nline2\n\n"
修复后：                                          → "line1\nline2\n"
```

Linux/macOS 上只有偶尔的 CRLF 文件会触发；**Windows 上每一个子进程都输出 CRLF**，所以全部工具输出、全部粘贴的日志都会双倍行距。

已修：CR 后紧跟的 LF 被吞掉（跨 chunk 用实例字段记状态），裸 CR 仍然转成换行。6 条测试覆盖 CRLF / 纯 LF / 裸 CR / 跨块 CRLF / CR 后有内容再换行 / 连续 CRLF 空行。

### W9 — 其他终端能力差异（未修，风险低）

- **bracketed paste**（`\x1b[?2004h`）：Windows Terminal / ConPTY 支持；老 conhost 会把这串当普通文本打印出来。可以按 `WT_SESSION` / `TERM_PROGRAM` 探测后再开。
- **ANSI 颜色**：Node 在 Windows 10+ 的 TTY 上会自动开 VT 处理，正常。
- **Braille spinner** `⠋⠙⠹`：需要字体支持，老 conhost 里可能显示成方块。

---

## 建议的推进方式

我倾向于**不要零敲碎打地补丁**，先决定 Windows 的目标形态：

1. **只支持 WSL2**（成本最低）。启动时检测到原生 Windows 就明确提示走 WSL，W1–W7 全部不用碰。文档改一行。
2. **原生支持 agentic/robotics，明确不支持 auto**。需要做 W2（shell 选择）、W3（路径扫描，安全必须）、W5（taskkill）、W6（rename 重试）、W4（env keys）。auto 模式在启动时清晰拒绝。
3. **完整原生支持**。在 2 的基础上还要为 Windows 实现一套沙箱后端（Job Object + Restricted Token），工作量和风险都显著更高。

按目前代码的形态，我认为 **2 是性价比最高的**——W3 那条无论如何都该修（它是安全缺口，不是移植不便），W5/W6 是"多进程运行时在 Windows 上必然踩到"的两条，其余可以按需。

要我按方案 2 推进的话，建议顺序：W3（安全）→ W2（能跑）→ W6 → W5 → W4 → W1 的启动期拒绝。
