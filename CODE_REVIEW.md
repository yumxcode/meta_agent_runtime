# meta-agent-runtime 代码评审与修复记录

审查日期：2026-08-14 · 基线 v0.8.16 · 含未提交的 MCP Apps 改动
范围：`src/` 全量(86k 行,218 个测试文件)

**状态:全部 20 项已修复。** `tsc --noEmit` 干净;`vitest run` 2177 passed / 218 files。

---

## 总体判断

这份代码库的安全设计本身是有意识的:工作区越界检查、写-改名原子落盘、跨进程文件锁、子进程凭证过滤、SSRF 防护(含 DNS 重绑定 pinning)都比同类项目扎实,注释里还留了多轮修复的因果记录。

问题不在于缺少控制,而在于**控制的覆盖方式**:几乎所有 shell 相关的检查都以字面工具名 `'bash' | 'powershell'` 为触发条件,而不是以工具的 `permission` 声明为准。任何绕开这两个名字的执行路径自动豁免全部控制——`cron_create` 正好是这样一条路径。这一轮的核心改动就是把「按名字」换成「按声明」,并把散落的 8 处 `spawn`/`execFile` 收敛到一个入口。

---

## P0 — 严重

### P0-1 `cron_create` 是 shell 沙箱与权限体系的完整旁路 ✅

原实现把模型给的字符串直接交给 `execFile('bash', ['-c', command])`,相比 `bash` 工具缺失**全部**六层防护,且**反复执行**:

| 防护 | `bash` | 原 `cron_create` |
|---|---|---|
| `permission` 声明 | 完整 | 无 |
| 审批提示 | 命中敏感模式即询问 | 无 |
| 工作区路径扫描 | ✅ | 跳过(条件为 `toolName === 'bash'`) |
| `~`/`$HOME`/`..`/`/` 逃逸检查 | ✅ | 跳过(同上) |
| 凭证过滤 | `buildChildEnv('filtered')` | **继承完整 `process.env`** |
| OS 沙箱 | `wrapExec()` | 无 |
| cwd 限制 | `resolveInsideWorkspace()` | 无 |
| 输出脱敏 | ✅ | 无 |

仅在 `auto`/`simple_auto` 被 `AUTO_DENIED_TOOL_NAMES` 过滤;默认的 `agentic` 与 `robotics`、`campaign` 均可用。

**修复**:新增 `src/infra/exec/runShellCommand.ts` 作为唯一的 shell 执行入口(cwd jail → 凭证过滤 → OS 沙箱 → 进程组 → 有界+脱敏捕获),`cron_create`、`bash`、`powershell` 全部改走它;`cron_create` 补齐 `permission` 声明。

调度回调**在授权时刻**捕获 jail/授权/沙箱句柄并闭包持有,而不是在 tick 时重新解析——否则后来的配置变更会悄悄放宽一个按更严策略批准过的任务。

### P0-2 安全控制以工具名硬编码 ✅

`PermissionPolicy.ts:246/454/460` 三处以 `tool.name === 'bash' || 'powershell'` 触发扫描。这是 P0-1 的成因,而且会复发。

**修复**:`ToolPermissionDeclaration` 新增 `commandField?: string`。声明它就订阅了全部命令级检查;三处判断改为 `if (permission.commandField)`。`DEFAULT_TOOL_PERMISSIONS` 里为 `cron_create` 留了一条兜底,即使将来重构删掉工具自己的声明,扫描依然生效(有回归测试锁定)。

---

## P1 — 高

### P1-1 沙箱只挡写,不挡读、不挡出网 ✅

macOS 是 `(allow default)`,Linux 是 `--ro-bind / /`,而 `DEFAULT_MAIN_SANDBOX` 既无 `readDenyPaths` 也无 `network` 限制——沙箱内可读 `~/.ssh`、`~/.aws` 并经完全开放的网络送出。配合 `web_fetch`/MCP 把不受信内容送进上下文,构成完整的提示注入外泄链。

**修复**:

