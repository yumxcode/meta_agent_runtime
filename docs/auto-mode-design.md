# Auto Mode 设计文档

> **状态：✅ 已全部实现（720 单测全绿、`tsc`/`build` 通过）；保守边界见 §12.2**
> 新增第四种协作模式 `auto`，定位为 **Agentic 的自主化变体**：自主执行、不打断问人，
> 安全性由「写/删/改/替换严格限制在项目工作路径下」的硬牢笼保证。
> 本文档覆盖：命名与类型改动、权限牢笼、沙箱双防线、prompt 组装、compact、多智能体并发、
> 长会话稳定运行、文件级改动清单、测试计划，以及 **§12 实现状态与未开发项**。
>
> 关联文档：[meta-agent-architecture.md](architecture/meta-agent-architecture.md)、
> [permissions.md](permissions.md)、[robotics-mode-design-v2.md](robotics-mode-design-v2.md)

---

## 1. 定位与设计原则

### 1.1 一句话定位

`auto` = `agentic` 的工具循环 **＋ 自主放行（不弹确认）＋ 文件系统硬牢笼（越界硬拒绝）**。

与 agentic 的唯一行为差异有两点：

1. 工作路径**内部**的写/删/改/替换、破坏性 bash 一律自动放行、**不打断问人**；
2. 工作路径**外部**的任何变更一律**硬拒绝**（不是询问，是拒绝），且该牢笼**不可被配置解锁**。

安全保证落在两条独立防线：**逻辑权限牢笼**（执行前路径校验）与 **OS 沙箱**（执行时内核级隔离）。
两者**均已存在**，auto 主要是接线与少量收紧，不重写既有机制。

### 1.2 三条贯穿全文的原则

| 原则 | 落地方式 |
|------|---------|
| **低耦合** | `PermissionPolicy` 只新增通用 `autonomy` 能力开关，**绝不出现 `if mode === 'auto'`**；由路由层负责 `mode → 开关` 的映射 |
| **高内聚** | 权限层只懂权限概念；调度层只懂调度；边界判定只在 `workspaceGuard` 一处（唯一真相源） |
| **零回归** | 所有 auto 新增能力都做成 `autonomy` profile 的可选开关，默认关闭，`agentic/campaign/robotics` 行为字节不变 |

---

## 2. 命名与类型改动

### 2.1 命名冲突及解决

现状：`SessionModeHint = SessionMode | 'auto'`，其中 `'auto'` 已被用作 **「让 ModeDetector 自动检测」** 的哨兵
（`SessionRouter` 里 `this._hint = mode ?? 'auto'` 即默认值）。新增真正的 `auto` 模式会与之冲突。

**决议：哨兵改名 `detect`，`auto` 释放给新模式。**

### 2.2 `src/routing/types.ts`

```ts
// 改动前
export type SessionMode = 'agentic' | 'campaign' | 'robotics'
export type SessionModeHint = SessionMode | 'auto'
export const MODE_WEIGHT: Record<SessionMode, number> = { agentic: 1, campaign: 2, robotics: 3 }

// 改动后
export type SessionMode = 'agentic' | 'campaign' | 'robotics' | 'auto'
export type SessionModeHint = SessionMode | 'detect'        // 哨兵改名
export const MODE_WEIGHT: Record<SessionMode, number> = {
  agentic: 1,
  auto:    1,   // 与 agentic 同级：是「风味」而非「更重」
  campaign: 2,
  robotics: 3,
}
```

`MODE_WEIGHT['auto'] = 1` 的理由：`registerTool()` 会把模式抬升到 `agentic`(权重 1)，
`1 > 1` 为假，因此**不会覆盖**显式声明的 `auto`，牢笼得以保留。

### 2.3 显式模式锁

`auto` 一旦被显式声明，**禁止被 campaign/robotics 检测信号升级**（升级会丢掉牢笼与自主语义）。
在 `SessionRouter._raiseMode` 增加守卫：当 `hint` 为显式（非 `detect`）时，`_raiseMode` 对更重模式不再抬升。
当前权重设计已基本安全，此守卫为防御性二道闩。

