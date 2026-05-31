# meta-agent-runtime 功能报告

> 版本：基于代码审查后最新状态（P0/P1/P2 修复已合入）  
> 日期：2026-05-24

---

## 1. 概述

`meta-agent-runtime` 是一个面向 AI 代理会话管理的 TypeScript 运行时库，核心能力是将底层 LLM API 调用封装为**具有状态、可持续对话、支持工具执行**的代理会话。它在 Claude Code（CC）的内核之上构建了多层抽象，支持三类主要使用场景：通用对话/代码任务（Agentic 模式）、长周期科研实验协调（Campaign 模式）和机器人算法开发（Robotics 模式）。

---

## 2. 核心功能模块

### 2.1 会话管理

#### SessionRouter — 统一入口
- **自动模式检测**：调用方只需传入配置，SessionRouter 在首次 `submit()` 时通过 `ModeDetector` 自动判断应使用哪种后端（direct / agentic / campaign / robotics）。
- **模式只升不降**：`registerTool()` 调用会将模式至少升到 `agentic`；通过 `RouterOptions.mode` 可强制指定模式。首次 `submit()` 之后模式固定，不允许会话中途切换。
- **懒加载后端**：RoboticsSession 通过动态 `import()` 惰性加载，避免循环依赖，且只有 Robotics 模式才承担其初始化开销。
- **生命周期清理**：`dispose()` 触发后会话记忆提取、todo 清理、定时任务清理，以及 RoboticsSession 的资源释放（工作树、心跳定时器等）。

#### 四种会话后端

| 后端 | 适用模式 | 关键特性 |
|------|----------|----------|
| `MetaAgentSession` | direct / agentic | 单轮或全工具循环；底层使用 `AgenticSession` |
| `CampaignSession` | campaign | 自动 compact、token-efficient-tools beta、动态系统提示注入 |
| `RoboticsSession` | robotics | ExperienceStore、Git 工作树、WorkflowLoader、多智能体编排 |
| `DirectSession` | direct（KernelSession 直连） | `maxTurns=1`，compact 禁用，单次 API 调用 |

#### 会话恢复（SessionStore）
- 历史消息以 JSONL 格式**追加写入**，每条消息原子落盘。
- `index.json` 保存最多 50 条会话元数据，支持会话选择器 UI。
- 恢复时读取最后 200 条消息（上限 5 MB），防止超大历史导致内存溢出。
- 使用 Zod 运行时校验过滤损坏记录，单条损坏不影响整批加载。

---

### 2.2 LLM 内核（KernelSession / KernelLoop）

#### KernelSession
- 管理每会话状态：消息历史、累积 token 用量、成本统计、AbortController、文件缓存。
- `submitMessage()` 是 `AsyncGenerator`，实时 yield `KernelEvent`（`text_delta`、`thinking_delta`、`tool_use`、`tool_result`、`compact_boundary`、`result` 等），最后一个事件始终为 `result`。
- 内置并发保护：`_submitInFlight` 标志，防止同一会话同时有两个 submit。
- 支持动态切换主模型（`setModel()`）和追加系统提示（`setAppendSystemPrompt()`）。

#### KernelLoop（核心推理循环）
- 实现完整的 **while(true) 代理循环**：发送消息 → 流式接收 → 执行工具 → 追加结果 → 下一轮。
- 六种终止原因：`success`、`max_turns`、`blocking_limit`、`aborted_streaming`、`aborted_tools`、`max_budget_usd`、`error`。
- **自动 compact**：当上下文接近窗口上限时，调用 flash 模型压缩历史（可禁用）。
- **max_output_tokens 三阶段恢复**：先升到 64k，再多轮追问，最终成功退出。
- **Fallback 模型切换**：若主模型触发 `FallbackTriggeredError`（如思考配额用尽），自动切到 `fallbackModel`，仅触发一次，设置 tombstone 防无限循环。
- **双提供商路由**：`model` 前缀以 `deepseek-` 开头时路由到 `streamDeepSeekMessages`，否则走 Anthropic 流。

---

### 2.3 多 LLM 提供商支持

通过 `config.ts` 的 `detectProvider()` 函数在运行时自动选择提供商：