- 新增 `src/sandbox/sandboxPolicyConfig.ts`:`DEFAULT_CREDENTIAL_DENY_PATHS`(14 个凭证目录)默认生效,`sandbox.protectCredentials: false` 可关。
- 两个 backend 支持 `readAllowPaths` 与读拒绝的对账(显式授权压过默认拒绝)。
- `SensitiveCommandPatterns` 补上传形态:`curl -d/-F/-T`、`curl -X POST|PUT|PATCH`、`wget --post-*`、`nc`、`scp/rsync` 远端、`base64 | curl`。

**并按要求把沙箱外部路径读写做成了配置项**(详见 README「沙箱外部路径配置」):`sandbox.writeAllowPaths` / `readAllowPaths` / `writeDenyPaths` / `readDenyPaths` / `network` / `protectCredentials` / `allowUnsandboxedFallback`。

关键在于授权同时喂给**两层**:OS 沙箱(强制)与 kernel 权限 jail(`PermissionPolicy.externalAllowedRoots`)。只配前者的话,jail 会在沙箱被问到之前先拒掉,表现为「配了却不生效」——这是最容易漏掉、也最难排查的一环。

### P1-2 `GITHUB_TOKEN` 放行且脱敏抓不到裸值 ✅

`GIT_CREDENTIAL_ALLOWLIST` 让 token 对每个子进程可见,而脱敏正则要求 `NAME=value` 形态——`echo $GITHUB_TOKEN` 输出裸值,完全不匹配,原样进入模型上下文/日志/lineage。`GH_TOKEN`/`GIT_TOKEN` 连前缀列表都不在。

**修复**:新增 `src/infra/redaction/secretRedaction.ts`,加入**按值形态**的规则(`ghp_`/`github_pat_`/`glpat-`/`sk-`/`AKIA`/`xox`/`AIza`/`npm_`/JWT/URL 内嵌凭证);`ENV_ASSIGNMENT_RE` 改为按凭证后缀匹配,不再硬编码 provider 前缀;`SENSITIVE_ENV_PATTERN` 补 `_KEY`/`_PAT`/`_DSN`/`_URL`,并用 `ENV_PATTERN_EXEMPTIONS` 放行 `*_BASE_URL`、代理变量等非凭证;新增 `sandbox.gitCredentialPassthrough` 开关。

脱敏现在由 `runShellCommand` 对所有调用方统一施加,工具再也无法「忘记」这一步。

### P1-3 MCP `listResources` 分页无界 ✅

`do{...}while(cursor)` 无页数/总量上限、无游标重复检测。恶意或有 bug 的 MCP 服务器返回固定游标即可挂死 agent 并撑爆内存。

**修复**:`registry.collectPaginated()` — 100 页 / 10000 条上限 + 游标重复检测,截断时 stderr 告警。两个 client 均改用。

### P1-4 `withFileLock` 的两条 `continue` 跳过超时与退避 ✅

`catch { continue }` 把**任何** `stat` 失败当成「锁消失了」(含 `EACCES`/`EIO`),且两条 `continue` 都跳过 deadline 检查与 `sleep`——stat 稳定失败时循环以零延迟自旋,`timeoutMs` 永不生效。

**修复**:所有出口都落到 deadline 检查 + `sleep`;`stat` 错误区分 `ENOENT`(重试)与其他(抛出)。同时把「跨机器不可用」(mtime vs 本地时钟)明确写进文档——这是设计边界,不是能靠改代码消除的。

---

## P2 / P3 — 中与低(全部已修)