---

## 3. 权限牢笼（逻辑防线）

### 3.1 复用现有边界

工作区边界判定已集中在 `tools/fs/workspaceGuard.ts`：

- `isInsideWorkspace(path, root)` —— 处理 symlink 逃逸（解析最近存在祖先的真实路径，再拼接不存在的尾部）；
- `PermissionPolicy.findWorkspaceViolation()` —— 对 `pathFields`、`cwdField`、bash 命令里的绝对路径逐一校验。

auto 不新造边界，只是把这套规则从「可选 / 可询问」收紧为「强制 / 越界即拒」。

### 3.2 唯一的语义增量：`autonomy` profile

在 `src/kernel/permissions/PermissionPolicy.ts` 的 `PermissionPolicyOptions` 增加：

```ts
autonomy?: {
  /** 路径内敏感操作直接放行、绝不询问（auto 的自主性来源） */
  autoApproveInWorkspace?: boolean
  /** 强制忽略 permissions.json 的 allowOutsideWorkspace —— 牢笼不可被配置解锁 */
  lockWorkspace?: boolean
}
```

> **解耦关键**：`PermissionPolicy` 仍然不认识 `SessionMode`，只暴露这两个通用开关。
> 由 `SessionRouter` 负责把 `mode === 'auto'` 翻译成
> `{ autoApproveInWorkspace: true, lockWorkspace: true }`。

### 3.3 强制逻辑

| 开关 | 行为 |
|------|------|
| `lockWorkspace` | 进入策略前**强制** `allowOutsideWorkspace = false`，即使用户 `permissions.json` 写了 `true` 也无效 |
| `autoApproveInWorkspace` | 敏感分支命中且**所有路径在工作区内** → 直接 `allow`，**跳过** `applyBeforeToolGuard`（不弹确认）；任一路径在外 → 已被前置 `findWorkspaceViolation` 拦成 `deny` |

### 3.4 权限语义对照表

| 操作 | 路径在工作区内 | 路径在工作区外 |
|------|:---:|:---:|
| `write_file` / `edit_file` / `notebook_edit` | 自动放行（不问） | 硬拒绝 |
| `bash` 破坏性命令（`rm -rf` 等） | 自动放行（不问） | 硬拒绝 |
| `read_file` / `glob` / `grep` | 放行 | 按现有策略 |
| `permissions.json` 设 `allowOutsideWorkspace: true` | 无效（被 `lockWorkspace` 压制） | 仍拒绝 |

### 3.5 健壮性加固（bash 相对逃逸）

现有 bash 扫描只查「绝对路径在外」。auto 模式下需补拦相对逃逸，否则
`rm -rf ~`、`rm -rf $HOME`、解析后越界的 `..`、无 `cwd` 的破坏性相对命令可绕过逻辑牢笼。
新增检查 + 配套单测（见 §10）。

---

## 4. 沙箱与权限牢笼的双防线

逻辑牢笼（§3）是**执行前**的路径校验，但它做的是静态扫描，挡不住「命令运行时的动态行为」——
比如一个 bash 跑的脚本在运行中往工作区外写。OS 沙箱补上这一层：**执行时**的内核级隔离。
两者互补，不是冗余。

### 4.1 现状：bash 默认就跑在沙箱里

沙箱机制已存在且**默认开启**（`tools/shell/bash/index.ts`）。主代理每条 bash 命令都被
`MetaAgentSession._wrapTool()` 注入的 `SandboxHandle` 包起来执行：

- **Linux** → `bwrap`（bubblewrap）：`--ro-bind / /` 把整个主机文件系统挂成**只读**，
  再 `--bind <workspaceRoot>` 把工作区**单独挂成可写**，`--tmpfs /tmp` 隔离临时目录，
  可选 `--unshare-net` 断网；
