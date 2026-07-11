# P0 工作区边界与长会话恢复完整性整改方案 - 2026-07-10

**状态**：提案，尚未实现。  
**范围**：`auto` / `simple_auto` 的工作区边界（P0），以及超长会话恢复时早期目标和约束不能静默丢失的问题。  
**不在本次实现范围内**：本文件不改变现有运行时行为；它定义后续实现、迁移和验收的契约。

## 1. 决策摘要

1. “工作区监狱”定义为：模型控制的工具、子进程、子代理和允许的扩展能力，均不能在工作区之外读写宿主文件。远端副作用（例如 `git push`）不属于文件系统边界，必须使用单独的能力和授权。
2. `auto` / `simple_auto` 不再接受模型输入、普通配置或插件传入的任意宿主机路径扩权。可写路径只能由受信任控制面签发为不可伪造的 capability。
3. `auto` / `simple_auto` 必须在首个模型请求前完成 sandbox 预检；没有可用的强隔离后端时，拒绝启动自治模式，不得在首个 bash 调用时才失败，更不得降级为裸跑。
4. 会话恢复改为返回带完整性状态的 `ResumeBundle`，不能再以“返回一组消息”表达完整恢复、截断恢复、损坏恢复和找不到会话这四种不同情形。
5. 目标、硬约束和用户决策使用独立于对话历史的持久化锚点。模型摘要可以帮助理解进度，但永远不能覆盖用户原文或用户确认的 Task Contract。

## 2. 现状与根因

### 2.1 P0 工作区边界

现有 `PermissionPolicy`、文件工具的 `workspaceGuard` 和 bash 的 OS sandbox 都是必要防线，但它们还不能组成完整的“工作区外不可读写”保证。

- `src/modes/AgenticSession.ts` 从配置读取 `sandbox.writeAllowPaths`，`ToolRuntimeGuards` 在 `lockWorkspace` 下仍会把这些宿主路径合并进 sandbox。
- `spawn_sub_agent` 暴露了 `sandbox.write_allow_paths`；`SubAgentBridge.setAutonomyJail()` 仅强制 `allowUnsandboxedFallback: false`，不会收窄模型提供的外部路径。
- Linux bwrap profile 使用 `--ro-bind / /`，macOS Seatbelt profile 以 `(allow default)` 开始。两者都让宿主机的大范围内容可读；bash 路径正则不能证明命令没有经解释器、变量、符号链接或 socket 绕过。
- MCP stdio 服务和自定义工具在宿主 Node 进程中启动。即使 bash 被隔离，拥有文件能力的 MCP 或未声明能力的自定义工具仍可越界。

因此，补充更多 bash 路径模式只能作为防御纵深，不能关闭 P0。

### 2.2 长会话恢复

`src/core/SessionStore.ts` 的默认 `META_AGENT_MAX_RESUME_BYTES=64 MiB` 防止一次恢复占用过多内存。当 `history.jsonl` 超过该值时，当前实现从文件尾部读取最近的字节窗口并丢弃第一条不完整 JSONL 记录。这会丢失早期用户消息；函数仍返回普通 `ConversationMessage[]`，调用方无法知道历史是否完整。

已有的消息元标志透传、`isCompactSummary` / `isKeepSetClone` 过滤和 `META_AGENT_MAX_RESUME_MESSAGES` 本地摘要解决了另一类问题：避免 compact 摘要污染原始目标。它们不能恢复被字节上限直接跳过的文件头内容。

已有 `TaskContract` 具备目标、约束、验收标准和用户决策的正确数据模型，但普通 agentic/auto 会话尚未把它作为每个 session 的恢复事实源。

## 3. P0 目标安全模型

### 3.1 信任边界

| 主体 | 信任级别 | 允许能力 |
|---|---|---|
| 宿主控制面（router、worktree coordinator、Git broker） | 受信任 | 创建受控 worktree、签发 capability、执行经过验证的宿主操作 |
| 模型、bash、子代理、工具参数 | 不受信任 | 只能使用已签发 capability；不能携带原始宿主路径扩权 |
| MCP / 插件 / embedder 自定义工具 | 默认不受信任 | 必须声明能力并被 policy 映射；未知能力在自治模式拒绝 |
| 用户显式交互 | 高于模型但不等于宿主根权限 | 可批准单独的远端或外部资源 capability，审批结果可审计 |

### 3.2 必须满足的不变量