| 优先级 | 提供商 | 环境变量 | 模型示例 |
|--------|--------|----------|----------|
| 1 | DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-v4`, `deepseek-v4-flash` |
| 2 | Qwen | `QWEN_API_KEY` | `qwen-max`, `qwen-turbo` |
| 3 | Anthropic | `ANTHROPIC_API_KEY` | `claude-opus-4-5`, `claude-haiku-4-5` |

每个提供商配置三个模型层级：primary（主模型）、fallback（降级模型）、flash（轻量/侧调用模型）。

---

### 2.4 工具执行系统

#### 内置工具集

| 类别 | 工具 | 功能 |
|------|------|------|
| 文件系统 | `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `notebook_edit` | 文件读写、模式匹配、正则搜索、Jupyter Notebook 编辑 |
| Shell | `bash`, `powershell` | 执行 shell 命令，支持输出截断、进程超时 |
| 网络 | `web_fetch`, `web_search` | HTTP 请求、搜索引擎查询 |
| UI 交互 | `ask_user`, `send_message`, `todo_write` | 向用户提问、发消息、写 todo 列表 |
| 系统 | `cron_create/list/delete`, `enter_plan_mode`, `exit_plan_mode`, `skill`, `sleep` | 定时任务、计划模式、技能调用 |
| Provenance | `get_provenance`, `get_lineage`, `find_duplicate`, `list_recent` | 数据溯源查询 |
| MCP | `mcp_call`, `list_mcp_resources`, `read_mcp_resource` | Model Context Protocol 集成 |
| 代理 | `run_agent` | 启动子代理任务 |

#### 权限策略（PermissionPolicy）
- 工作区沙箱：文件操作限制在 `workspaceRoot` 之内。
- `beforeToolCall` 钩子：调用方可在工具执行前注入自定义权限检查。
- 计划模式（plan mode）：进入后所有写操作被拦截，仅允许读操作。
- `askUser` 钩子：敏感操作前可弹出确认提示。

#### 工具结果预算（ToolResultBudget）
- 对过大的工具返回值自动截断，防止单次结果撑爆上下文窗口。
- 截断发生在 `applyToolResultBudget()` 步骤，在每轮循环开始时执行。

#### EngineeringToolRegistry
- 按保真度分 5 级（0-4）注册工程仿真工具，高保真工具有更严格的 V&V 前置检查。

---

### 2.5 Campaign 模式——长周期实验协调

Campaign 模式专为**多轮、耗时的科学实验或计算任务**设计，提供如下功能：

#### 状态管理
- `CampaignStateStore`：全局单例（Map），跟踪各 campaign 的当前状态、参数空间、结果集合。
- `MetaAgentContextStore`：将 campaign 上下文注入每轮系统提示尾部，让模型始终知道当前实验状态。

#### DOE（实验设计）支持
- `DOESampler`：设计空间采样，支持拉丁超立方等采样策略。
- `FidelityLadder`：多保真度梯形策略——从低保真（快速、便宜）到高保真（精确、昂贵）逐级筛选候选点。
- `ParetoAnalyzer`：多目标帕累托前沿分析，找出在多个优化目标上不被支配的最优解。
- `CampaignMonitor`：实时监控 campaign 进度，检测停滞、触发补充采样。

#### 多工作节点协调
- `WorkerCoordinator`：管理多个 agent 工作者，分配任务，汇总结果。

#### Compact 指令注入
- 每次 `submit()` 前，`CampaignSession` 构建包含 campaign 上下文 + Compact Instructions 的系统提示后缀，确保即使对话历史被压缩，关键 campaign 状态（provenance ID、V&V 事件）也不会丢失。

#### 内置 Campaign 插件
- `DOE Campaign Plugin`：提供基于 DOE 的完整实验循环。
- `Paper Repro Plugin`：论文复现流程自动化（抓取论文→解析实验→复现代码→结果对比）。

---

### 2.6 Robotics 模式——机器人算法开发

Robotics 模式在 Agentic 基础上叠加了一系列机器人领域特有能力：

#### 经验知识库（ExperienceStore）
- 持久化存储机器人实验经验：参数组合、结果指标、成功/失败标注。
- `ExperiencePendingStore`：会话内缓冲区，实验结束后批量提交到 ExperienceStore。
- 支持按机器人、域、时间范围检索相关经验，注入系统提示帮助模型避免重复失败。

#### 硬件配置（HardwareProfile）
- 描述机器人硬件规格：关节数量、力矩限制、安全边界等。
- 注入到动态提示段 R1（机器人身份）和 R4（安全约束），使模型生成符合物理约束的代码。

#### Git 工作树管理（GitWorkspaceManager）
- 为每个子代理任务分配独立的 Git 工作树，隔离并行实验的文件系统操作。
- 子代理完成后自动清理工作树；提供分支合并和冲突检测支持。