- **macOS** → `sandbox-exec`：相同的「只读根 + 可写工作区」策略；
- 开销约 1.5–5 ms/命令，可忽略，故默认 ON；
- 子代理独立走这套（`SubAgentRunner` 自建 `createSandboxExecutor()`）。

### 4.2 两条防线的分工

| 防线 | 覆盖对象 | 时机 | 机制 |
|------|---------|:---:|------|
| **逻辑权限牢笼**（§3） | write_file / edit_file / notebook_edit / bash 路径参数 / glob / grep | 执行**前** deny | `PermissionPolicy` + `workspaceGuard` 路径校验 |
| **OS 沙箱**（本节） | **仅 bash/shell 的实际执行** | 执行**时** | bwrap / sandbox-exec：只读根 + 可写工作区 |

关键认知：**fs 工具（write_file/edit_file）不走 OS 沙箱**，它们是普通 Node fs 调用，
只靠逻辑牢笼挡。因此对 fs 工具，逻辑牢笼是唯一防线，必须严丝合缝；
对 bash，逻辑牢笼挡显式越界路径、OS 沙箱兜运行时动态写——双保险。

### 4.3 现有缺口：fail-open 静默降级

现状的默认策略对无人值守不友好：

```ts
const DEFAULT_MAIN_SANDBOX: SandboxConfig = { allowUnsandboxedFallback: true }
```

即宿主机**没装 bwrap / sandbox-exec 时会静默降级成无沙箱直跑**。交互模式无所谓，
但 auto 无人盯着，这等于「在没沙箱的机器上，bash 的运行时防线消失，只剩逻辑牢笼」。

### 4.4 auto 的收紧：fail-closed（非新增机制，仅收紧）

auto 不需要造沙箱，只需把上述 fail-open 缺口在自主模式下改成 **fail-closed**：

- auto 模式下 bash 沙箱策略改为 `allowUnsandboxedFallback: false`：
  **沙箱不可用即拒绝执行，绝不静默裸跑**；
- 该收紧做成 `autonomy` profile 的派生项（`mode === 'auto'` → 沙箱 fail-closed），
  其它模式的宽松降级行为不变；
- 子代理派发的 `SandboxConfig` 同理 `allowUnsandboxedFallback: false`（见 §7.1）。

> **小结**：沙箱机制有、bash 默认就在沙箱里跑；auto 的工作是「把沙箱不可用时的静默裸跑改成硬拒绝」，
> 并与逻辑牢笼一起构成双防线。

---

## 5. Prompt 组装（复用 agentic + auto 增量）

### 5.1 现有两段式结构（不改）

系统提示词在 `MetaAgentSession._submitInner` 拼接，用 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 隔开，
boundary 之前字节稳定以命中前缀 KV 缓存。

- **静态区 S 节**（`staticPrompt.ts`，按模式裁剪）：S1 身份 / S2 系统规则 / S3 任务执行规则 /
  S5 操作风险（仅 campaign）/ S6 输出风格。
- **动态稳定段 D 节**（memoized，进系统消息、参与缓存）：D0 task_contract、D1c agent_directives、
  D1d skill_manifest、D2 env_info、D3 language、D4 current_mode、D4a engineering_standards、
  D4c tool_invocation_protocol、D5 mcp_instructions、D6 output_style、D9 session_provenance。
- **动态易变段**（`DANGEROUS_uncached`，不进系统消息，拼到用户消息前缀）：D1b memory_content、
  D11 sub-agent 通知、D8/D9/D10 campaign 上下文。

### 5.2 auto 的复用与增量

| 维度 | auto 处理 |
|------|----------|
| `StaticPromptMode` | 落到 `agentic` 分支，**无需新静态模板** |
| 模式声明 | 在 **D4 current_mode** 注一行：当前为自主模式、所有变更已限制在工作区内、**无需请求确认**。只动 D4，不碰静态区，缓存不受影响 |
| 易变段 | D1b / D11 全部继承 |

