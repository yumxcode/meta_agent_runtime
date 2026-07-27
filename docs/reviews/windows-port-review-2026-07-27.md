# meta-agent Windows 部署审查与迁移方案

- 审查对象：`@meta-agent/runtime` v0.7.9（`main` @ 73d58f3）
- 审查范围：`src/` 全量 554 个 TS 文件，非测试代码约 75,286 行；`scripts/`、`package.json`、`vitest.config.ts`
- 日期：2026-07-27
- 目标：让 meta-agent 能部署到 Windows 机器

---

## 0. 结论摘要

**这个代码库的可移植性底子比预期好，但存在 4 个"跑不起来"级别的硬阻塞，和一个必须重写的安全边界。**

底子好的证据：

- 纯 TypeScript / ESM，运行时依赖只有 `@anthropic-ai/sdk`、`openai`、`zod` 三个纯 JS 包，**零原生扩展**，`npm i` 在 Windows 上不会有编译问题
- 路径处理普遍走 `node:path` 的 `join/resolve/isAbsolute/relative/sep`，而不是字符串拼 `/`（`src/tools/fs/workspaceGuard.ts`、`src/subagent/SubAgentRunner.ts:956-970`、`src/loop/graph/registry/CapabilityPack.ts:139` 都是正确写法）
- `graphHash` 基于结构化 canonical JSON 计算（`src/loop/graph/spec/GraphValidate.ts:283`），**不读原始字节**，所以 CRLF 不会导致 loop 图哈希漂移——这一条如果没做对，整个 durable loop 在 Windows 上会全面失效
- 持久层已经意识到平台差异（`src/infra/persist/index.ts` 注释明确写了 "atomic on POSIX; best-effort on Windows"），锁用的是 `open(path,'wx')` 这种跨平台原语
- 已有 3 处 `process.platform !== 'win32'` 分支，且**已经存在一个 `powershell` 工具**（`src/tools/shell/powershell/index.ts`），说明作者原本就留了 Windows 的口子
- 164 个测试文件中只有 13 个含 POSIX 硬编码

底子差的地方集中在三处：**构建脚本、shell 执行链、安全边界**。

### 路线推荐

| 路线 | 改造量 | 能力损失 | 建议 |
|---|---|---|---|
| **WSL2**（推荐先落地） | ~0.5 人日（只做打包与文档） | 跨 `/mnt/c` 时文件锁与性能退化；对 Windows 原生 GPU 训练脚本调用不便 | **第一阶段交付走这条**，两天内可用 |
| **Docker Desktop** | ~1 人日 | 同上，且 `~/.meta-agent` 与 host 隔离、GPU 直通受限 | 适合无状态批量场景，不适合当交互 CLI |
| **原生 win32** | **~15–22 人日**（下文分阶段） | 沙箱能力永久缺失（无 sandbox-exec/bwrap 等价物），需接受 Noop 或改用 Job Object 弱隔离 | **第二阶段目标**，价值在于能直接驱动 Windows 上的 CUDA/ROS/仿真工具链 |

**建议采用双轨**：立刻用 WSL2 解决"能在 Windows 机器上跑"，同时按下文 Phase 1–5 推进原生 win32，两者共用同一份代码。

---

## 1. P0 阻塞项 —— 不修就跑不起来

### P0-1. 构建脚本的 esbuild 插件正则在 Windows 上不匹配 → CLI 启动即崩

`scripts/build-cli.js:47`

```js
build.onLoad({ filter: /\/tools\/[^/]+(?:\/[^/]+)*\.(ts|js)$/ }, async (args) => {
```

esbuild 的 `args.path` 在 Windows 上使用平台原生分隔符（反斜杠），这个只认正斜杠的 filter 会**一个文件都匹配不上**。后果不是构建报错，而是静默降级：所有 `await loadToolPrompt(import.meta.url)` 没有被内联，打包进 `dist/cli.mjs` 后 `import.meta.url` 指向 `dist/cli.mjs`，每个工具去找 `dist/prompt.md` → ENOENT → 工具注册阶段抛异常，CLI 完全起不来。

