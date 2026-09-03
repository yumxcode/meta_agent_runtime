# meta-agent-runtime 代码审查报告

> **状态更新（修复轮次已完成）**
>
> 下表 #2–#13 已全部实施并验证。**#1（P1-1 沙箱默认 `readDenyPaths`）经确认暂不修复**，
> 相关的两处 profile 生成逻辑已加上 `DOCUMENTED GAP` 测试用例，让这个缺口在测试套件里持续可见，
> 而不是只存在于本文档中。
>
> 验证基线：`tsc --noEmit` 0 错误；`vitest` **181 文件 / 1514 用例全绿**（修复前 178/1450，
> 新增 64 个回归用例）；`npm run build` 通过；CLI 二进制 `--version` / `--help` / `env`
> / `loop list` / 无 key 报错路径均已冒烟。
>
> 逐条落地情况见文末「修复记录」。

- **版本**：0.8.7（`999d8c8`，工作区有未提交改动）
- **范围**：`src/` 全部模块，**排除 `src/campaign/`、`src/campaigns/`、`src/coordination/CampaignMonitor|CampaignStateStore` 等 campaign 相关代码**（开发中）
- **规模**：约 79,556 行 TS（不含测试），178 个测试文件 / 1450 个用例
- **基线验证**：`tsc --noEmit` 通过（0 错误）；`vitest run` 全部 1450 个用例通过
- **审查日期**：2026-08-04

---

## 总体评价

这是一份**远高于平均水准**的代码库。几个突出优点：

1. **注释质量罕见地高**。几乎每个非平凡决策都有 "为什么这样写 / 之前的 bug 是什么 / 为什么不能改回去" 的说明（`M1-fix`、`L7-fix`、`P2-2` 这类带编号的修复注记）。这是防止回归的最有效手段。
2. **失败模式被认真对待**。`withFileLock` 的 owner-token、`runProcessGroup` 的进程组 kill、`executeToolCall` 的 race-loser 观测、`GraphKernel.executeWithHeartbeat` 的 `finally` 排空 —— 这些都是踩过坑之后才会写出来的代码。
3. **安全边界的自我认知是诚实的**。`SensitiveCommandPatterns.ts` 顶部明确写着 "这不是安全边界，不要当成安全边界"，`ReliabilityProfile` 把持久化等级显式建模为 `process-crash-local-posix`（而不是假装有 fsync）。这种诚实比虚假的安全感有价值得多。

因此下面的问题清单**不是"这份代码很差"的证据**，而是在一个已经写得很好的系统里找剩下的缝隙。核心结论：

> **最大的系统性风险是：文档和注释里宣称的"OS 沙箱是真正的边界"，实际上只挡写不挡读，且默认允许网络。这让"模型无法通过 shell 外泄 API key"这个明确的设计目标（`bash/index.ts` H5）在配置了 `~/.meta-agent/config.json` 的用户身上失效。**

---

## 严重程度定义

| 级别 | 含义 |
| --- | --- |
| **P1** | 安全边界失效或数据可能丢失/损坏，需要尽快修 |
| **P2** | 真实 bug 或设计缺口，在特定条件下会咬人 |
| **P3** | 局部缺陷、误报、可维护性风险 |
| **P4** | 结构/工程实践建议 |

---

## P1 — 需要尽快处理

### P1-1 · OS 沙箱只限制写，完全不限制读；API key 明文可读

**位置**
- `src/sandbox/profiles/bwrap.ts:52` — `args.push('--ro-bind', '/', '/')`
- `src/sandbox/profiles/macos.ts:87-89` — `(allow default)` + `(deny file-write*)`
- `src/core/modelConfigFile.ts:15,50` — `apiKey` 持久化在 `$META_AGENT_HOME/config.json`
- `src/tools/shell/bash/index.ts:55-105` — 被这个问题抵消的 env 过滤逻辑

**问题**

两个平台的沙箱 profile 都是「读全放开 + 写收紧」：

```ts
// bwrap：整个宿主文件系统只读挂载进沙箱 —— 可读
args.push('--ro-bind', '/', '/')
// macOS：允许一切，然后只 deny file-write*
lines.push('(allow default)')
lines.push('(deny file-write*)')
```

同时 `config.network` 默认未设置 → bwrap 不加 `--unshare-net`，Seatbelt 不加 `(deny network*)`，**沙箱内网络畅通**。

`bash` 工具花了大量篇幅做 env 过滤（`SENSITIVE_ENV_PATTERN`、`EXPLICIT_ENV_BLOCKLIST`），注释明确写着「Defaults to 'filtered' so models cannot exfiltrate API keys via shell」。但只要用户按 `modelConfigFile.ts` 的文档把 key 写进 `~/.meta-agent/config.json`（这是官方推荐的配置方式），沙箱内一条 `cat ~/.meta-agent/config.json` 就能拿到，再一条 `curl` 就能发出去。同理 `~/.ssh/id_rsa`、`~/.aws/credentials`、`~/.gitconfig`。

代码里已有 `readDenyPaths` 的支持（`bwrap.ts:82`、`macos.ts:139`），但**全代码库没有任何地方为主 agent 设置默认值** —— `DEFAULT_MAIN_SANDBOX = { allowUnsandboxedFallback: true }`（`bash/index.ts:147`）里没有 `readDenyPaths`。

对比：`SubAgentBridge.ts:647` 已经给 isolated-write 子代理加了 `writeDenyPaths: [..., metaAgentDir]` —— 说明"`.meta-agent` 需要保护"这个认知是有的，只是止步于写保护。

**建议**