> auto 的「不问」由 `PermissionPolicy` 在代码层强制（不依赖 prompt），D4 那行只是让模型行为对齐、避免它主动请求确认。

---

## 6. Compact（长会话的第一道生命线）

### 6.1 触发时机（现状，不改）

`KernelLoop` 每轮调 `autoCompactIfNeeded`，按 token 估算判断：

- 阈值 = **有效上下文窗口的 65%**（`AUTOCOMPACT_THRESHOLD_PCT = 0.65`，
  可用 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 覆盖）；
- 有效窗口 = 模型上下文窗口 − min(maxOutputTokens, 20k)；
- 主模型与 compact 模型两个阈值取**或**；
- 断路器：连续失败达 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` 后**停掉**自动压缩；
- `DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT` 可全局关。

### 6.2 内容（现状，不改）

`CompactPrompt.ts` 按模式档位（`promptProfile`）选模板。agentic 用 **9 节模板**：
① 主要请求与意图 ② 关键技术概念 ③ 文件与代码 ④ 错误与修复 ⑤ 问题解决
⑥ 所有用户消息 ⑦ 待办任务 ⑧ 当前工作 ⑨ 可选下一步。
摘要之外**逐字保留尾部**最近的 user⇄tool_result 轮次，并注入确定性锚点（原始会话目标）。

### 6.3 auto 的增量

| 增量 | 说明 |
|------|------|
| `promptProfile` | 用 `'agentic'` 9 节即可 |
| **+ 自主执行账本节** | 9 节基础上追加一节：已派发子代理及其产物、已对工作区做的不可逆变更清单。长自主会话最易「忘了自己改过什么」→ 重复劳动或自相冲突 |
| **确定性锚点扩容** | 压缩后必存活项，auto 比 agentic 多三项：`auto 模式标记 + 工作区根路径 + 活跃/已完成子代理 ID 清单`。挂现有 `deterministicAnchors`，模型压缩后仍知道自己在牢笼里、目标是什么、有哪些子代理在跑 |

---

## 7. 多智能体并发（问题二）

### 7.1 牢笼透传到子代理（安全前提，必做）

`SubAgentRunner` 走 `SandboxConfig`（`writeAllowPaths` 默认仅含 `workspaceRoot`）。auto 派发子代理时强制：

```text
SandboxConfig = {
  writeAllowPaths: [<workspaceRoot 子集>],   // 锁死
  allowUnsandboxedFallback: false,           // fail closed：沙箱不可用即拒（与 §4.4 一致）
  autonomy: { lockWorkspace: true, autoApproveInWorkspace: true }  // 透传
}
```

否则一个 `run_agent` 子代理就是绕过双防线的口子。这是必须补在 `SubAgentBridge` 派发路径上的一环。

### 7.2 并发写冲突隔离（核心难点）

共享工作区 + 并发写 = 损坏。推荐方案与退路：

| 方案 | 机制 | 取舍 |
|------|------|------|
| **（推荐）worktree 隔离 + 串行合并** | 复用 robotics `GitWorkspaceManager`：每个写型子代理在独立 worktree 干活，并发只在隔离区；主代理**串行**合回，冲突可检测、可丢弃 | 现成、低耦合；需工作区为 git 仓库 |
| 路径分区 | 派发时给子代理分配不相交子目录，策略层叠一层 per-task subroot 校验 | 无需 git；但任务必须可按目录切分 |
| 读写分级 | 并发子代理只读，写全由主代理串行执行 | 最安全；并行度最低 |

**实现采用 worktree 隔离，且为「显式 opt-in」**（as-built）：

- worktree 隔离**默认关闭**，仅当子代理派发时带 `isolateWorktree: true` 且工作区是 git 仓库才分配独立 worktree。
  原因：`research_dispatch` 这类**只读/报告型**子代理会把报告写到 `.meta-agent/research/`，若被重定向进 worktree 并在丢弃时连同报告一起删掉就会丢结果。
  因此**默认共享工作树**（由 §7.3 写互斥兜底），**需要重并行写时再开 worktree**。
- 隔离时：`AutoWorktreeCoordinator`（`src/core/auto/AutoWorktreeCoordinator.ts`，封装 `GitWorkspaceManager`，worktree 基目录 `<workspace>/.meta-agent/auto/worktrees`）为该 taskId 分配 worktree+分支，
  并把子代理的 `projectDir` 与沙箱 `writeAllowPaths` 绑定到 worktree。
- **主代理串行合并**：新增三个工具（仅 auto 模式注册），主代理凭子代理完成通知决定何时整合：
  - `auto_merge_subagent`（squash/merge，合并由 `GitWorkspaceManager` 内部互斥串行化）
  - `auto_diff_subagent`（合并前看分支自 fork 点以来的改动）
  - `auto_discard_subagent`（冲突或产出不合格时丢弃该 worktree+分支）
- 退路：非 git 仓库或未 opt-in → `allocate` 返回 null，自动回落共享工作树 + 写互斥。

### 7.3 写协调互斥（轻量）

即便有 worktree，共享资源（`checkpoint.json`、同一份配置）仍需协调。
新增**按规范化路径加锁的进程内写互斥**，挂在工具执行层（`PermissionPolicy` 放行后、执行前抢锁），
不污染调度器。

### 7.4 调度护栏的 auto 默认

现有 `SubAgentBridge` 护栏直接继承，但 auto 给更保守默认（同时作为无人值守的成本/安全闸）：

| 参数 | 现有默认 | auto 建议默认 | 环境变量 |
|------|:---:|:---:|------|
| 最大并发子代理 | 4 | 2–3 | `META_AGENT_MAX_CONCURRENT_SUB_AGENTS` |
| 最大排队 | 64 | 继承 | `META_AGENT_MAX_QUEUED_SUB_AGENTS` |
| 启动间隔 stagger | 有 | 继承 | — |
| 子代理总预算（美元） | 有 | **必填明确值** | `META_AGENT_MAX_TOTAL_SUB_AGENT_BUDGET_USD` |

### 7.5 失败与通知背压

- **子代理失败**：有限次指数退避重试 → 仍失败则记入账本、主代理决策（跳过/换路），**不阻塞**其它子代理；
- **通知背压**：D11 通知队列上限 `MAX_PENDING_NOTIFICATIONS = 100`，长自主多子代理场景超限时**合并摘要**而非静默丢弃，并落 checkpoint。

---

## 8. 长会话稳定运行（问题一）

交互模式靠人兜底（`/clear`、看到卡住就介入）；auto 无人值守，需用三层机制补上「人」的角色。

### 8.1 压缩自愈（补现有缺口）

**最大稳定性风险**：断路器连续失败 3 次后**没有降级路径**，之后上下文继续涨直到撞 `blocking_limit` 报错退出。
auto 新增兜底链：模型压缩失败 → 退到**无模型的结构化截断**（丢弃中段、逐字保留尾部 + 确定性锚点），
在 `isAtBlockingLimit` 之前强制把上下文压回阈值内。**保证无人时也永不因压不动而撞墙退出。**
仅在 `autonomy` 开启时生效。

### 8.2 进度检查点 + 续跑

借 robotics project state 思路（不新造）：每 N 轮或每次 compact 时把
`目标 / 已完成步骤 / 待办 / 活跃子代理 / 关键产物路径` 写到 `<workspace>/.meta-agent/auto/checkpoint.json`。
撞预算/轮次上限后**优雅收尾**（写 checkpoint + 总结）而非硬 throw，支持 `--resume` 续跑。

### 8.3 自主终止护栏

现有终止原因已覆盖大部分（`max_turns` 默认 100 / `max_budget_usd` / `blocking_limit` / `no_progress`）。
auto 把它们当作无人值守的安全闸，并补一道**停滞/循环闸**：

| 闸 | 机制 | 现状 |
|----|------|------|
| 预算闸 | `maxBudgetUsd` 撞上 → 结束并落 checkpoint（路由 `finally` 写 stopReason） | 已实现 |
| 轮次闸 | `maxTurns` | 已有 |
| **停滞/循环闸** | 连续 N 轮工具全失败 → 硬停 `no_progress`；soft 阈值或连续 K 轮无 FS 写入 → 先注入一次自评估 turn 再继续 | 已实现（`AutoStallGuard`）。无 FS 进展只软提醒不硬停，避免误杀只读/规划阶段 |

---

## 9. 文件级改动清单

| 文件 | 改动 | 复用 / 新增 |
|------|------|:---:|
| `src/routing/types.ts` | `SessionMode` 加 `auto`；哨兵 `auto → detect`；`MODE_WEIGHT.auto = 1` | 改 |
| `src/routing/SessionRouter.ts` | `mode ?? 'detect'`；抽 `_createAgenticBackend(autonomy?)` 供 `agentic`/`auto` 共用；`case 'auto'` 传 auto profile；`_raiseMode` 显式模式锁 | 改 |
| `src/kernel/permissions/PermissionPolicy.ts` | `PermissionPolicyOptions.autonomy`；`lockWorkspace` 压制 `allowOutsideWorkspace`；`autoApproveInWorkspace` 跳过确认；bash 相对逃逸加固 | 新增开关 |
| `src/tools/shell/bash/index.ts` | auto 模式下沙箱 `allowUnsandboxedFallback: false`（fail-closed）；由 autonomy profile 派生 | 改 |
| `src/routing/ModeDetector.ts` | `AUTO_ALWAYS` 强意图模式（`自动模式/无人值守/自主执行/全自动/不要问我/auto mode/autonomous/don't ask/yolo`）；auto 以显式为主 | 新增 |
| `src/core/dynamicPrompt.ts` | D4 current_mode 注入 auto 自主说明行 | 改 |
| `src/kernel/compact/CompactPrompt.ts` | auto 在 9 节后追加「自主执行账本」节 | 新增节 |
| `src/kernel/compact/AutoCompact.ts`（或新模块） | 断路器后的无模型截断兜底（仅 autonomy 开启） | 新增 |
| `src/subagent/SubAgentBridge.ts` | 派发时透传 `autonomy`/`lockWorkspace` 与锁死的 `SandboxConfig`（含 fail-closed）；通知背压超限合并摘要 | 改 |
| auto checkpoint 模块（新） | `<workspace>/.meta-agent/auto/checkpoint.json` 读写 + `--resume` | 新增 |
| 写互斥模块（新） | 按规范化路径加锁，挂工具执行层 | 新增 |
| 停滞/循环闸（新） | 连续无进展 / 重复失败检测 | 新增 |
| `src/cli/index.ts` | 接受 `--mode auto`（可选 `--yolo` 别名）+ 帮助文案 | 改 |