1. `lockWorkspace` 下，模型参数、`permissions.json`、`config.json` 和子代理配置都不能添加工作区外的读写路径。
2. 每个模型可触发子进程都在相同的 OS 级边界内运行；不能只隔离 bash 而遗漏 PowerShell、MCP stdio、插件或工具内部的 `child_process`。
3. 允许写入的临时目录必须是每会话隔离目录，不得把整个宿主 `/tmp`、`$HOME` 或缓存目录作为便利例外。
4. worktree 是唯一可接受的“工作区外物理路径”例外，且必须由 `AutoWorktreeCoordinator` 或 Git broker 签发，不能由工具参数指定。
5. 无可用隔离后端、嵌套 bwrap 不可用、user namespace 被禁用或 profile 自检失败时，自治模式在启动前失败并给出可操作诊断。
6. 文件系统边界不自动授予网络、Git 远端写、credential 使用、Docker socket 或 MCP 副作用；这些都是独立 capability。

### 3.3 Capability manifest

后续实现应在创建 `SessionRouter` 后、首个模型请求前构建不可变 manifest，而不是把原始路径继续向下传递：

```ts
interface WorkspaceCapabilityManifest {
  schemaVersion: '1.0'
  workspace: { id: string; canonicalPath: string; access: 'read_write' }
  worktrees: Array<{ id: string; canonicalPath: string; taskId: string; access: 'read_write' }>
  runtimeReadRoots: string[]
  sessionTemp: { canonicalPath: string; access: 'read_write' }
  git?: { repositoryId: string; mode: 'broker_only' }
  network: 'none' | 'web_only' | 'explicit_remote'
  extensionCapabilities: string[]
}
```

- `workspace`, `worktrees` 和 `sessionTemp` 都经过 `realpath`、所有权和父子关系校验。
- `runtimeReadRoots` 仅包含解释器、动态库和受控工具链所需目录；不可用 `--ro-bind / /` 或 `(allow default)` 替代。
- 用户或模型的 `writeAllowPaths` 在自治模式一律拒绝。可信宿主扩展若确有需要，必须注册 capability 类型，而不是传字符串路径。
- manifest 的 hash、sandbox 后端和 capability 清单写入审计日志与恢复状态，方便复现拒绝或兼容问题。

### 3.4 Git、认证与包管理策略

严格边界会影响 Git，不代表 Git 必须不可用。推荐使用受信任的 Git broker，而不是把 `.git`、`$HOME` 和认证目录大范围挂进 sandbox。

| 场景 | 直接挂载的风险 | 建议 |
|---|---|---|
| 仓库根目录 `git status/commit` | `.git` 在 workspace 内通常可写 | broker 验证 repo 身份后执行允许的本地 Git 操作 |
| 仓库子目录 | `.git` 位于 workspace 外，index/lock/refs 写入会失败 | broker 使用 `git rev-parse` 得到受控 git-dir，不向模型暴露任意路径 |
| linked worktree | `.git` 文件指向 common-dir 下的 `worktrees/*` | 仅 broker 访问 metadata；子代理只编辑受控 worktree |
| HTTPS 凭据 | credential helper/cache 常写 `$HOME` 或 socket | 受限 credential broker，按 origin 颁发一次性凭据 |
| SSH | 私钥、`known_hosts`、agent socket 都是宿主资源 | 优先受限 SSH agent / broker；首次信任主机必须显式批准 |
| `git push` | 远端副作用与本地路径无关 | 单独 `remote_git_write` capability，默认不随 auto 授权 |

包管理器、编译器和测试框架的 cache 也使用会话级或 workspace 级受控 cache。环境变量应把 `TMPDIR`、`XDG_CACHE_HOME`、`npm_config_cache`、`PIP_CACHE_DIR` 等指向该目录，而不是重新授予整个 `$HOME`。

### 3.5 性能预期和度量

文件工具的 canonical path 校验只增加少量文件系统查询。主要成本来自每次 shell 子进程创建 sandbox；现有 bash 注释记录的历史基准约为每命令固定数毫秒，但严格 profile 必须重新实测，不能把该数字当作承诺。

性能验收应采集以下数据并与非自治 agentic 基线比较：

1. 1、10、100 次短 bash 命令的 p50/p95、CPU 与 RSS。
2. `git status`、受控 `git commit`、`npm test`、Python 测试和依赖安装。
3. worktree 分配、sessionTemp 创建和 capability manifest 预检的冷启动时间。
4. Linux 原生 bwrap、嵌套容器、user namespace 禁用、macOS Seatbelt 和 Windows 不支持路径的失败时间与诊断质量。

模型和编译/测试的主要耗时通常远大于 namespace 建立成本；大量微型 shell 调用则会线性累积。若实际开销不可接受，优化方向是减少 shell 往返或引入受控常驻 worker，而不是放宽边界。

### 3.6 P0 分阶段落地