1. 给 `DEFAULT_MAIN_SANDBOX` 和 auto 模式的沙箱配置加默认 `readDenyPaths`：`$META_AGENT_HOME`、`~/.ssh`、`~/.aws`、`~/.config/gh`、`~/.npmrc`、`~/.docker/config.json`。
2. 更强的做法：把 `apiKey` 从明文 config.json 移到 OS keychain，或至少在启动时读入内存后 `readDenyPaths` 掉整个 `$META_AGENT_HOME`。
3. 考虑给 auto 模式默认 `network: 'none'`，需要联网的任务显式开启（web_fetch/web_search 走独立通道，不经过 shell）。
4. README「权限与沙箱」一节应明确写出："沙箱限制写入与执行，**不限制读取**"。

---

### P1-2 · `permissions.json` 里 `tools.bash.sensitive` 被静默忽略

**位置**：`src/kernel/permissions/PermissionPolicy.ts:406`

```ts
if (sensitiveLabel || (permission.sensitive === true && tool.name !== 'bash' && tool.name !== 'powershell')) {
```

**问题**

同一文件 `:390` 的注释写着：

> The user config file is the highest authority so an operator can flip any tool's gates (**e.g. sensitive**) without code changes.

但 `bash` / `powershell` 被硬编码排除在 `permission.sensitive` 之外。也就是说，一个运维人员想要"每条 shell 命令都要我确认"，写下：

```json
{ "tools": { "bash": { "sensitive": true } } }
```

**不会有任何效果，也不会有任何警告**。只有命中 `SENSITIVE_SHELL_PATTERNS` 正则的命令才会提示。这恰恰是**最危险的工具上，最重要的安全配置项，静默失效**。

**实测验证**（用真实模块跑）：

```
F1 bash sensitive=true result: {"behavior":"allow"}
```

（在没有任何审批通道的情况下仍然 allow —— 若配置被尊重，应该 deny）

**建议**：改为 `permission.sensitive === true || sensitiveLabel !== null`，让显式配置能提升 bash 到"每次都问"。若确实想保留"bash 只按模式匹配提示"的默认，也应在加载配置时对 `tools.bash.sensitive` 发一条 stderr 警告说明它不生效。

---

### P1-3 · `/dev/` 路径无条件跳过工作区检查

**位置**：`src/kernel/permissions/PermissionPolicy.ts:229`

```ts
if (
  !(allowTmp && (candidate.startsWith('/tmp/') || candidate.startsWith('/var/tmp/'))) &&
  !candidate.startsWith('/dev/') &&          // ← 无条件豁免
  !isInsideWorkspace(candidate, workspaceRoot)
) {
```

**问题**

`/dev/null`、`/dev/urandom` 需要放行是合理的，但豁免是**整个 `/dev/` 前缀**。而且 `dd`、`mkfs`、`> /dev/sdX` 都不在 `SENSITIVE_SHELL_PATTERNS` 里，auto 模式下 `autoApproveInWorkspace` 又会跳过确认。

**实测验证**：

```
F3 dd if=/dev/zero of=/dev/sdz bs=1M → {"behavior":"allow"}
```

在有 bwrap 的机器上，`--dev /dev` 会给一个新的最小 `/dev`，实际写不到宿主块设备；但在**没有 bwrap 且非 auto 模式**的机器上（见 P1-4），这条命令会直接落到宿主上。

**建议**：把豁免从前缀改为白名单：`/dev/null`、`/dev/zero`、`/dev/random`、`/dev/urandom`、`/dev/stdin|stdout|stderr`、`/dev/fd/*`、`/dev/tty`。其余 `/dev/*` 走正常拒绝路径。

---

### P1-4 · 非 auto 模式下沙箱静默降级为"无沙箱"

**位置**
- `src/tools/shell/bash/index.ts:147` — `const DEFAULT_MAIN_SANDBOX: SandboxConfig = { allowUnsandboxedFallback: true }`
- `src/modes/toolRuntimeGuards.ts:73-88`

**问题**

`toolRuntimeGuards` 只在 `autonomy?.lockWorkspace`（即 auto / simple_auto）时才强制 `allowUnsandboxedFallback: false`。**agentic 和 robotics 模式下**，如果宿主没有 bwrap（大量 Linux 容器基础镜像、Alpine、WSL 默认、Windows 全部），`createSandboxExecutor()` 返回 `NoopSandboxExecutor`，`allowUnsandboxedFallback: true` 让它静默通过，`wrapExec` 退化成 `bash -c <command>`。

此时唯一的"工作区监狱"就只剩 `PermissionPolicy` 的字符串扫描 —— 而这个扫描是可绕过的（下面 P2-1 有实测）。**用户不会收到任何提示说沙箱没生效。**

**建议**

1. 首次降级时向 stderr 打一条醒目的一次性警告（`LinuxSandboxExecutor` 在 nested-bwrap 时已经这么做了，`LinuxSandboxExecutor.ts:100`，把同样的处理推广到 noop 路径）。
2. 在 CLI 启动横幅 / `meta-agent env` 输出里显示当前沙箱后端（`getSandboxAvailability()` 已经提供了这个信息，只是没人用）。

---

## P2 — 真实缺口

### P2-1 · bash 工作区扫描可被常见 shell 构造绕过（已知但影响面值得记录）

**位置**：`src/kernel/permissions/PermissionPolicy.ts:196-247, 279-296`

代码注释已经承认这是 best-effort（`:412` "NOT a proof of containment"），这里只是把**实际绕过难度**量化，因为它决定了 P1-4 的严重程度。

**实测**：

| 命令 | 结果 |
| --- | --- |
| `cat /etc/passwd` | ✅ deny |
| `cat /"e"tc/passwd` | ✅ deny（被 root-glob 规则误打误撞拦下） |
| `X=etc; cat /$X/passwd` | ❌ **allow** |
| `echo L2V0Yy9wYXNzd2Q= \| base64 -d \| xargs cat` | ❌ **allow** |
| `cd $(dirname $PWD)` | ❌ **allow** |