> **复用清单**：逻辑牢笼 `workspaceGuard`、OS 沙箱（bwrap/sandbox-exec，bash 默认已启用）、
> 确定性锚点、`maxTurns`/`maxBudgetUsd` 护栏、`GitWorkspaceManager` + `git_*` 工具、
> `SubAgentBridge` 调度与预算上限。
> **新增/收紧清单**（均为 `autonomy` profile 可选开关，零影响其它模式）：沙箱 fail-closed、
> 压缩兜底截断、停滞/循环闸、auto checkpoint/resume、按路径写互斥、子代理牢笼透传、压缩账本节。

---

## 10. 测试计划（验证步骤）

### 10.1 权限牢笼（逻辑防线）

- auto：工作区外 `write_file` → **deny 且无确认弹窗**；
- auto：工作区内 `write_file`/`edit_file` → **allow 且不询问**；
- auto：bash `rm -rf <子目录>` → allow；
- auto：bash `rm -rf ~` / `rm -rf $HOME` / `rm -rf ..`（越界）/ 工作区外绝对路径 → **deny**；
- auto：`permissions.json` 设 `allowOutsideWorkspace: true` → 仍被牢笼压制（`lockWorkspace` 胜）。

### 10.2 沙箱（运行时防线）

- auto：宿主机无 bwrap/sandbox-exec → bash **拒绝执行**（fail-closed），不静默裸跑；
- 非 auto：同条件下仍降级直跑（行为不变，验证零回归）；
- 沙箱可用时：bash 脚本运行时尝试往工作区外写 → 因只读根失败；
- 子代理派发的 `SandboxConfig` 携带 `allowUnsandboxedFallback: false`。