#### 团队协作模式（TeamStore / TeamWatcher）
- `TeamStore`：Git 追踪的共享任务看板，支持多 agent 实例并发读写（乐观锁防止写冲突）。
- 任务状态机：`backlog → claimed → in_progress → review → done`（以及 `blocked`、`paused`、`handoff`、`cancelled`）。
- 模块化拆分：支持为不同模块分配 ownerUnit，实现代码域责任分工。
- 分支管理：`teamBranch()` 为任务创建标准命名分支（校验分支名防注入）。
- PR 草稿、任务交接（handoff）、GitHub Issues 同步。
- `TeamWatcher`：30 分钟轮询检测其他 agent 对 `team.json` 的修改，生成 `TeamWatcherEvent` 通知主 agent。
- 冲突检测：检查多 agent 是否在相同文件路径上并发工作（路径冲突报告）。

#### Workflow 系统（WorkflowLoader）
- 从项目目录的 `AGENT.md` 加载工作流定义（Markdown + YAML frontmatter）。
- 工作流分阶段（Phase）执行，每阶段有 gates（退出条件），满足后才能进入下一阶段。
- 提供 `workflow_status`、`workflow_advance`、`workflow_complete_gate`、`workflow_list_phases` 等工具。
- `WorkflowStateStore` 持久化工作流进度，支持恢复中断的工作流。

#### 动态系统提示段（R1-R5）
- R1：机器人身份与代理模式（single/multi）
- R2：经验知识注入（从 ExperienceStore 检索相关记录）
- R3：当前任务和实验上下文
- R4：硬件安全限制
- R5：会话恢复上下文（上次会话摘要）

#### 子代理编排（SubAgentBridge）
- 主 agent 可通过 `spawn_sub_agent` 工具并行派发子任务（如并行跑多个仿真实验）。
- `SubAgentBridge` 管理子代理并发调度（concurrency limit 可配置）。
- `SubAgentRunner` 在独立 Git 工作树中执行子代理，隔离文件系统副作用。
- 提供 `get_sub_agent_status`、`get_sub_agent_intermediate`、`cancel_sub_agent`、`list_sub_agents` 等管理工具。
- `finishedThisSession` 统计本会话已完成的子代理数（包括成功和失败）。

---

### 2.7 V&V（验证与确认）系统

`VVHookChain` 提供工程仿真结果的管道式校验：

| 内置 Checker | 功能 |
|---|---|
| `OOMChecker` | 检测数值结果中的量级异常（如结果偏离基准 N 个数量级） |
| `DimensionChecker` | 物理量单位一致性检查（调用 UnitRegistry） |
| `PhysicsConstraintChecker` | 物理约束验证（如能量守恒、质量守恒） |

- V&V 结果通过 `VVEvent` 记录到 ProvenanceTracker，可溯源查询。
- 工程工具执行后自动触发关联的 V&V 检查器（通过 `instrumentTool` 中间件）。

---

### 2.8 数据溯源（ProvenanceTracker）

- 为每次工程工具调用生成唯一的 `provenanceId`，记录：输入参数、输出结果、执行时间戳、模型版本、V&V 状态。
- 支持查询：`get_provenance`（单条）、`get_lineage`（依赖链）、`find_duplicate`（重复检测）、`list_recent`（时间线）。
- `CampaignSession` 的 Compact Instructions 中包含活跃 provenance ID，确保上下文压缩后不丢失溯源链接。

---

### 2.9 会话记忆系统（Memory Writer）

- 会话结束时（`dispose()` 触发），自动运行 flash 模型侧调用，分析对话内容，判断是否有值得持久化的通用知识。
- 记忆类型：`user`（用户偏好）、`feedback`（反馈）、`domain_knowledge`（领域知识）、`reference`（参考资料）；Campaign 模式额外支持 `campaign_lessons`，Robotics 模式支持 `robot_lessons`。
- 写入 `~/.meta-agent/memory/` 目录下的 Markdown 文件，并维护 `MEMORY.md` 索引。
- 安全保障：`sanitizeScalar` 剥离换行符，防止 LLM 输出通过 YAML frontmatter 注入额外字段。
- 模型可配置（默认 `deepseek-v4-flash`，纯 Anthropic 环境传入 `flashModel`）。

---

### 2.10 Jobs 系统（后台工程任务）