绕过成本约等于零。结论：**这层只应算作"防手滑"，不能算作安全控制**。这加强了 P1-4 的结论 —— 没有 OS 沙箱时，工作区监狱在事实上不存在。

**建议**：不必试图加固正则（这是一场注定输的军备竞赛）。正确的做法是让 OS 沙箱在所有模式下都是硬要求（P1-4），并在文档里把这层降级描述为 "typo guard"。

---

### P2-2 · `isInsideBwrap()` 的 `/proc` 检测在 ESM 下永远抛异常（嵌套沙箱检测失效）

**位置**：`src/sandbox/detect.ts:135`

```ts
const { readFileSync } = require('fs') as typeof import('fs')
```

**问题**

`package.json` 是 `"type": "module"`，`tsconfig` 是 `module: ESNext`。ESM 里没有 `require`。这行会抛 `ReferenceError: require is not defined`，被外层 `catch` 吞掉，函数返回 `false`。

**实测验证**：

```
$ node /tmp/esmreq.mjs
CAUGHT: ReferenceError require is not defined
$ grep -n "require(" dist/sandbox/detect.js
121:        const { readFileSync } = require('fs');   ← 编译产物里原样保留
```

**后果**：嵌套 bwrap 检测退化为只看 `BWRAP_SANDBOX_PID` 环境变量。在已经处于 bwrap 内的宿主（容器化 CI、Flatpak、某些 devcontainer）上，`LinuxSandboxExecutor.create()` 不会走优雅降级路径，而是照常构造 bwrap 参数，最后在真正执行时以 `bwrap: Creating new namespace failed: Operation not permitted` 的形式失败 —— 每一次 bash 调用都失败，而且错误信息完全不指向根因。

**修复**：文件顶部已经有 `import { execFileSync } from 'child_process'`，直接加 `import { readFileSync } from 'node:fs'` 并删掉这行 `require`。

---

### P2-3 · `withFileLock` 持锁期间不续期 mtime → 长临界区会失去互斥

**位置**：`src/infra/persist/index.ts:155-215`

**问题**

锁文件的 mtime 只在**创建那一刻**写入，之后再也不更新。`staleMs` 默认 30 秒。因此：

> 任何执行时间可能超过 `staleMs` 的临界区，会在中途被另一个进程判定为"孤儿锁"并 rename 抢走，两个进程同时进入临界区。

`finally` 里的 owner-token 校验只能防止**误删别人的锁**，防不住**互斥已经被破坏**这件事本身 —— 那时数据竞争已经发生了。

已知的高风险调用点：

| 调用点 | staleMs | 临界区内容 |
| --- | --- | --- |
| `ExperienceStore.rebuildIndex` (`:206`) | 30s（默认） | `rm -rf` 索引目录 + N 个文件重写 + summary/markdown 重建 |
| `TeamStore.writeAll` (`:1090`) | 30s（默认） | 读校验 + atomicWrite（快，风险低） |
| `WakeStore.*` (`:107` 等) | 30s（默认） | 读改写（快） |
| `GraphStore.withTransaction` (`:587`) | 15 min | 整个 graph 事务（已针对性放宽，合理） |

`rebuildIndex` 在经验条目多、磁盘慢（NFS、网络盘、CI）时超过 30 秒是完全可能的。

**建议**：在 `withFileLock` 内部起一个 `setInterval(() => utimes(lockPath, now, now), staleMs / 3).unref()`，持锁期间续期，`finally` 里 `clearInterval`。这是 `daemon.ts` 已经在用的模式（`refreshLock`），把它下沉到通用锁里即可。

---

### P2-4 · 所有原子写都没有 fsync — 掉电/内核崩溃会丢数据

**位置**：`src/infra/persist/index.ts:84-102`（`atomicWriteJson` / `atomicWriteFile`），以及 `research/ResearchStore.ts:120`、`core/memory/memdir.ts:202`、`loop/graph/distill/*` 等各处自己实现的同款 tmp+rename

```ts
await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
await rename(tmp, filePath)          // 没有 fsync(tmp)，也没有 fsync(dir)
```

全代码库 `grep fsync|fdatasync` = **0 处命中**。

**评价**：这一条**不算 bug，因为设计上是自觉的** —— `loop/graph/operations/ReliabilityProfile.ts:33` 把持久化等级建模成 `'process-crash-local-posix' | 'fsync-local-posix' | 'unknown'`，默认值就是 `process-crash-local-posix`，`status` 也只报 `'declared'` 而非 `'verified'`。这份诚实值得称赞。

但需要注意两点：
1. **README 的措辞** 里「崩溃恢复」「durable checkpoint」容易被读成"掉电也不丢"。建议补一句限定：进程崩溃安全，机器掉电不保证。
2. 如果将来要支持真正的 `fsync-local-posix` 等级，只需在 `atomicWriteJson` 里加 `fh.sync()` + 目录 fsync，由一个 env/config 开关控制 —— 因为所有写都收敛在这一个函数里，改动面很小。这是前面"把 pattern 集中到一处"的红利。

---

### P2-5 · MCP stdio 服务器继承完整 `process.env`（含所有 API key）

**位置**：`src/tools/mcp/mcpConfigFile.ts:150`

```ts
const mergedEnv = { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>
```

**问题**