**改法**：filter 改为 `/[\\/]tools[\\/].*\.(ts|js)$/`，并在 `onLoad` 内 `const norm = args.path.replace(/\\/g, '/')` 后再做后续判断。

**验证**（Phase 0 第一件事，5 分钟）：在插件里 `console.log(args.path)` 跑一次 Windows 构建，确认分隔符形态。

同一文件 `scripts/build-cli.js:107` 的 `chmod(dist/cli.mjs, 0o755)` 在 Windows 是 no-op，不报错，无需处理。

### P0-2. 所有 shell 执行硬编码 `bash` → 每一次 bash 工具调用都 ENOENT

三个汇聚点：

- `src/tools/shell/bash/index.ts:335`：`: { file: 'bash', args: ['-c', command] }`
- `src/sandbox/NoopSandboxExecutor.ts:26`：`return { file: 'bash', args: ['-c', command] }` ——**Windows 上必然走这条**，因为 `createSandboxExecutor()`（`src/sandbox/index.ts:41`）只识别 macOS/Linux，其余一律 Noop
- `src/tools/system/cron_create/index.ts:44`：`execFileAsync('bash', ['-c', command])`

Windows 默认没有 `bash`（除非装了 Git Bash 且在 PATH 上）。而 `bash` 是 graph agent 的默认工具集成员（`src/loop/graph/runtime/NodeExecutors.ts:133`、`GraphCatalog.ts:23`、`GraphValidate.ts:261`），所以**loop 的每个 agent 节点都会在第一次执行 shell 时失败**。

**改法**：新增 `src/infra/platform/shell.ts`，导出

```ts
export function defaultShellSpec(command: string): SandboxExecSpec {
  if (process.platform !== 'win32') return { file: 'bash', args: ['-c', command] }
  // 优先 pwsh > powershell.exe > cmd.exe；也可显式配置 META_AGENT_SHELL
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] }
}
```

三个调用点统一改为调它。注意 `bash` 工具的 `name` 和 prompt.md 描述也要在 Windows 上换成 PowerShell 语义，否则模型会持续生成 `ls -la`、`grep`、`&&` 这类在 `cmd.exe` 下无效、在 PowerShell 下语义不同的命令（PowerShell 7 支持 `&&`，Windows PowerShell 5.1 不支持——这是选 `pwsh` 优先的原因）。

### P0-3. MCP stdio 子进程无法在 Windows 启动

`src/tools/mcp/mcpConfigFile.ts:159`

```js
const child = spawn(cfg.command, cfg.args ?? [], { cwd, env, stdio, detached: useProcessGroup })
```

绝大多数 MCP server 配置的 `command` 是 `npx` / `uvx` / `node`。Windows 上这些是 `npx.cmd` / `uvx.exe`：

- `spawn('npx', ...)` 不带 `shell` → ENOENT（不会自动补 `.cmd`）
- 自 Node 18.20 / 20.12 起，不带 `shell:true` 直接 spawn `.cmd`/`.bat` 会抛 EINVAL（CVE-2024-27980 的修复）

**改法**：Windows 分支下先用 PATHEXT 解析出真实可执行文件；若解析结果是 `.cmd`/`.bat`，走 `spawn(cmd, args, { shell: true })` 并对参数做 Windows 引用转义（或直接使用 `cross-spawn`，但会引入新依赖，需权衡）。

### P0-4. `commandOnPath` 不识别 PATHEXT → loop 前置条件校验全线误报

`src/loop/cli.ts:215-224`

```ts
const candidate = join(dir, command)
await access(candidate, fsConstants.X_OK)
```