1. **先关闭已知扩权入口**：自治模式拒绝配置和工具参数中的外部 `writeAllowPaths`；只允许当前 workspace 或 broker 签发的 worktree。此阶段降低风险，但不宣称完整 P0 已关闭。
2. **预检与 fail-closed**：在 router 初始化时验证真实 restrictive profile，而不是仅检测 `bwrap --version` 或 `sandbox-exec` 是否存在。
3. **完整读写 allowlist**：Linux 移除全根 `ro-bind`，macOS 改为 deny-by-default 的 read/write profile；引入 sessionTemp 和 runtime read roots。
4. **Git/credential broker**：让常见 Git 工作流恢复可用，但不重新暴露 `$HOME`、私钥或远端写权限。
5. **扩展面收敛**：MCP、插件和自定义工具进入 capability 注册与 sandbox 执行模型；未知能力在 auto/simple_auto 拒绝。
6. **对外表述**：只有第 3-5 步通过攻击和兼容矩阵后，README 才可继续称为“硬监狱”。

## 4. 长会话恢复完整性方案

### 4.1 原则与事实源

恢复不应由对话摘要单独承担。使用以下优先级：

1. 用户原文的 durable intent ledger：不可由模型改写。
2. 用户确认的 `TaskContract`：主目标、硬约束、验收标准和决策日志。
3. 从独立状态存储读取的进行中任务、worktree、checkpoint、artifact 等运行事实。
4. 模型 compact summary：仅是进度说明，必须标为非权威。

任何摘要、tail history 或模型推断都不得覆盖第 1、2 层。无法验证第 1、2 层时，恢复必须显式处于 `degraded` 或 `blocked` 状态，不能悄悄新建会话或假装完整恢复。

### 4.2 新的持久化布局

在既有 `<sessionsRoot>/<sessionId>/history.jsonl` 同目录新增小型、原子写入的状态：

```text
<sessionId>/
  history.jsonl                 # 详细对话，可分段或归档
  intent.jsonl                  # 所有真实用户指令的原文与序号
  recovery-manifest.json        # 小型、可直接读取的恢复锚点
  history-index.json            # 可选：字节范围、消息序号、segment hash
```

建议的核心结构：

```ts
interface SessionRecoveryManifest {
  schemaVersion: '1.0'
  sessionId: string
  workspace?: string
  updatedAt: string
  goalEpoch: {
    id: string
    sourceSequence: number[]
    verbatimUserGoalParts: string[]
    capturedAt: string
  }
  taskContract?: { contractId: string; updatedAt: string; contentHash: string }
  durableInstructions: Array<{
    sequence: number
    text: string
    kind: 'user_goal' | 'user_constraint' | 'user_decision'
    confirmed: boolean
  }>
  history: {
    lastSequence: number
    lastHistoryOffset: number
    historyHash?: string
  }
  integrity: {
    anchorState: 'complete' | 'legacy_reconstructed' | 'incomplete'
    warnings: string[]
  }
}
```

`intent.jsonl` 保留每一条真实用户消息的原文、sequence、uuid 和时间。它不依赖模型分类，因此即使某条指令尚未被提升到 contract，也不会从磁盘中消失。`durableInstructions` 仅包含明确标记或用户确认的目标、约束和决策；模型生成的提炼只能作为候选，不能直接写入该字段。

### 4.3 捕获和更新协议

1. 接收到首个真实用户 prompt 后、首个模型请求前，先持久化 `goalEpoch.verbatimUserGoalParts`。写失败时标记 integrity 不完整并向用户显示，不得静默继续为“可安全恢复”的会话。
2. 每个真实用户消息同时追加到 `intent.jsonl`。紧急 steering、compact summary、tool result、keep-set clone 和系统注入消息不得进入 intent ledger。
3. auto 发生 `reanchorOriginalGoal()` 时，创建新的 `goalEpoch`，并通过同一持久化队列写入 manifest；旧 epoch 保留审计记录，不得被覆盖。
4. 用户通过 contract UI/工具确认“必须”“禁止”“验收标准”或关键决策时，原子更新 `TaskContract` 与 manifest 的引用。模型只能提议，不能自行确认。
5. history、intent 和 manifest 使用同一 session 锁和单调 sequence。崩溃后允许 manifest 落后于 history，并在下次加载时补齐；不得允许 manifest 指向从未落盘的未来 sequence。
6. 删除 session 时同时删除所有 sidecar；`--session-dir` 必须使用同一根目录，不能错误写入默认 `~/.meta-agent`。

### 4.4 新的恢复 API 与 CLI 行为

保留 `SessionStore.loadHistory()` 作为兼容包装，但新增主 API：

```ts
type ResumeLoadResult =
  | { status: 'complete'; bundle: ResumeBundle }
  | { status: 'degraded'; bundle: ResumeBundle; warnings: string[] }
  | { status: 'blocked'; reason: string; recoveryAction: 'reanchor' | 'inspect' }
  | { status: 'not_found' }

interface ResumeBundle {
  messages: ConversationMessage[]       // 合法的近期协议窗口
  originalGoalParts: string[]           // 直接赋给 KernelSession，不从 tail 重建
  intentLedger: DurableIntentEntry[]
  taskContract?: TaskContract
  integrity: SessionRecoveryManifest['integrity']
}
```