`bash` 工具为了防止 key 外泄，写了 `SENSITIVE_ENV_PATTERN` + `EXPLICIT_ENV_BLOCKLIST` 两层过滤。但 MCP stdio 服务器 —— 一个**由配置文件指定、通常来自第三方的任意可执行文件** —— 拿到的是完整的 `process.env`，包括 `ANTHROPIC_API_KEY`、`ZHIPU_API_KEY`、`GITHUB_TOKEN`、`AWS_SECRET_ACCESS_KEY`。

信任模型上说得通（用户自己配的 MCP），但和同一代码库对 shell 的严格态度**不一致**，而且一个供应链被污染的 MCP 包就能静默收走所有凭证。

**建议**：复用 `bash/index.ts` 的 `buildShellEnv('filtered')`，让 MCP 默认也走过滤策略；确需某个 key 的服务器通过 `cfg.env` 显式声明（这也让配置文件成为"哪个 MCP 能看到哪个 key"的审计点）。

---

### P2-6 · MCP stdio 每次 RPC 新起一个进程 + stderr 直通终端

**位置**：`src/tools/mcp/mcpConfigFile.ts:160-166`

```ts
const child = spawn(cfg.command, cfg.args ?? [], {
  cwd: cfg.cwd, env: mergedEnv,
  stdio: ['pipe', 'pipe', 'inherit'],   // ← stderr 直接进 CLI 终端
  detached: useProcessGroup,
})
```

两个问题：

1. **`_rpc` 每次调用都 spawn 一个新进程**。这意味着 `initialize` → `tools/list` → 每次 `tools/call` 各起一个进程。对**有状态**的 MCP 服务器（持有连接、缓存、会话）语义是错的：每次调用都从零开始，`initialize` 建立的 session 在下一次 RPC 里已经不存在。同时每次调用要付一次进程启动开销。
2. **`stderr: 'inherit'`** 让 MCP 服务器的日志直接写进 CLI 的 TTY。任何一个话痨的 MCP（很常见）都会打乱 REPL 的渲染、覆盖 thinking meter、破坏 bracketed paste 状态。

**建议**：改为长驻子进程 + 按 Content-Length 分帧的持久 stdio 通道（MCP 规范的标准做法）；stderr 改 `'pipe'` 并按行前缀（`[mcp:<name>] ...`）转发或丢弃。

---

### P2-7 · `void p.catch(...).finally(async () => {...})` — finally 里的异常无人接管，会杀掉 CLI

**位置**：`src/subagent/SubAgentBridge.ts:1355-1369`

```ts
void runner.start()
  .catch(() => undefined)
  .finally(async () => {                    // ← async 回调
    const finalRecord = await readTask(taskId).catch(() => null)
    this._settleBudget(taskId, finalRecord?.result?.costUsd)   // 可能抛
    this.runners.delete(taskId)
    ...
    this._scheduleDrain()                                       // 可能抛
})
```

`.catch()` 在 `.finally()` **之前**，所以 finally 回调体内抛出的异常会让最终那个被 `void` 掉的 Promise 变成 unhandled rejection。而 CLI 注册了：

```ts
// src/cli/index.ts:4738
process.once('unhandledRejection', (e) => { void disposeAndExit(1, e) })
```

即：**一个子代理结算路径上的异常会直接终止整个 CLI 会话**。`_settleBudget` 会调 `this.costLedger?.settleTask(...)`（外部注入的对象），`_scheduleDrain` 会同步进入 `_drainStartQueue`；两者都不在本文件的控制范围内。

**建议**：把顺序改成 `.finally(...).catch(() => undefined)`，或者把 finally 体整个包一层 try/catch。同类模式建议全局搜一遍（目前只此一处）。

---

### P2-8 · CLI 里第三份工作区边界实现，用的是朴素前缀匹配

**位置**：`src/cli/index.ts:1095, 1114, 1117-1122`

```ts
!filePath.startsWith(workspace) && !filePath.startsWith('/tmp')            // :1095
if (typeof cwd === 'string' && cwd && !cwd.startsWith(workspace))          // :1114
const absPathPattern = /(?:^|\s|['"])(\/([\w.\-]+\/)+[\w.\-]*)/g           // :1117
```

**问题**

`src/tools/fs/workspaceGuard.ts` 的文档明确说它存在的意义是：

> so the symlink-escape handling ... **cannot drift between the three call sites that historically each had their own copy**.

而 `detectSensitiveOp` 又造了一份，且实现更弱：

- **前缀混淆**：workspace = `/home/u/proj` 时，`/home/u/proj-backup/secret` 满足 `startsWith`，于是**不弹确认框**。
- 不做 realpath，symlink 逃逸看不见。
- 正则和 `PermissionPolicy` 的那份不一致（这份不认 `=`/`:` 分隔）。

内核策略层仍会正确拒绝，所以这是**纵深防御降级**而非完全洞穿。但它正是那份注释警告过的"漂移"。

**建议**：`detectSensitiveOp` 直接调用 `isInsideWorkspace()`，删掉本地正则和 `startsWith`。

---

## P3 — 局部缺陷

### P3-1 · 工作区相对逃逸检查误报，会挡掉常见的合法命令

**位置**：`src/kernel/permissions/PermissionPolicy.ts:279-296`

**实测**：

```
awk '$1 ~ /x/' f.txt   → deny: "references home (~) — outside workspace"
echo "a .. b"          → deny: "references parent path (..)"
```

`~` 是 awk 的**正则匹配运算符**，`$1 ~ /re/` 是最常见的 awk 写法；`perl`、`expr`、部分 SQL 单行命令同理。这个规则会在所有模式下拒绝它们，且错误信息把用户/模型指向完全不相干的方向（"references home"）。

**建议**：把 `~` 的匹配收紧到"路径位置的 `~`" —— 要求 `~` 后面紧跟 `/` 或者处于命令的参数起始位置（`(?:^|[\s'"=:(])~(?=/|$|[\s'"])` 里去掉裸 `~ ` 的分支），并在拒绝信息里附上原始片段方便自纠。