### 10.3 路由与命名

- 哨兵改名后默认（不传 mode）仍自动检测，行为不变；
- 显式 `auto` 不被 campaign/robotics 信号升级；
- `MODE_WEIGHT.auto = 1`：`registerTool` 不覆盖显式 auto。

### 10.4 长会话稳定

- 模拟 compact 连续失败 3 次 → 触发无模型截断兜底，上下文压回阈值，不撞 `blocking_limit`；
- 撞 `maxBudgetUsd`/`maxTurns` → 优雅收尾并写 checkpoint；
- `--resume` 能从 checkpoint 恢复目标与待办；
- 停滞/循环闸：注入重复失败序列 → 触发自评估 turn / 终止。

### 10.5 并发

- 子代理派发携带锁死的 `SandboxConfig`，子代理工作区外写 → deny；
- worktree 隔离：两个写型子代理并发写不互相污染；主代理串行合并可检测冲突；
- 写互斥：并发写同一路径被串行化；
- 通知队列超 100 → 合并摘要而非丢弃。

### 10.6 高阶验证

- 端到端：在临时 git 仓库跑一个多步 + 多子代理的 auto 任务，断言所有文件变更均在工作区内、
  无越界写、崩溃后可 resume；
- 建议用子代理（Task 工具）做一次独立的越界审计：扫所有 `autonomy` 开启路径，确认无绕过双防线的写入口。