恢复流程如下：

1. 先读取 manifest、intent ledger 和 TaskContract；它们很小，不受 `MAX_RESUME_BYTES` 影响。
2. 再按字节上限读取 history 尾部，并在合法 tool_use/tool_result 边界开始恢复。
3. `KernelSession` 新增 `initialOriginalGoalParts`，有值时优先使用它，而不是从 tail messages 重新调用 `collectOriginalUserGoalParts()`。
4. 将目标、用户确认约束和 contract 以稳定系统 section 注入首个恢复请求，而不是伪造普通 user message；compact 必须把该 section 当作确定性锚点。
5. CLI 显示恢复完整性：`完整`、`已保留目标但历史尾部恢复`、`降级` 或 `阻止`。非交互 CLI 在 `blocked` 时返回非零；交互 CLI 要求用户重新锚定或显式选择降级继续。

对历史版本的兼容策略：当 sidecar 不存在但 `history.jsonl` 很大时，流式读取文件头有限窗口以恢复最早真实用户消息，并将结果标为 `legacy_reconstructed`。若文件头不可解析、已被旧 compaction 覆盖或原始 intent 不可验证，则进入 `blocked`，不能从尾部猜测目标。

### 4.5 为什么不只提高 64 MiB 上限

提高上限只推迟问题，并增加峰值内存、JSON 解析时间和首次模型请求的上下文成本。即使完全读取 history，模型窗口仍有限，最终仍要丢弃或压缩较早对话。因此必须把不可丢失的事实从聊天日志中分离出来，并让恢复 API 明确报告完整性。

## 5. 实施顺序

1. 新增 `SessionRecoveryManifest`、`intent.jsonl`、单调 sequence 和 `loadResumeBundle()`；先实现完整性状态，不改变现有 CLI 默认恢复。
2. 把 CLI、REPL、one-shot `--resume`、lineage sub-agent 迁移到新 API；为 `KernelSession` 增加显式 goal anchor 输入。
3. 接入 `TaskContractStore`：创建/更新/引用和稳定 prompt section，增加用户确认入口。
4. 启用 degraded/blocked UX，并迁移旧 session 的文件头抢救逻辑。
5. 实现 P0 capability manifest、预检和外部路径拒绝；随后再做读 allowlist、Git broker 和 MCP capability 化。

两个主题可以并行设计，但不要混合提交：恢复完整性改动不得降低 P0 fail-closed 行为；P0 sandbox 改动不得改变 manifest 的持久化位置或删除恢复 sidecar。

## 6. 验收矩阵

### 6.1 P0

- 配置、工具参数、子代理参数试图添加 `/tmp`、`$HOME`、父目录和符号链接目标时均被拒绝。
- shell 混淆、解释器执行、hard link、Unix socket、Docker socket、`GIT_DIR`、hook 和 MCP 文件工具都不能绕过边界。
- 仓库根目录、子目录、linked worktree、HTTPS、SSH agent、Git LFS、npm/pnpm/pip/uv/cargo/go 的成功和受控失败路径均有集成测试。
- 无 bwrap、嵌套 bwrap、禁用 user namespace、macOS restrictive profile 失败时，auto/simple_auto 在模型调用前拒绝启动。

### 6.2 恢复完整性

- history 小于和大于字节上限时，原始目标和用户确认约束都一致注入；后者不得从 tail 猜测。
- history 截断、损坏首行、缺失 manifest、旧 compact 历史和 `--session-dir` 都返回正确的 `complete/degraded/blocked/not_found` 状态。
- compact summary、keep-set clone、steering 和 tool result 永远不能成为 durable user intent。
- auto 新 goal 重锚后，旧 epoch 不得重新作为当前 goal；崩溃于 history/manifest 任一写入之间时可恢复且有可见完整性状态。
- session 删除会删除所有 sidecar；并发 append/resume 不会产生重复或跳号的 durable intent。

## 7. 完成定义

本方案完成后才可同时满足以下条件：

1. auto/simple_auto 在受支持平台上没有模型可控的工作区外文件读写通道；不支持时明确拒绝而非降级。
2. Git、认证、包管理和扩展能力的例外均显式、可审计且不通过广泛宿主路径挂载实现。
3. 任意 resume 都向调用方报告完整性；无法验证早期目标或约束时不会静默继续。
4. 用户原文和用户确认的 contract 在历史压缩、字节截断、重启和多次 resume 后仍是可验证的最高优先级事实源。