---

### P3-2 · `getOrCreateSandboxHandle` 存在竞态，会泄漏未销毁的句柄

**位置**：`src/modes/toolRuntimeGuards.ts:78-87`

```ts
const cached = this.sandboxHandles.get(cacheKey)
if (cached) return cached
...
const handle = await executor.create(config, workspaceRoot)   // ← await 期间无保护
this.sandboxHandles.set(cacheKey, handle)
```

两个并行 bash 调用会同时 miss 缓存、各建一个 handle，后写入的覆盖先写入的。被覆盖的那个永远进不了 `dispose()` 的销毁列表。bwrap/Seatbelt 的 handle 目前是无状态的（`destroy()` 是空实现），所以现在无害；但这是一个**等着未来某个有状态后端来引爆的坑**。

**建议**：缓存 `Promise<SandboxHandle>` 而非 `SandboxHandle`，把 `set` 移到 `await` 之前。

---

### P3-3 · `canonicalGuardPath` 是 `resolvePathForGuard` 的第二份拷贝

**位置**：`src/subagent/SubAgentRunner.ts:993-1005` vs `src/tools/fs/workspaceGuard.ts:5-20`

两个函数逻辑逐行等价（找最近存在的祖先 → realpath → 重新拼接不存在的尾部）。同 P2-8，这正是 `workspaceGuard.ts` 注释里说要消除的重复。

另外 `wrapWithSandboxWriteGuard` 在**每个 pathField 的循环体内部**重算 `canonicalDenyRoots` / `canonicalAllowRoots`（`SubAgentRunner.ts:964-965`），每次都要跑 N 次 `realpathSync`。应该提到闭包外算一次。

---

### P3-4 · 源码里嵌入了裸 NUL 字节，文件被工具识别为 binary

**位置**
- `src/kernel/loop/KernelLoop.ts:562` — `parts.join('\x00')`（分隔符）
- `src/kernel/api/DeepSeekClient.ts:80` — `` `${sessionId}\x00${model}\x00...` ``（缓存 key）

这两处用的是**字面 NUL 字节**而不是转义序列 `\x00`。后果：

```
$ grep -rn "TODO" src/
grep: ./kernel/loop/KernelLoop.ts: binary file matches   ← 内容不显示
```

`grep`、`git diff`、部分编辑器和 code review 工具都会把这两个文件当二进制处理，**审查时直接看不到内容**。用 `\x00` 转义写法语义完全等价，且文件保持纯文本。

**建议**：`'\x00'` 替换字面字节。可以加一条 CI 检查：`git grep -Il '' -- 'src/**/*.ts'` 找出非文本源文件。

---

### P3-5 · `setModelCallAdmissionProvider` 名为 set 实为 set-once

**位置**：`src/infra/modelCallAdmission.ts:27`

```ts
export function setModelCallAdmissionProvider(next: Provider): void {
  provider ??= next        // ← 第二次调用静默无效
}
```

一个叫 `setX` 的函数第二次调用什么都不做且不报错，是很容易踩的坑（尤其在测试里换 provider）。建议改名 `registerModelCallAdmissionProviderOnce`，或在已存在时 `console.warn`，并提供一个 `resetModelCallAdmissionProvider()` 供测试用。

---

### P3-6 · `daemon.refreshLock` 丢锁时不通知任何人

**位置**：`src/loop/daemon.ts:177-186`

```ts
async function refreshLock(lockPath: string, token: string): Promise<void> {
  try {
    const held = JSON.parse(await readFile(lockPath, 'utf8')) as DaemonLockRecord
    if (held.pid === process.pid && ... && held.token === token) { await utimes(...) }
  } catch { /* the next scheduler iteration observes loss */ }
}
```

注释说"下一轮调度会观察到丢锁"，但**代码里没有任何地方观察它** —— token 不匹配时函数静默返回，主循环照常继续。实际的兜底是 `HostSchedulerCoordinator` 的 workspace lease 心跳（`:69-74`，`!ok` 时 abort），那一层是有效的。

所以这不是活跃 bug，但注释是错的，会误导后续修改的人。建议让 `refreshLock` 返回 `boolean`，主循环在 `false` 时 abort —— 也就把注释变成事实。

---

### P3-7 · `atomicWriteJson` 的 tmp 文件在异常时会残留

`writeFile(tmp)` 成功但 `rename` 失败（跨设备、权限、磁盘满）时，`tmp` 文件不会被清理。`listJsonIds` 会过滤掉它们（`:117`），所以不影响正确性，但会在 `.loop/`、`.meta-agent/` 下慢慢堆积。建议加 `try/catch` + `unlink(tmp)`。

（顺带：`:117` 的 `.filter(e => e.endsWith('.json') && !e.endsWith('.tmp'))` 里第二个条件是死代码 —— tmp 文件名形如 `foo.json.ab12cd34.tmp`，已经不满足 `.endsWith('.json')`。）

---

### P3-8 · `readJsonFile` 的 `.corrupt` 隔离会互相覆盖

**位置**：`src/infra/persist/index.ts:66`

```ts
await rename(filePath, `${filePath}.corrupt`).catch(() => {})
```

第二次损坏会覆盖第一次的取证副本。建议带时间戳/随机后缀：`${filePath}.${Date.now()}.corrupt`。

---

### P3-9 · `runProcessGroup` 直接 SIGKILL，没有 SIGTERM 宽限期

**位置**：`src/tools/shell/bash/index.ts:202-212`

超时/中断时直接 `SIGKILL` 整个进程组。对训练脚本、数据库客户端、有 checkpoint 写入的长任务，没有任何机会做清理，可能留下半写的文件或未释放的锁。