---

## 11. 决策复盘表

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 命名冲突 | 哨兵 `auto → detect`，新模式叫 `auto` | 改动点最少，符合「叫 auto」诉求 |
| 路径内破坏性操作 | 全自动放行（含 `rm -rf` 子目录） | 最贴近「无人值守」；安全靠路径边界兜底 |
| 牢笼实现 | 复用 `workspaceGuard` + `PermissionPolicy` 通用 `autonomy` 开关 | 不 fork、不出现 `if mode==='auto'`，低耦合 |
| 沙箱 | 复用现有 bwrap/sandbox-exec，仅 auto 改 fail-closed | 不造轮子；补无人值守 fail-open 缺口 |
| 并发写隔离 | worktree + 串行合并（复用 robotics），**显式 opt-in** | 现成、可检测冲突；默认共享树 + 写互斥，避免误伤只读子代理 |
| 压缩档位 | `agentic` 9 节 + 自主执行账本节 | 复用为主，按 auto 痛点增一节 |
| 稳定性兜底 | 断路器后无模型截断 | 补现有最大缺口，保证无人时不撞墙 |

---

## 12. 实现状态（as-built）与未开发项

> 截至本次提交：核心地基 + 长会话稳定 + 并发隔离主体已实现，709 单测全绿、`tsc`/`build` 通过。
> 本节为**当前真实状态**，与 §9 的设计意图对照阅读。

### 12.1 已实现