| # | 位置 | 修复 |
|---|---|---|
| P2-1 | `registry.isMcpToolVisibleTo` | `'app'` 受众默认**不可见**(服务器 HTML 不受信);`mcp_call` 在工具不在 `tools/list` 时**拒绝**而非放行 |
| P2-2 | `mcpAppsHost.cspOrigins` | 要求完整 origin,拒绝裸 `https:`;`script-src` 不接受 `data:`;每指令 20 个上限 |
| P2-3 | `mcpAppsHost` `/rpc` | `resources/read` 收敛到服务器 `resources/list` 广告的 URI + app 自身资源 |
| P2-4 | `cli/index.ts` | `process.once('exit')` 里的 async 调用是空操作 → 新增同步 `closeSync()`(含 `closeAllConnections`) |
| P2-5 | `mcp_call` | 每次调用多打一次 `listTools` RPC → `cachedListTools` 60s TTL,promise 级缓存(并发合流),失败不缓存 |
| P2-6 | `cronStore.nextRunDelayMs` | 逐秒扫描 25h(日任务 ~86,400 次 `Date` 分配、同步阻塞)→ 按字段域求解 |
| P3-1 | `modelCallAdmission` | `provider ??= next` 静默忽略二次注册 → 告警 + `reset` |
| P3-2 | `ToolOrchestration` | 循环内两次 `getConcurrencyLimit()` → 快照 |
| P3-3 | `cli/args.ts` | `meta-agent ui redesign …` 会吞掉 "ui" → 仅当 `ui` 是唯一 positional 或带 ui flag 时才当子命令 |
| P3-4 | `.npmignore` | 与 `files` 并存且实际无效 → 改为指向 `files` 的说明 |
| P3-5 | `readJsonFile` | 读接口带破坏性 rename → 改为 `{ quarantineCorrupt: true }` 显式开启 |
| P3-6 | `mcpAppsHost` | HTTP 500 回显内部异常 → 本地记日志,响应体通用化 |
| P3-7 | `web_fetch` | `http→https` 用 `.replace()` 会改写 query 里的 URL → 只改 scheme 前缀 |
| P3-8 | `bwrap.ts` | `writeAllowPaths` 用 `--bind`,一个失效条目让**每条**命令失败 → `--bind-try` |
| — | `powershell` | 私有的 `startsWith` 版 `isInsideWorkspace`(会把 `C:\proj-backup` 当成 `C:\proj` 内)、无凭证过滤、无沙箱、无脱敏 → 改走 `runShellCommand` |

---

## 架构改动

**统一子进程执行入口。** 原先 8+ 处 `spawn`/`execFile` 各自的安全姿态互不相同,`cron_create` 是其中最差的一个。现在 `infra/exec/runShellCommand.ts` 是「模型提供的命令字符串 → shell」的唯一通道,五层防护由构造保证。固定 argv 的内部工具(`git`、`rg`)不受影响——它们没有 shell 可注入,argv 也不由模型控制。

**建议的后续护栏**:加一条 lint 规则,禁止在 `infra/exec/` 之外 import `child_process`。这是防止这类问题第三次出现的最低成本手段。

**仍然存在的已知边界**(记录在案,非本轮修复范围):

1. `withFileLock` 不适用于跨机器共享文件系统(时钟依赖 + NFS 原子性)。TeamStore 文档里提到的双机场景需要租约服务或数据库。
2. git 凭证仍以进程级环境变量透传。正解是 `GIT_ASKPASS`/credential helper 把 token 只交给一次 `git` 调用,这会改动 auto 模式 push 的接线方式,单独跟进。当前以「按值脱敏 + 可关开关」兜底。
3. 模块级可变单例(`mcpClients`、`mcpAppPresenter`、`cronStore`、`web_fetch` cache、admission provider)仍使同进程内无法安全跑两个独立 runtime 实例。

---

## 验证

- `tsc --noEmit`:干净。
- `vitest run`:**2177 passed / 218 files**,0 失败。
- 新增测试:
  - `kernel/__tests__/CommandFieldGuards.test.ts` — 声明驱动的命令扫描 + 外部授权 jail(含「授权按路径段匹配」「未授权 cwd 仍拒绝」「删掉声明也仍受兜底保护」)
  - `sandbox/__tests__/sandboxPolicyConfig.test.ts` — 配置解析、凭证默认值、allow/deny 对账、两个 backend 的产物
  - `infra/__tests__/secretRedaction.test.ts` — 裸 token / URL 内嵌凭证 / 未知 provider,以及不误伤正常输出
  - `tools/mcp/__tests__/McpPagination.test.ts` — 分页三种上限、缓存合流与失败不缓存、app 可见性默认关闭
  - `tools/system/__tests__/cronSchedule.test.ts` — 跨午夜、`*/N`、全天扫描的不变量、性能回归守卫
- 调整了 6 个既有测试的断言(`--bind-try`、quarantine 改 opt-in、`tools/list` 缓存、env 策略与脱敏正交)。每处都在测试里写明了改动理由。