建议：先 `SIGTERM` 整组，1–2 秒后仍未退出再 `SIGKILL`。

---

### P3-10 · 输出截断阈值可被单个 chunk 冲过

**位置**：`src/tools/shell/bash/index.ts:226-231`

```ts
child.stdout?.on('data', (chunk: Buffer) => {
  if (stdout.length < opts.captureLimit) stdout += outDecoder.write(chunk)
})
```

判断在**追加之前**，所以最终长度可能是 `captureLimit + 单个 chunk 大小`。默认 chunk 64KB，无实际风险，但边界语义值得写清楚或改成先切片再追加。

---

### P3-11 · `orderedResults` 用 `toolUseId` 做 key，重复 id 会破坏 tool_use/tool_result 配对

**位置**：`src/kernel/tools/ToolOrchestration.ts:98, 125`

若模型返回了两个相同 `toolUseId` 的 `tool_use` 块（协议违规，但确实会发生），`Map` 会合并成一条结果，随后的重建循环会为两个请求推出**两份内容相同的 tool_result**。建议在 `runTools` 入口对重复 id 做一次去重/改写，并记一条 warning。

---

## P4 — 结构与工程实践

### P4-1 · `cli/index.ts` 已经 6,153 行，`runRepl` 单函数 798 行

| 函数 | 行数 |
| --- | --- |
| `runRepl` | 798 |
| `streamPrompt` | 364 |
| `handleTeamCommand` | 325 |
| `makeRouter` | 203 |
| `printHelp` | 197 |
| `runSingleTurn` | 158 |
| `parseCliArgs` | 150 |

这是全仓最大的单点复杂度来源，也是 P2-8（重复实现工作区检查）的成因 —— 文件太大，作者找不到已有的 helper，就地又写了一个。

建议按已有的目录约定拆分（`cli/` 下已经有 `pasteAccumulator.ts`、`thinkingMeter.ts`、`degenerateLoopGuard.ts` 这些良性拆分的先例）：

- `cli/repl/` — REPL 循环、按键处理、bracketed paste
- `cli/commands/` — `/experience`、`/principle`、`/anchor`、`/delete`、`/team` 等斜杠命令各一个文件
- `cli/render/` — 流式输出、颜色、截断、meter
- `cli/args.ts` — `parseCliArgs` + `printHelp`

### P4-2 · 测试覆盖存在明显盲区

| 模块 | 源文件 | 测试文件 | 备注 |
| --- | --- | --- | --- |
| `sandbox/` | 9 | **1** | **安全关键**，profile 生成器几乎无测试 |
| `units/` | 5 | **0** | 量纲系统，纯函数，最好测 |
| `provenance/` | 3 | **0** | 溯源，README 强调的卖点 |
| `validation/` | 7 | 1 | V&V hook |
| `tools/` | 54 | 13 | |
| `core/` | 76 | 37 | 良好 |
| `kernel/` | 43 | 34 | 良好 |
| `loop/` | 51 | 31 | 良好 |

`sandbox/` 只有 1 个测试文件，而本次审查的 P1-1/P1-3/P2-2 全部落在这个模块 —— 覆盖率和缺陷密度的相关性非常直观。建议优先补：

- `buildBwrapArgs` / `buildMacOSProfile` 的快照测试（把生成的参数/profile 固化下来，任何改动都必须显式确认）
- 一组"逃逸用例表"驱动 `PermissionPolicy`：每条命令 + 期望 allow/deny，把本报告里的实测表格直接变成回归测试

### P4-3 · 死代码墓碑文件

以下文件已无任何引用，内容只是一句"已删除/已废弃"：

- `src/core/auto_orch/` — 22 个文件，合计 35 行（且 `package.json` 已用 `!dist/core/auto_orch/**` 排除出发布包）
- `src/robotics/validation/HardwareSafetyChecker.ts` — `// Deleted: HardwareSafetyChecker was removed.`
- `src/cli/teamWriteGuard.ts` — 仅被一个"验证它已废弃"的测试引用
- `src/cc-kernel/KernelBridge.ts` — `@deprecated` re-export shim

保留 `@deprecated` re-export（`KernelBridge`）是合理的向后兼容做法；但纯墓碑文件（`auto_orch/`、`HardwareSafetyChecker`）建议直接删除 —— git 历史已经保存了它们，留在树里只会让 `grep` 和新人困惑。

### P4-4 · 类型安全整体优秀

- `strict: true`，`tsc --noEmit` 0 错误
- 全仓 `as any` / `: any` 仅 **23** 处
- `@ts-ignore` / `@ts-expect-error` 仅 **5** 处
- 118 处非空断言（`!`），多数在已有 Map 查找保证的位置

这个数字在 8 万行的代码库里非常健康，值得保持。

### P4-5 · 空 catch 块数量较多（约 115 处 swallow 模式）

大部分是有意的 best-effort（注释都写了 "best-effort"、"accounting must never take down the loop"），这是对的。但建议引入一个约定：**所有故意吞掉的异常都必须有一行注释说明为什么可以吞**。目前大约 80% 做到了，剩下的裸 `catch {}` 值得回头补注释或补日志 —— 否则将来出现"某个功能静默不工作"的问题时，会非常难排查。

---

## 修复优先级建议