| 能力 | 落点（as-built） |
|------|------|
| 模式与路由 | `routing/types.ts`（`auto` + 哨兵 `detect` + `MODE_WEIGHT.auto=1`）、`SessionRouter`（`_createAgenticBackend`、`case 'auto'`、`_raiseMode` 显式锁） |
| 逻辑权限牢笼 | `PermissionPolicy` 通用 `autonomy`（`lockWorkspace`/`autoApproveInWorkspace`）+ bash 相对逃逸加固 |
| 沙箱 fail-closed | **`core/MetaAgentSession._getOrCreateSandboxHandle`**（非设计稿写的 `bash/index.ts`；此处更集中，main+sub 同一路径） |
| 检测 / 提示 / CLI | `ModeDetector.AUTO_ALWAYS`、`dynamicPrompt` D4 AUTO 段、`cli` `--mode auto`（默认 `detect`） |
| 压缩兜底 | 新模块 `kernel/compact/StructuralTruncate.ts`（无模型、保配对的结构化裁剪）+ `AutoCompact` 接入 |
| 压缩 auto 档位 + 账本节 | `CompactPrompt` 新增 `auto` profile = agentic 9 节 + 「自主执行账本」节（已派发子代理 + 不可逆变更）；`MetaAgentSession` 为 auto 选用该 profile |
| 确定性锚点扩容 | `agenticCompactAnchors.buildAutoModeAnchors()` 注入 auto 标记 + 工作区根；子代理 ID 已由 `buildAgenticDeterministicAnchors` 覆盖 |
| 停滞闸 | `kernel/loop/AutoStallGuard.ts`：连续 N 轮全失败 → **硬停**；soft 阈值 / 连续 K 轮无 FS 写入 → **注入一次自评估 turn**（`SELF_EVAL_PROMPT`，meta 消息）后再继续 |
| checkpoint | `core/auto/AutoCheckpointStore.ts` + 路由每轮落盘，**填充** 待办（todo store）/ 活跃子代理 ID（bridge）/ 轮次 / 成本 / 停因；CLI `--resume` 打印恢复横幅 |
| 写互斥 | 新模块 `core/fs/WriteMutex.ts`，经 `ToolCallContext.writeMutex` 注入，write/edit/notebook 三工具加锁 |
| 子代理牢笼透传 | `SubAgentBridge.setAutonomyJail()`（fail-closed 沙箱 + autonomy + projectDir）；`SubAgentRunner` 透传 |
| 通知背压合并摘要 | `_enqueueNotification` 超限时 `mergeOverflowNotifications` 合并为一条带计数的摘要（不丢弃、可累加） |
| 子代理失败退避重试 | `_maybeRetryFailed`：指数退避（`retryBackoffMs`，封顶 30s）重试至上限，耗尽后把失败通知交主代理决策 |
| 调度护栏 auto 保守默认 | `SubAgentBridgeOptions.conservativeAutoDefaults`：并发默认 3 / 总预算默认 $5（显式选项与 env 仍优先） |
| worktree 隔离 | 新模块 `core/auto/AutoWorktreeCoordinator.ts` + 工具 `auto_merge/diff/discard_subagent`（**opt-in**，见 §7.2） |
| CLI | `--mode auto` + `--yolo` 别名 + 帮助文案 |

**与设计稿的出入**：① 沙箱 fail-closed 落在 `MetaAgentSession` 而非 `bash/index.ts`；② 新增的「默认模式」配置字段命名 `promptMode`（避开 robotics 既有 `agentMode` 的单/多体编排含义）；③ worktree 改为 opt-in 并自带 `auto_*` 工具，未复用 robotics `git_*_subagent`；④ 无 FS 进展只「软提醒（自评估）」不硬停，避免误杀正常的只读/规划阶段。

### 12.2 已知保守取舍（非缺口）

- **无 FS 进展检测**只触发一次性自评估、绝不硬停（阈值 12 轮且仅统计跑了工具的轮次），以免长时间读代码/检索/规划被误判为停滞。硬停仍只由「连续全失败」触发。
- **worktree 隔离为 opt-in**：默认共享工作树 + 写互斥；只有显式 `isolateWorktree` 且工作区是 git 仓库才分配独立 worktree（避免误伤 `research_dispatch` 等只读/报告型子代理）。
- **checkpoint 的 `completedSteps/artifacts`** 字段保留在 schema 中但暂不自动填充（无稳定的通用来源）；可由后续会话内的显式记录补充。

> 至此设计文档列出的 auto 模式能力**已全部实现**；上述为有意为之的保守边界，非待办。
