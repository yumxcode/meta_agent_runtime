# Meta-Agent Runtime — 架构参考（As-Built）

> 本文档描述**当前代码实际状态**，不是规划文档。  
> 最后更新：2026-05

---

## 目录

1. [包结构与分层](#1-包结构与分层)
2. [Static System Prompt（S1-S6）](#2-static-system-prompt-s1-s6)
3. [Dynamic System Prompt（D-sections + Rx）](#3-dynamic-system-prompt-d-sections--rx)
4. [Compact 系统](#4-compact-系统)
5. [Session 类型](#5-session-类型)
6. [Robotics Mode](#6-robotics-mode)
7. [支持的模型](#7-支持的模型)

---

## 1. 包结构与分层

### 1.1 唯一包：`@meta-agent/runtime`

`cc-kernel` 已合并入 `meta-agent-runtime`，只剩一个包。目录分层：

```
src/
├── kernel/          ← Layer 0: agentic loop 内核（原 cc-kernel）
│   ├── KernelSession.ts     主入口：单 session 的 API 调用 + tool loop
│   ├── api/                 streamMessages + 错误处理
│   ├── loop/                KernelLoop（多轮 tool-use 循环）
│   ├── tools/               工具执行、权限检查、并发调度
│   ├── compact/             AutoCompact（触发 + 执行 + circuit breaker）
│   ├── messages/            消息历史管理
│   ├── utils/               Context（窗口大小/阈值）、CostTracker
│   └── __tests__/           Vitest 单元测试（104 cases）
│
├── modes/           ← Layer 1: session 适配层
│   ├── AgenticSession.ts    包装 KernelSession，管理工具注册和 cost tracking
│   ├── DirectSession.ts     单轮模式（maxTurns=1，no compact）
│   └── CampaignSession.ts   campaign 模式
│
├── core/            ← Layer 2: 共享基础设施
│   ├── MetaAgentSession.ts  高层 facade（buildDynamicSections + SectionRegistry）
│   ├── staticPrompt.ts      buildStaticSystemPrompt()（S1-S6）
│   ├── dynamicPrompt.ts     buildDynamicSections()（D-sections + modeExtensions）
│   ├── systemPromptSections.ts  SectionRegistry + systemPromptSection()
│   ├── compact/             compactPrompt（10-section meta-agent compact）
│   ├── memory/              MEMORY.md 读取、findRelevantMemories
│   ├── contract/            TaskContract（D0 goal anchor）
│   └── config.ts            resolveConfig、detectProvider
│
├── robotics/        ← Layer 2: robotics 模式
│   ├── RoboticsSession.ts   主入口（组合 AgenticSession + R-sections + 工具）
│   ├── dynamicSections.ts   R1-R5 sections
│   ├── ExperienceStore.ts   经验知识库
│   ├── HardwareProfile.ts   硬件规格持久化
│   ├── persistence/         RoboticsProjectStore（会话持久化 + 星标/tag/自动清理）
│   ├── git/                 GitWorkspaceManager（sub-agent 分支协同）
│   └── tools/               15 个 robotics 工具
│
├── campaign/        ← Layer 2: campaign 模式基础设施
├── subagent/        ← SubAgentBridge（sub-agent 调度 + 通知）
├── workflow/        ← WorkflowLoader + WorkflowStateStore + W1 section
├── routing/         ← SessionRouter（模式检测 + session 工厂）
├── runtime/         ← instrumentTool（V&V hook + provenance 注入）
└── cli/             ← CLI 入口
```

### 1.2 依赖方向（单向，不可逆）

```
kernel/ ← modes/ ← core/ ← robotics/
                          ← campaign/
                          ← subagent/
                          ← workflow/
                          ← routing/
                          ← cli/
```

`core/` 不依赖 `robotics/`。robotics 通过 `modeExtensions` 扩展点将 R-sections 注入 `buildDynamicSections()`，保持依赖单向。

---

## 2. Static System Prompt（S1-S6）

**文件：** `src/core/staticPrompt.ts`  
**生成：** `buildStaticSystemPrompt()`  
**特点：** 内容不随 session 变化，在 `RoboticsSession`/`MetaAgentSession` 构造时写入 `systemPrompt`，跨 session 可被 Anthropic prompt cache。

```
S1  identity_definition         身份定义：Meta-Agent 工程 AI + 能力边界
S2  system_rules                工具权限模型、溯源 ID 格式、session 规范
S3  task_execution_rules        工程假设声明、超范围 flag（campaign/agentic 专属规则已移出）
S5  vv_response_protocol        V&V 响应规范：PRE/POST-CALL ABORT + WARNING 处理
S6  doe_campaign_knowledge      DOE/Campaign 领域知识：L0/L1/L2、Pareto、escalation
```

> **S4 已迁移：** `tool_invocation_protocol` 从静态区移入动态区（D4c），因为不同模式有不同工具规则。

---

## 3. Dynamic System Prompt（D-sections + Rx）

**文件：** `src/core/dynamicPrompt.ts`  
**生成：** `buildDynamicSections(opts: DynamicSectionOptions)`  
**特点：** 每次 `submit()` 组装，通过 `SectionRegistry` 缓存（memoized / volatile）。

### 3.1 完整 Section 顺序

```
D1c  agent_directives      [memoized]   AGENT.md: 项目规则、workflow 定义（首位）
D0   task_contract         [memoized]   任务锚点（有 TaskContract 时注入）
D1b  memory_content        [volatile]   MEMORY.md 索引 + 召回的 topic 文件
D2   env_info              [memoized]   当前日期、知识截止日期
D3   language              [memoized]   语言偏好
D4   current_mode          [memoized]   当前 AgentMode 声明
D4a  engineering_standards [memoized]   工程计算规范（仅 agentic + campaign 模式）
D4b  campaign_knowledge    [memoized]   DOE/Campaign 补充知识（仅 campaign 模式）
D4c  tool_invocation_protocol [memoized] 工具调用协议（按 mode 裁剪，见下）
Rx   modeExtensions        [caller-managed] 模式专属扩展（如 R1-R5）
D5   mcp_instructions      [memoized]   已连接的 MCP server 列表
D6   output_style          [memoized]   输出风格配置
D7   summarize_tool_results[memoized]   工具结果摘要规范
D11  subagent_notifications [volatile]  SubAgentBridge 完成通知（有 bridge 时注入）

── Campaign 专属（仅 campaign mode）─────────────────────────────
D8   campaign_context      [volatile]   活跃 campaign phases + Pareto
D9   session_provenance    [memoized*]  近期计算记录（新记录写入时失效）
D10  phase_guidance        [volatile]   当前 phase 操作指令
```

### 3.2 D4c 按 mode 裁剪

| mode | 内容 |
|------|------|
| `direct` | 通用规则（并行执行、错误恢复） |
| `robotics` | 通用规则 |
| `agentic` | 通用规则 + 溯源工具指南 |
| `campaign` | 通用规则 + 溯源工具指南 + V&V 响应规则 |

### 3.3 modeExtensions 扩展点

`DynamicSectionOptions.modeExtensions?: SystemPromptSection[]`

在 D4c 之后、D5 之前插入。RoboticsSession 用此注入 R1-R5：

```typescript
const allSections = buildDynamicSections({
  mode: 'robotics',
  modeExtensions: this._getRoboticsExtensions(),  // [R1, R2, R3, R4, R5, (W1)]
  sessionId: this.sessionId,
  sessionStartMs: this._sessionStartMs,
  currentQuery: prompt,
  subAgentBridge: this.bridge,
  projectDir: this.projectDir,
})
```

这保证了 `core/` 不依赖 `robotics/`。

### 3.4 SectionRegistry 缓存策略

| API | 行为 |
|-----|------|
| `systemPromptSection(name, fn)` | memoized：fn 只在首次 resolve 时执行，结果缓存至 `invalidate(name)` |
| `DANGEROUS_uncachedSystemPromptSection(name, fn)` | volatile：每次 `resolveToString()` 都重新执行 |
| `registry.invalidate(name)` | 使指定 section 缓存失效（下次重算） |

### 3.5 已移除的 sections

| Section | 原位置 | 移除原因 |
|---------|--------|---------|
| D1a `memory_guidance` | 动态区（所有模式） | Memory 写入由 post-session 子 agent 负责，主 agent 只读；写入协议对主 agent 无用 |
| D4a `engineering_standards` for robotics | 动态区 | Robotics 当前阶段不需要工程规范，仅保留 agentic/campaign |

---

## 4. Compact 系统

### 4.1 KernelSession AutoCompact

**文件：** `src/kernel/compact/`  
触发逻辑：每轮 API 返回后检测 `input_tokens >= autoCompactThreshold`。

```
effectiveContextWindow = contextWindow - min(maxOutputTokens, 20_000)
autoCompactThreshold   = effectiveContextWindow - 13_000 buffer
blockingLimit          = effectiveContextWindow - 3_000 buffer
```

触发时：用 Haiku 对当前对话做结构化摘要，替换 `mutableMessages`，`SectionRegistry.invalidateAll()`。

**Circuit breaker：** 连续失败 3 次后停止触发，防止 compact 本身进入死循环。

### 4.2 Meta-Agent Compact Prompt（10章节）

**文件：** `src/core/compact/compactPrompt.ts`  
在 KernelSession compact 时被调用，替换 CC 的标准 9 章节 compact prompt：

```
1. Primary Request and Intent
2. Key Technical Concepts
3. Campaign State              ← 替换 "Files and Code Sections"
4. Computations and Results    ← 保留所有 prov-xxx ID
5. V&V Events                  ← PRE/POST-CALL ABORT + WARNING
6. Problem Solving
7. All user messages
8. Pending Tasks
9. Current Work
10. Optional Next Step         ← verbatim 引用 + 最后 prov-xxx
```

### 4.3 触发阈值（按模型）

```
模型              上下文窗口      触发阈值（effectiveWindow - 13K）
─────────────────────────────────────────────────────────
claude-*          200,000        167,000
deepseek-*      1,000,000        967,000
```

> ⚠️ DeepSeek 1M 窗口意味着 compact 在实践中很少触发；主要靠 blockingLimit 防止上下文溢出。

---

## 5. Session 类型

### 5.1 四种模式对比

| 模式 | Session 类 | appendSystemPrompt | 主要用途 |
|------|-----------|-------------------|---------|
| `direct` | `DirectSession` | 无（maxTurns=1） | 单轮问答 |
| `agentic` | `MetaAgentSession` | `buildDynamicSections({ mode: 'agentic' })` | 多轮工具调用 |
| `campaign` | `MetaAgentSession` | `buildDynamicSections({ mode: 'campaign' })` + D8-D10 | DOE + 多保真度实验 |
| `robotics` | `RoboticsSession` | `buildDynamicSections({ mode: 'robotics', modeExtensions: [R1-R5] })` | 机器人算法开发 |

### 5.2 SessionRouter

**文件：** `src/routing/SessionRouter.ts`  
三层模式检测：

```
Layer 1: 显式 hint（config.mode）→ 直接返回，零成本
Layer 2: LLM 分类（Haiku，~300ms，$0.00012）→ 超时降级正则
Layer 3: 环境信号（磁盘读 active campaigns）→ 至少 agentic
```

### 5.3 MetaAgentSession 结构

```typescript
MetaAgentSession {
  inner: AgenticSession           // KernelSession wrapper
  sectionRegistry: SectionRegistry
  toolRegistry: Map<name, tool>
  _subAgentBridge?: SubAgentBridge
  _taskContract?: TaskContract

  submit(prompt):
    1. buildDynamicSections(opts)
    2. sectionRegistry.resolveToString(sections)
    3. inner.setAppendSystemPrompt(resolved)
    4. inner.submit(prompt)          // KernelSession loop
}
```

---

## 6. Robotics Mode

### 6.1 RoboticsSession 结构

```typescript
RoboticsSession {
  inner: AgenticSession            // KernelSession wrapper（static prompt = S1-S6）
  bridge: SubAgentBridge           // sub-agent 调度 + D11 通知
  store: ExperienceStore           // 经验知识库
  hwProfile: HardwareProfile       // 硬件规格
  gitMgr: GitWorkspaceManager      // sub-agent 分支管理
  sectionRegistry: SectionRegistry // R1-R5 + D-sections 缓存
  _sessionStartMs: number          // D2 env_info 时间戳
}
```

### 6.2 Prompt 布局（每次 submit）

```
systemPrompt      = buildStaticSystemPrompt()      S1-S6（构造时设置，可 cache）
appendSystemPrompt = buildDynamicSections({        每次 submit 重组装
  mode: 'robotics',
  modeExtensions: [R1, R2, R3, R4, R5, (W1)]
})

D-sections（同所有模式）+ R-sections（robotics 专属）：
  D1c  AGENT.md
  D0   task_contract（可选）
  D1b  memory_content
  D2   env_info
  D3   language
  D4   current_mode = 'robotics'
  D4c  tool_invocation_protocol（通用规则，无 V&V）
  R1   robotics_domain       agent 模式（single/multi）+ 协调规则  [memoized¹]
  R2   experience_index      ExperienceStore 知识库索引            [memoized]
  R3   robotics_subagents    活跃 sub-agent 状态 + git 分支        [volatile]
  R4   hardware_profile      硬件规格 + 安全限制                   [memoized]
  R5   robotics_progress     进度笔记 + resume 上下文              [volatile²]
  (W1) workflow_phase        工作流执行状态（AGENT.md 有 workflow 时）[volatile]
  D5   mcp_instructions
  D6   output_style
  D7   summarize_tool_results
  D11  subagent_notifications
```

> ¹ R1 在首次 submit 后 mode 确定，invalidate 一次再 memoize。  
> ² R5 仅在 resumed session 或有 progressNotes 时输出，否则返回 null。

### 6.3 Robotics 工具集（15 个）

| 分类 | 工具名 |
|------|--------|
| 经验管理 | `experience_search`、`experience_write`、`experience_load` |
| 硬件规格 | `hardware_profile_read`、`hardware_profile_write` |
| Sub-agent 调度 | `experiment_dispatch`、`paper_search` |
| 项目状态 | `progress_note` |
| 会话管理 | `session_list`、`session_star`、`session_tag` |
| Git 协同 | `git_sync_to_subagent`、`git_merge_subagent`、`git_diff_subagent`、`git_discard_subagent` |

### 6.4 会话持久化与生命周期管理

**文件：** `src/robotics/persistence/RoboticsProjectStore.ts`  
**存储路径：** `~/.claude/meta-agent/robotics/projects/<sha1(projectDir)>/state.json`

| 字段 | 说明 |
|------|------|
| `starred` | 星标（true = 豁免 7 天自动清理） |
| `tags` | 用户标签，如 `["go2", "mpc", "sprint-3"]` |
| `lastActiveAt` | 最后活跃时间戳（heartbeat 每 30s 更新） |
| `progressNotes` | 本 session 的进度笔记（最多 10 条） |
| `agentMode` | 已分类的 single/multi 模式（resume 时恢复） |

**自动清理：** 每次 `init()` 时 fire-and-forget 调用 `purgeStale()`，删除非星标且 7 天未活跃的 session 目录。30 天的 RESUME_WINDOW 不受影响（仅控制能否 resume）。

### 6.5 W1 vs D1c 的分工

| Section | 内容 | 缓存 |
|---------|------|------|
| D1c `agent_directives` | AGENT.md 原文（包含 workflow 定义、phase 内容） | memoized |
| W1 `workflow_phase` | 运行时执行状态：当前 phase 位置、gate 完成情况、advance 提示 | volatile |

W1 不重复输出 phase 内容，只输出执行状态。

---

## 7. 支持的模型

### 7.1 Anthropic

| 模型 | 上下文窗口 |
|------|-----------|
| `claude-opus-4-6` | 200,000 |
| `claude-sonnet-4-6` | 200,000 |
| `claude-haiku-4-5-20251001` | 200,000 |
| `claude-opus-4-5`、`claude-sonnet-4-5`、`claude-haiku-4-5` | 200,000 |
| `claude-3-7-sonnet-20250219`、`claude-3-5-sonnet-20241022` | 200,000 |

### 7.2 DeepSeek（`api.deepseek.com/anthropic`，Anthropic 兼容端点）

| 模型 ID | 别名 | 上下文 | 定价（/M tokens） |
|---------|------|--------|----------------|
| `deepseek-chat` | `deepseek-v3` | 1,000,000 | in: $0.27 / out: $1.10 / cache-hit: $0.07 |
| `deepseek-v4-flash` | — | 1,000,000 | in: $0.27 / out: $1.10 / cache-hit: $0.07 |
| `deepseek-reasoner` | `deepseek-r1` | 1,000,000 | in: $0.55 / out: $2.19 / cache-hit: $0.14 |
| `deepseek-v4-pro` | — | 1,000,000 | in: $0.55 / out: $2.19 / cache-hit: $0.14 |

**配置：**
```typescript
const session = new RoboticsSession({
  model:   'deepseek-chat',
  baseURL: 'https://api.deepseek.com',
  apiKey:  process.env.DEEPSEEK_API_KEY,
})
```

`detectProvider()` 通过 `baseURL` 自动识别 DeepSeek 并切换到正确的端点路径。

---

## 附：文档索引

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/architecture/meta-agent-architecture.md`（本文） | ✅ 当前 | As-built 总参考 |
| `docs/workflow-system-design.md` | ✅ 当前 | Workflow + AGENT.md 加载机制（as-built） |
| `docs/permissions.md` | ✅ 有效 | 工具权限声明规范 |
| `docs/robotics-mode-design.md` | 📦 归档 | v1 设计草稿 + 设计 vs 实现差异说明 |
| `docs/robotics-mode-design-v2.md` | 📦 归档 | v2 设计草稿 + 设计 vs 实现差异说明 |
| `docs/prompt-optimization-plan.md` | 📦 归档 | Prompt 演进记录（各轮优化 + 未实现项） |