| # | 问题 | 工作量 | 影响 |
| --- | --- | --- | --- |
| 1 | **P1-1** 沙箱加默认 `readDenyPaths`（key/凭证目录） | S | 堵住主要外泄路径 |
| 2 | **P1-2** 让 `permissions.json` 的 `bash.sensitive` 生效 | XS | 恢复用户对最危险工具的控制权 |
| 3 | **P2-2** `detect.ts` 的 `require` → `import` | XS | 修复失效的嵌套沙箱检测 |
| 4 | **P1-3** `/dev/` 豁免改白名单 | XS | |
| 5 | **P1-4** 沙箱降级时告警 + 在 env 输出里暴露后端 | S | 消除"以为有沙箱"的错觉 |
| 6 | **P2-7** `.finally(async)` 顺序调整 | XS | 消除一条 CLI 崩溃路径 |
| 7 | **P2-3** `withFileLock` 持锁续期 | S | 修复长临界区的互斥破坏 |
| 8 | **P3-4** NUL 字节 → `\x00` | XS | 让两个核心文件重新可 grep/可 review |
| 9 | **P2-5** MCP stdio env 过滤 | S | 与 shell 的凭证策略对齐 |
| 10 | **P4-2** 补 `sandbox/` + PermissionPolicy 的逃逸用例表测试 | M | 防止上述修复回归 |
| 11 | **P2-8 / P3-3** 收敛三份工作区边界实现到 `workspaceGuard` | M | 消除已知漂移 |
| 12 | **P2-6** MCP stdio 改长驻进程 | M | 修复有状态 MCP 的语义 + 终端污染 |
| 13 | **P4-1** 拆分 `cli/index.ts` | L | 降低长期复杂度 |

---

## 修复记录

### 已修复

| 编号 | 问题 | 落地方式 |
| --- | --- | --- |
| **P1-2** | `permissions.json` 的 `bash.sensitive` 被忽略 | `PermissionPolicy.ts` 把**用户配置**与合并后的声明分开读。shell 工具内建的 `sensitive: true` 仍表示"命中模式才问"（否则每条 `ls` 都要确认），但 `permissions.json` 的显式覆盖现在双向生效：`true` = 每条都问，`false` = 一律不问 |
| **P1-3** | `/dev/` 前缀无条件豁免 | 改为白名单（`ALLOWED_DEV_PATHS` + `/dev/fd/N`）。**顺带找到真正的根因**：`KNOWN_OS_ROOT_DIRS` 里根本没有 `dev`，所以 `/dev/*` 在扫描的第一步就被跳过了 —— 原来的豁免其实是死代码，只是让这个洞看起来像是有意为之。补上 `dev` 后 `dd of=/dev/sda`、`mkfs /dev/nvme0n1`、`> /dev/sdb` 全部被拒绝 |
| **P1-4** | 沙箱静默降级 | `createSandboxExecutor()` 降级时打一次醒目 stderr 警告并说明原因与修法；新增 `describeSandboxBackend()`，`meta-agent env` 顶部现在直接显示后端与是否真正生效（`--json` 里也有 `sandbox` 字段，方便脚本做 preflight） |
| **P2-2** | `detect.ts` 的 ESM `require` | 改为顶部静态 `import { readFileSync } from 'node:fs'`。**已在本机实测确认修复生效**：当前环境本身就嵌套在 bwrap 内、`BWRAP_SANDBOX_PID` 未设置，修复后 `isInsideBwrap()` 正确返回 `true`（走 `/proc/1/cmdline` 探测），修复前该分支必然抛 `ReferenceError` 并被吞掉 |
| **P2-3** | `withFileLock` 持锁不续期 | 持锁期间按 `staleMs/3` 心跳 `utimes`，`finally` 里 `clearInterval`。`staleMs` 现在名副其实 —— "持有者停止心跳即视为已死"，而不是"从获取算起超过 N 秒" |
| **P2-5** | MCP stdio 泄露全量 env | 新增 `infra/env/childProcessEnv.ts`，把凭证过滤策略从 bash 工具内部提取为**所有子进程共用**的一处规则；MCP 默认走 `filtered`，`mcp.json` 的 `env` 字段成为"哪个 server 能看到哪个密钥"的审计点 |
| **P2-6** | MCP stdio 每次 RPC 新起进程 | 重写为**每个 server 一个长驻进程** + 按 id 路由响应 + 换行分帧（MCP stdio 规范的框架方式）；stderr 从 `inherit` 改为 `pipe` 并加 `[mcp:<name>]` 前缀，不再污染终端；进程死亡只失败当次调用，下次调用惰性重启；`disposeMcpClients()` 接入 CLI 退出清理 |
| **P2-7** | `.finally(async)` 未捕获拒绝 | `catch` 移到最后；同时把**槽位释放**提到所有可能抛出的步骤之前 —— 原来若结算抛错，`runners`/`activeTaskIds` 不会被清理，bridge 会一直以为席位被占，队列静默死锁 |
| **P2-8 / P3-3** | 三份工作区边界实现 | `canonicalizeForGuard` / `pathIsUnder` 从 `workspaceGuard.ts` 导出；`SubAgentRunner` 删除逐行复制的私有副本（并把策略根的 `realpathSync` 从每字段循环内提到闭包外）；CLI 的 `detectSensitiveOp` 改用 `isInsideWorkspace`，不再用 `startsWith`（原先 `/home/u/proj-backup` 会被当成在 `/home/u/proj` 内而**不弹确认框**） |
| **P3-1** | `~` / `..` 误报 | 收紧为"路径形态"判定：`~`/`..` 后必须是 `/`、引号、命令结束，或空白后跟 shell 分隔符。`awk '$1 ~ /error/'`、`perl -ne '$_ =~ /x/'`、`[[ $x =~ ^foo ]]`、`echo "a .. b"` 全部恢复可用，而 `cat ~/.ssh/id_rsa`、`rm -rf ~`、`cd .. ; ls` 仍被拒绝 |
| **P3-4** | 源码内嵌 NUL 字节 | 4 个文件（比初版报告多找到 2 个：`GitWorkspaceManager.ts`、`findRelevantMemories.ts`）的字面 NUL 替换为 `\x00` 转义。现在 `src/` 下**没有任何文件**被工具当作二进制 |
| **P3-7 / P3-8** | tmp 残留、`.corrupt` 互相覆盖 | `atomicWriteJson/File` 失败时清理 tmp；隔离文件名加时间戳 |
| **P4-2** | 安全回归测试缺失 | 新增 3 个测试文件、64 个用例：`workspaceEscapeTable.test.ts`（41 例逃逸表，含一个**故意断言"仍能绕过"**的 known-bypass 区块，用来钉死这一层的能力边界）、`profileContract.test.ts`（bwrap/Seatbelt profile 契约 + 两条 `DOCUMENTED GAP`）、`lockHeartbeat.test.ts`（锁续期/不误抢/仍能回收真孤儿锁） |
| **P4-1** | `cli/index.ts` 6,200 行 | 拆为 **18 个模块**，入口 `index.ts` 剩 **98 行**（只做 argv → dispatch）。已用脚本验证 `cli/` **无循环依赖** |