Windows 上 `git` 的实际文件是 `git.exe`，`join(dir,'git')` 不存在；且 Node 文档明确 `X_OK` 在 Windows 上等同 `F_OK`（无执行位概念）。结果是 `loop.preconditions.json` 里所有 `kind: "command"` 的项目一律判为"不在 PATH"，`blocking: true` 时直接阻止 `loop create`。

**改法**：Windows 下遍历 `(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')` 逐个拼后缀探测，且只用 `F_OK`。

---

## 2. P1 —— 能启动但功能损坏或安全降级

### P1-1.（安全）workspace 越权扫描对 Windows 绝对路径完全失明

`src/kernel/permissions/PermissionPolicy.ts:214`

```ts
const absPathPattern = /(?:^|[\s'"=:])(\/(?:[^\s'"`$;&|()<>]+\/?)+)/g
```

这个正则只捕获以 `/` 开头的路径。Windows 的绝对路径形如 `C:\Windows\System32\...`、`\\server\share\...`、`C:/Users/...`。因此 shell 命令里的越权路径**一个都扫不到**——`Get-Content C:\Users\yumx\.ssh\id_rsa` 会畅通无阻。

同一文件 `:189` 的 `READONLY_SYSTEM_PATH_PREFIXES`（`/usr/bin/`、`/bin/`、`/System/Library/` …）和 `:228` 的 `/tmp/`、`/var/tmp/`、`/dev/` 白名单在 Windows 上全是死代码，没有 `C:\Windows\System32`、`%TEMP%`、`NUL`、`CON` 的等价物。

**这是整个迁移里唯一的安全级问题**，必须在开放 Windows shell 之前修完。改法：把路径扫描抽成 `extractAbsolutePaths(command, platform)`，Windows 分支同时匹配 `[A-Za-z]:[\\/]`、UNC `\\\\`、以及 `%VAR%` 展开后的路径；白名单换成 `%SystemRoot%`、`%ProgramFiles%`、`%TEMP%` 三组。

### P1-2. workspace 边界比较大小写敏感 → Windows 上大量误拒

`src/tools/fs/workspaceGuard.ts:33 / 61`

```ts
return target === workspace || target.startsWith(workspace.endsWith(sep) ? workspace : workspace + sep)
```

Windows 文件系统大小写不敏感，`C:\Users\yumx\proj` 与 `c:\users\yumx\proj` 指向同一目录，但这里是逐字节比较。`realpathSync` 在 Windows 上会规范化大部分路径，但盘符大小写、8.3 短名（`PROGRA~1`）仍可能不一致。表现是 fail-closed（误拒），不是安全漏洞，但会让 `bash`/`edit_file`/`write_file` 随机报 "path is outside workspace"。

`src/tools/shell/powershell/index.ts:10-14`（比较在 `:13`） 有同一逻辑的**第二份拷贝**，也有同样问题（注释里说 workspaceGuard 是"单一事实源"，但 powershell 工具没用它——顺手统一掉）。

**改法**：抽 `samePathPrefix(a, b)`，win32 下 `toLowerCase()` 后比较。

### P1-3. `edit_file` 无换行归一 → Windows 上编辑成功率暴跌

`src/tools/fs/edit_file/index.ts:83` 用 `content.split(oldStr)` 做纯精确匹配；`src/tools/fs/read_file/index.ts:72` 用 `raw.split('\n')`，CRLF 文件每行尾部残留 `\r`。

Windows 上 git 默认 `core.autocrlf=true`，工作区文件是 CRLF。模型看到带 `\r` 的行、回传时往往丢掉 `\r`（或反之），`split(oldStr)` 直接匹配失败。这不会崩，但会让 agent 的每次编辑都失败，实际等同于工具不可用。

**改法**：`edit_file` 在匹配前检测文件主导换行符；用 LF 归一化后匹配，写回时还原为原文件的换行风格。这是 Windows 代码 agent 的标准做法，不做的话 Phase 2 之后仍然不可用。

### P1-4. Windows 没有沙箱实现

`src/sandbox/` 只有 macOS（`sandbox-exec`）和 Linux（`bwrap`）两个后端，Windows 一律 Noop。`src/subagent/SubAgentRunner.ts:688` 会用沙箱版 bash 替换普通 bash；严格策略下 `allowUnsandboxedFallback=false` 时应当 fail-closed（`src/sandbox/index.ts:35` 注释如此声明），即**Windows 上任何要求强沙箱的 sub-agent 都无法运行**。

Windows 没有 `sandbox-exec`/`bwrap` 的直接等价物。可选方案，按投入排序：

1. **接受现状**：Windows 只支持 `allowUnsandboxedFallback: true`，在 CLI 启动时打印显式警告（照抄 `src/cli/bwrapCheck.ts` 的模式，加一个 `getMissingWindowsSandboxWarning()`）。**建议先做这个。**
2. **Job Object + 受限令牌**：能做进程树管控和资源上限，但做不到文件系统路径级隔离。需要原生模块（`node-windows` 之类），破坏"零原生依赖"这一优势。
3. **AppContainer / Windows Sandbox**：隔离强，但启动开销大（秒级），且 Windows Sandbox 每次都是全新镜像，与 loop 的持久 workspace 语义冲突。不推荐。

`src/subagent/SubAgentRunner.ts:920-922` 的写白名单里 `resolve('/tmp')`、`resolve('/private/tmp')` 在 Windows 上会变成 `C:\tmp`、`C:\private\tmp`（当前盘符），无害但无意义，应换成 `tmpdir()` 单独一项。

### P1-5. `'empty'` env 策略会让 Windows 子进程起不来

`src/tools/shell/bash/index.ts:77`

```ts
const MINIMAL_ENV_KEYS = ['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TZ','SHELL','TMPDIR','TEMP','TMP']
```

缺 `SystemRoot`、`windir`、`ComSpec`、`PATHEXT`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`。Windows 上没有 `SystemRoot` 的子进程在 winsock 初始化阶段就会失败。默认策略是 `'filtered'`（不受影响），所以这条只在显式配置 `'empty'` 时爆炸——但一旦爆炸表现极其难查。