- `JobManager`：提交、追踪、取消工程仿真任务（如 CFD、FEA 计算），支持任务队列。
- `JobExecutor`：实际执行工程工具调用，写回结果和 artifacts。
- `JobStore`：任务状态持久化（JSON），Zod 运行时校验防止磁盘损坏数据恢复失败。
- 任务生命周期：`submitted → queued → running → completed/failed/cancelled`。
- `cronStore`：基于 cron 表达式的定时任务，会话结束时自动清理。

---

### 2.11 单位系统（UnitRegistry）

- `UnitRegistry`：注册物理量（SI 单位及转换），支持单位推导和自动换算。
- `DimensionalConsistencyChecker`：在计算链中检查量纲一致性，配合 V&V 系统使用。

---

## 3. 配置能力

`MetaAgentConfig` 提供 30+ 个配置项，覆盖：

- **身份**：`name`、`domain`（专业领域）、`outputStyle`
- **模型**：`model`、`fallbackModel`、`flashModel`、`maxTokens`、`maxTurns`、`maxBudgetUsd`
- **工具**：`tools`、`permissionConfig`、`beforeToolCall`、`askUser`
- **流式**：`onMessagesUpdate`、`onPermissionDenial`
- **记忆**：自动通过 `dispose()` 触发，无需显式配置
- **会话恢复**：`sessionId`（传入已有 sessionId 恢复历史对话）
- **调试**：`debugMode`（打印模式检测和升级日志）
- **计划模式**：`planModeRef`（引用外部 plan mode 开关）
- **MCP 服务器**：`mcpServers`（集成外部 MCP 工具）
- **运行时上下文**：`runtimeContext`（注入 jobManager、vvChain、provenanceTracker）

---

## 4. 对外 API（公开导出）

```
SessionRouter, ModeDetector               ← 推荐入口
MetaAgentSession, CampaignSession,         ← 会话后端（可直接使用）
RoboticsSession, DirectSession

KernelSession                              ← 底层内核（高级用法）

EngineeringJob, JobManager, JobStatus      ← 工程任务系统
VVHookChain, VVEvent, OOMChecker, etc.     ← 验证系统
ProvenanceTracker, ProvenanceRecord        ← 溯源系统
UnitRegistry, DimensionalConsistencyChecker ← 单位系统

WorkflowLoader, WorkflowDefinition         ← 工作流系统
CampaignStateStore                         ← Campaign 协调

SubAgentBridge, SubAgentRunner             ← 子代理系统
SubAgentSchedulerStats

TeamStore, TeamWatcher                     ← 团队协作（Robotics）

createFsTools, createBashTool, etc.        ← 标准工具工厂
EngineeringToolRegistry                    ← 工程工具注册
```

---

## 5. 典型使用场景

### 场景 A：通用代码代理（Agentic 模式）
```typescript
const router = new SessionRouter({ model: 'claude-opus-4-5' })
router.registerTool(myTool)
for await (const event of router.submit('帮我优化这段 Python 代码')) {
  if (event.type === 'text_delta') process.stdout.write(event.delta)
}
await router.dispose()
```

### 场景 B：长周期实验（Campaign 模式）
```typescript
const router = new SessionRouter({ mode: 'campaign', domain: 'fluid_dynamics' })
// 多轮交互，自动 compact 保证不超窗口
for await (const event of router.submit('运行雷诺数 1000-10000 的 CFD 扫描')) { ... }
// 会话结束后记忆自动写入
await router.dispose()
```

### 场景 C：机器人算法开发（Robotics 模式）
```typescript
const router = new SessionRouter({
  mode: 'robotics',
  robot: 'go2',
  runtimeContext: { jobManager, vvChain, provenanceTracker },
})
for await (const event of router.submit('设计一个四足步态控制器')) { ... }
// 多代理并行：主 agent 可 spawn 子代理跑并行仿真
await router.dispose()
```

---

## 6. 总结

`meta-agent-runtime` 的功能体系可概括为三层：

1. **基础层**：KernelSession/KernelLoop 提供流式 LLM 调用、工具执行、错误恢复的原子能力。
2. **会话层**：SessionRouter/CampaignSession/RoboticsSession 在基础层之上构建状态管理、模式自动化、持久化、记忆系统。
3. **领域层**：V&V 系统、DOE 协调、ExperienceStore、TeamStore、WorkflowLoader 为科学计算和机器人开发提供专业化增强。

三层合力，使其既可作为通用代理运行时，也可作为机器人和科研领域的专业 AI 工程师助理平台。