**修复过程中新发现并一并修掉的问题**（都不在初版报告里）：

1. `KNOWN_OS_ROOT_DIRS` 缺 `dev` —— 这才是 `/dev/` 写入能通过的真正原因（见上表 P1-3）。
2. `SubAgentBridge` 结算路径抛错会**泄漏并发槽位**导致队列死锁（P2-7 的第二个失败模式）。
3. 新写的 MCP 长驻客户端第一版有**代际竞态**：被 kill 的进程其 `close` 事件晚一拍才触发，会误杀已经重启的新进程、并用上一代的错误拒绝新请求。测试直接暴露了它（超时用例收到的是 "exited with code" 而非 "timed out"），已用 `source` 代际校验修掉。
4. 另外 2 个含 NUL 字节的源文件。

### 确认不修

**P1-1（沙箱只挡写不挡读 / 网络默认放开）** —— 按你的决定保留现状。已做的事：在 `profileContract.test.ts` 里为 bwrap 和 Seatbelt 各写一条 `DOCUMENTED GAP` 用例，断言"默认没有 read-deny、没有 `--unshare-net`"。这样这个缺口在测试套件里是**显式且持续可见**的；将来要收口时，改动点是 `DEFAULT_MAIN_SANDBOX` 加一组默认 `readDenyPaths`，两条用例会立刻提示你策略变了。

### 未完成的部分（诚实说明）

`cli/repl.ts` 仍有 1,673 行，其中 `runRepl` 内的 slash 命令分发块（约 295 行）没有继续外提。原因不是懒：这段代码引用了 `runRepl` 的 **25 个闭包变量，其中 12 个会被它写回**（包括 `router` 本身被重新赋值）。把它搬出去意味着要构造一个 12 槽的可变 context 对象穿进去 —— 那不是"拆分"，而是把闭包换成对象再加一层间接，可读性没有净收益，而交互式终端逻辑目前**没有任何测试覆盖**，回归风险实打实。

正确的下一步是分两步走，而不是硬拆：先把 REPL 的会话状态显式建模成一个 `ReplSession` 类（状态从闭包变量变成字段，这一步本身可测），再把 slash 命令拆成 `commands/slash.ts` 里接收 `ReplSession` 的纯函数。这是一个独立的、可以单独验证的改动。

### 拆分后的 `cli/` 结构

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `index.ts` | **98** | 仅 argv 解析 → 分发 |
| `args.ts` | 446 | 帮助文本、flag 解析、`CliOptions` |
| `term.ts` | 93 | 颜色、消毒输出、stdout 背压、thinking-meter 注册表 |
| `env.ts` | 83 | `meta-agent env` 报告（含沙箱后端） |
| `keys.ts` | 95 | API key 消毒/校验 |
| `limits.ts` | 16 | 轮数常量（避免 args ↔ router 循环依赖） |
| `prompts.ts` | 103 | readline 提问、工作区确认 |
| `hardware.ts` | 258 | 机器人硬件档案选择/创建 |
| `guards.ts` | 163 | 敏感操作交互确认 |
| `router.ts` | 204 | `CliOptions` → `SessionRouter` |
| `stream.ts` | 443 | 渲染一个模型回合 |
| `sessionFlow.ts` | 196 | 恢复选择器、快照、auto 续跑 arming |
| `sideCalls.ts` | 320 | CLI 自用的 flash 侧调用 |
| `transcript.ts` | 94 | 消息 → 展示字符串 |
| `mcpInstructions.ts` | 37 | 惰性注册的 MCP server instructions |
| `repl.ts` | 1,673 | 交互循环（见上文说明） |
| `singleTurn.ts` | 439 | 一次性 / auto-scheduler / attached-auto |
| `commands/team.ts` | 757 | 团队看板 |
| `commands/loop.ts` | 558 | loop 子命令 |
| `commands/review.ts` | 329 | 经验/记忆/原则/锚点审核 |
| `commands/deletion.ts` | 210 | `/delete` |

---

## 附：本次审查的验证方式

- `npx tsc --noEmit` → 0 错误
- `npx vitest run` → 178 文件 / 1450 用例全绿
- P1-2、P1-3、P2-1、P3-1 通过临时挂载真实 `createPermissionPolicy` 的 vitest 用例**实测确认**（用例已删除，未留在树中）
- P2-2 通过 `node` 直接执行 ESM 模块中的 `require('fs')` **实测确认**抛 `ReferenceError`，并在 `dist/sandbox/detect.js:121` 确认编译产物原样保留
- 其余结论均基于源码逐行阅读，报告中给出了文件名与行号