---

## 3. P2 —— 可靠性与边角

| # | 位置 | 问题 | 改法 |
|---|---|---|---|
| P2-1 | `src/infra/persist/index.ts:87,100` | `rename(tmp, filePath)` 在 Windows 上若目标被杀软/索引器/另一进程打开会 EPERM/EBUSY。当前无重试，会把可恢复的瞬时错误升级成写失败 | 加指数退避重试（3 次，10/50/200ms），只对 EPERM/EBUSY/EACCES |
| P2-2 | `src/infra/persist/index.ts:245` `deleteJsonFile`、各处 `rm(...)` | 同上，删除被占用文件在 Windows 上失败 | 同样加重试；`rm(recursive)` 尤其需要 |
| P2-3 | `src/loop/daemon.ts:198` `isAlive()` | `process.kill(pid, 0)` 在 Windows 上进程存在但权限不足时抛 EPERM，被 catch 成"已死" → 可能抢走活锁 → 双 scheduler 并发 | 区分 EPERM（视为存活）与 ESRCH（视为已死） |
| P2-4 | `src/loop/daemon.ts:172` `link(tmpPath, lockPath)` | NTFS 支持硬链接，可用；但在 FAT32/exFAT U 盘、SMB 网络盘、部分 WSL `/mnt` 挂载上 `link` 会 EPERM，导致锁永远拿不到、scheduler 静默返回 `lock_held` | 加 `link` 失败回退到 `open(lockPath,'wx')`（原子性略弱但可用），并在日志里说明 |
| P2-5 | `src/loop/graph/runtime/GraphStore.ts:122` | instanceId 正则 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` 允许 `con`、`prn`、`aux`、`nul`、`com1`–`com9`、`lpt1`–`lpt9`，这些在 Windows 上无法作为目录名；也允许结尾 `.` | Windows 分支追加保留名与结尾点校验 |
| P2-6 | 路径长度 | `~/.meta-agent/sessions/loop-ws-<36>-<instanceId≤128>-lane-<lane>/history.jsonl`，instanceId 取满 128 时总长可逼近 260 | 要么把 sessionId 超长时改用 sha256 前 16 位，要么在安装文档里要求开启 `LongPathsEnabled` |
| P2-7 | 仓库根 | 无 `.gitattributes` | 加 `* text=auto eol=lf` + `*.md text eol=lf`，防止 `prompt.md`、fixtures 被 autocrlf 污染导致哈希/快照测试漂移 |
| P2-8 | `src/core/auto/verify/JudgeSnapshot.ts:106,120` | `mkdtempSync(join(tmpdir(),...))` 已经用 `tmpdir()`，OK；但 `src/cli/index.ts:1044,1070` 的 `startsWith('/tmp')`、`startsWith('/dev')` 是 POSIX 硬编码，只影响展示逻辑 | 低优先，随 P1-1 一起改 |
| P2-9 | 13 个测试文件（`src/core/fs/__tests__/WriteMutex.test.ts`、`src/robotics/__tests__/*` 等）硬编码 `/tmp/...` | Windows 上 `resolve('/tmp/x')` → `C:\tmp\x`，多数只做字符串比较所以能过，少数会失败 | 改为 `join(tmpdir(), ...)` |
| P2-10 | `src/loop/host/HostSchedulerCoordinator.ts:151` | `existing.workspaceRoot === workspaceRoot` 大小写敏感，Windows 上可能把同一 workspace 的冲突报成"两个不同路径" | 与 P1-2 共用 `samePathPrefix` |
| P2-11 | `src/tools/fs/grep/index.ts:16` | `rg` 不在 PATH 时有纯 JS 回退（`:95` readdir 遍历），**无需处理**，但性能会显著下降 | 安装文档建议装 ripgrep |
| P2-12 | 20 处 `execFile('git', ...)` | Git for Windows 可用，无阻塞；但 `AutoWorktreeCoordinator` 的 worktree 路径与 `TeamStore` 的分支操作需在 Windows 实测（worktree + 长路径 + 文件占用是已知易碎组合） | 列入 Phase 4 集成测试 |

---

## 4. 三条路线详评

### 4.1 WSL2（推荐先行）

- **改动量**：接近零。整套代码在 WSL2 的 Ubuntu 里就是 Linux 部署，`bwrap` 可 apt 安装，沙箱能力完整保留。
- **注意事项**：
  - workspace **必须放在 WSL 文件系统内**（`~/code/...`），不要放 `/mnt/c/...`。跨 9P/DrvFs 挂载时 `link()`、`rename()` 的原子性和 `mtime` 精度都不可靠，会直接影响 `daemon.lock`、`withFileLock`、以及 `WakeStore` 的 stale 判定。这是最大的坑。
  - `~/.meta-agent` 在 WSL 内，与 Windows 侧不共享——如果用户期望在 Windows 资源管理器里看到产物，需要额外说明。
  - 调 Windows 侧程序（`nvidia-smi.exe`、Windows 版仿真器）可以走 interop（直接执行 `foo.exe`），但 cwd 和路径要手工转换（`wslpath`）。
- **交付物**：一份 `docs/deploy-windows-wsl2.md` + 一个 `scripts/setup-wsl2.sh`。

### 4.2 Docker Desktop

- **改动量**：写一个 Dockerfile（node:22-slim + git + ripgrep + bubblewrap），约 1 人日。
- **限制**：容器内跑 `bwrap` 需要 `--privileged` 或 seccomp 放宽；GPU 直通要 WSL2 backend + nvidia-container-toolkit；`~/.meta-agent` 需要 volume 持久化；交互式 CLI 体验差。
- **适用**：无人值守的 loop scheduler 服务化部署，不适合当日常 CLI。

### 4.3 原生 win32

- **改动量**：按下文 Phase 1–5，约 **15–22 人日**（含测试与 CI）。
- **永久损失**：OS 级沙箱。
- **收益**：直接驱动 Windows 上的 CUDA/ROS2/Isaac Sim/MATLAB 等工具链，无路径转换、无 interop 损耗——对 `F1_train_AMP` 这类机器人训练场景，这是唯一有意义的收益。

---

## 5. 分阶段迁移计划（原生 win32）

### Phase 0 — 基线与验证（1 人日）

1. Windows 11 + Node 22 + Git for Windows + ripgrep，`npm ci`，跑 `npm run typecheck`
2. **验证 P0-1**：在 esbuild 插件里打印 `args.path`，确认分隔符
3. 跑 `npx vitest run`，记录失败清单（预期 13 个 POSIX 测试 + 若干持久层测试失败）
4. 加 `.gitattributes`（P2-7）——**必须在其他人开始改之前做**，否则后面所有 diff 都会被换行污染

**产出**：一份"Windows 基线失败清单"，作为后续验收的对照。

### Phase 1 — 让它能构建、能启动（2–3 人日）

- 修 P0-1（build-cli.js filter 归一）
- 新增 `src/infra/platform/`：`shell.ts`（`defaultShellSpec`）、`paths.ts`（`samePathPrefix`、`isReservedWindowsName`）、`which.ts`（PATHEXT 感知）
- 修 P0-4（`commandOnPath` 用 `which.ts`）
- 补 P1-5（`MINIMAL_ENV_KEYS` 加 Windows 必需项）

**验收**：`npm run build` 成功；`meta-agent --help`、`meta-agent loop list` 在 PowerShell 里正常输出。

### Phase 2 — shell 执行链（3–4 人日）

- 修 P0-2：三个 `file: 'bash'` 调用点统一走 `defaultShellSpec`
- 修 P0-3：MCP spawn 的 `.cmd` 处理
- `bash` 工具在 win32 下改名/改描述为 PowerShell 语义，或保留 `bash` 名但在 prompt 里注入平台说明（**建议后者**：改工具名会让所有 `loop.graph.json` 的 `node.tools` 声明失效，`GraphValidate.ts:261` 会校验失败，等于让所有已有 loop 图不可用）
- 修 P1-3（`edit_file` CRLF 归一）——不做这条，Phase 3 之后 agent 仍然干不了活

**验收**：一个最小 graph loop（单 agent 节点，执行 `dir` + `read_file` + `edit_file`）跑通一个完整 tick。

### Phase 3 — 安全边界（3–4 人日）

- 修 P1-1：`extractAbsolutePaths(command, platform)` + Windows 白名单
- 修 P1-2：`samePathPrefix` 替换 3 处大小写敏感比较（workspaceGuard ×2、powershell 工具 ×1、HostSchedulerCoordinator ×1）
- 修 P1-4 方案 1：Windows 启动警告 + 严格沙箱策略明确拒绝并给出可读原因
- 补 P2-5（保留名校验）

**验收**：新增一组 `src/kernel/permissions/__tests__/windowsEscape.test.ts`，覆盖 `C:\`、UNC、`%TEMP%`、大小写混写、8.3 短名，全部正确拦截/放行。

### Phase 4 — 持久层与并发加固（3–5 人日）

- 修 P2-1/P2-2：`atomicWriteJson`/`atomicWriteFile`/`deleteJsonFile`/`rm` 的 EPERM/EBUSY 退避重试
- 修 P2-3：`isAlive` 区分 EPERM/ESRCH
- 修 P2-4：`link` 失败回退
- 修 P2-6：sessionId 超长时哈希化
- 修 P2-9：测试里的 `/tmp` → `tmpdir()`
- **压力测试**：两个 `loop-scheduler` 进程同时抢同一 workspace，验证 `daemon.lock` 互斥；杀软开启状态下跑 1000 次 `atomicWriteJson` 验证零失败

**验收**：`vitest run` 全绿；scheduler 双开测试通过。

### Phase 5 — CI 与发布（2–3 人日）

- 仓库目前**没有任何 CI**（无 `.github/workflows`）。补一个三平台矩阵：`ubuntu-latest` / `macos-latest` / `windows-latest`，跑 `typecheck` + `build` + `vitest run`
- `npm pack` 产物在 Windows 上验证 `bin` shim（npm 会自动生成 `meta-agent.cmd` 和 `meta-agent.ps1`，无需手工处理）
- 写 `docs/deploy-windows.md`：Node 版本、Git for Windows、ripgrep、`LongPathsEnabled`、杀软排除目录（`~/.meta-agent` 和 workspace）、沙箱能力说明

---

## 6. 建议的代码组织

新增一个薄的平台适配层，把散落的 `process.platform` 判断收敛到一处：

```
src/infra/platform/
  index.ts        // 统一导出
  shell.ts        // defaultShellSpec / shellKind
  which.ts        // PATHEXT 感知的可执行解析
  paths.ts        // samePathPrefix / isReservedName / normalizeSep
  fsRetry.ts      // withWindowsRetry(fn) — EPERM/EBUSY 退避
  env.ts          // 平台最小 env 集
```

原则：**业务代码里不应再出现 `process.platform`**，只 import 这一层。目前全仓只有 5 处 `process.platform`，现在收敛成本最低。

---

## 7. 明确不做的事

- **不引入 `cross-spawn`/`fs-extra`/`which` 等依赖**（除非 Phase 2 实测证明手写 `.cmd` 处理太脆）。零原生依赖 + 3 个运行时依赖是这个库当前的重要资产，不该为可移植性放弃。
- **不做 Windows 原生沙箱**。投入产出比不成立，且会引入原生模块。明确文档化"Windows 上无 OS 级沙箱"。
- **不改 `graphHash` / journal 格式**。它们已经是平台无关的，动了会让现有 loop 实例全部失效。
- **不为 Windows 单独 fork 分支**。所有改动都是运行时分支，单一代码库三平台。

---

## 8. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 模型在 PowerShell 下持续生成 bash 语法命令 | 高 | agent 效率显著下降 | prompt 里注入平台与 shell 说明；bash 工具描述动态化（`dynamicDescription` 机制已存在，改造成本低） |
| 杀软导致 rename/unlink 间歇失败 | 中 | 持久层偶发写失败 | P2-1 重试 + 文档要求排除目录 |
| git worktree 在 Windows 上的占用/长路径问题 | 中 | `AutoWorktreeCoordinator`、`TeamStore` 不可用 | Phase 4 专项集成测试；必要时 Windows 上降级为不使用 worktree |
| 现有 `loop.graph.json` 里 `node.tools` 含 `bash` | 确定 | 若改工具名则全部失效 | Phase 2 决定保留 `bash` 名，只换底层执行器 |

---

## 附：本次审查已确认为**非问题**的项

避免后续重复排查：

- `graphHash` 不受 CRLF 影响（基于 canonical JSON 而非文件字节）
- `process.env.PATH` 在 Windows 上可用（Node 的 `process.env` 在 win32 上是大小写不敏感的）
- `fs.link` 在 NTFS 上支持；`fs.rename` 在 Windows 上会覆盖已存在目标
- `open(path, 'wx')` 的原子性在 Windows 上成立（`withFileLock` 可用）
- npm `bin` 字段会在 Windows 自动生成 `.cmd`/`.ps1` shim，shebang 无需处理
- `chmod(…, 0o755)` 在 Windows 是静默 no-op，不会抛错
- `grep` 工具在无 ripgrep 时有纯 JS 回退
- 无 `fs.watch` 使用（Windows 上 `fs.watch` 语义差异较大，正好避开）
- 无原生依赖，`npm ci` 不需要 MSVC 构建工具链
