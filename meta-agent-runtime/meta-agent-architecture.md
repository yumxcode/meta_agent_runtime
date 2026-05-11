# Meta-Agent Runtime — Architecture & Prompt Engineering Plan

## 1. Prompt 全景对比：Claude Code vs Meta-Agent

### 1.1 Claude Code System Prompt 结构（src/constants/prompts.ts）

Claude Code 的 system prompt 是一个**分层、分区、带缓存策略**的工程化系统，分为两大区域：

```
┌─────────────────────────────────────────────────────────────┐
│  STATIC ZONE（静态区，scope: 'global'，跨 org 可缓存）       │
│                                                             │
│  1. getSimpleIntroSection()     身份定义                    │
│     "You are an interactive agent that helps users         │
│      with software engineering tasks."                     │
│                                                             │
│  2. getSimpleSystemSection()    系统规则                    │
│     - 工具权限模型、Markdown 渲染规范                        │
│     - system-reminder 标签说明                              │
│     - 自动压缩提示（context 无限）                           │
│                                                             │
│  3. getSimpleDoingTasksSection() 任务执行规范               │
│     - 最小化原则：不加超范围改动、不写无用注释               │
│     - 安全规范：OWASP Top 10                                │
│     - 完成前验证：run the test, execute the script          │
│                                                             │
│  4. getActionsSection()         行动风险规范                │
│     - 可逆性判断 + blast radius                             │
│     - 哪些操作必须先问用户（push、rm -rf、drop table…）      │
│                                                             │
│  5. getUsingYourToolsSection()  工具使用规范                │
│     - Read/Edit/Write 优先于 Bash                           │
│     - 并行调用无依赖的工具                                   │
│     - TaskCreate/TodoWrite 任务跟踪规范                      │
│                                                             │
│  6. getSimpleToneAndStyleSection() 风格规范                 │
│     - 不用 emoji、不用冒号 before tool calls                 │
│     - 文件路径格式：file_path:line_number                   │
│                                                             │
│  7. getOutputEfficiencySection() 输出效率规范               │
│     - Lead with answer，省 preamble                         │
│     - 简洁、直接、不重复用户说过的内容                       │
│                                                             │
│  ══════════ SYSTEM_PROMPT_DYNAMIC_BOUNDARY ══════════       │
│                                                             │
│  DYNAMIC ZONE（动态区，scope: 'user'，per-session 缓存）     │
│                                                             │
│  8. session_guidance（memoized）                            │
│     - 基于当前工具集生成的会话特定指导                       │
│     - AskUserQuestion、Agent、Skill 工具的使用时机           │
│                                                             │
│  9. memory（memoized）                                      │
│     - MEMORY.md + ~/.claude/memory/ 下的记忆文件            │
│     - 最大 200 行 / 25KB，超出截断                          │
│                                                             │
│  10. env_info_simple（memoized）                            │
│      - CWD、git repo 状态、平台、shell 版本                  │
│      - 当前模型 ID + knowledge cutoff                       │
│                                                             │
│  11. language（memoized）用户语言偏好                       │
│  12. output_style（memoized）输出风格配置                   │
│  13. mcp_instructions（volatile！每轮重算）                  │
│      - 已连接 MCP 服务器的指令（MCP 可中途连接/断开）         │
│  14. scratchpad（memoized）临时工作目录规范                  │
│  15. frc（memoized）旧工具结果清除提示                       │
│  16. summarize_tool_results（memoized）                     │
│      "Write down any important information during work"    │
└─────────────────────────────────────────────────────────────┘
```

**Claude Code 还有三个独立子系统：**

```
┌─────────────────────────────────────────────────────────────┐
│  COMPACT 系统（src/services/compact/prompt.ts）              │
│                                                             │
│  压缩 prompt 包含 9 个标准章节：                             │
│  1. Primary Request and Intent                              │
│  2. Key Technical Concepts                                  │
│  3. Files and Code Sections（含完整代码片段）                │
│  4. Errors and fixes                                        │
│  5. Problem Solving                                         │
│  6. All user messages（逐条列出）                            │
│  7. Pending Tasks                                           │
│  8. Current Work（最近操作的详细描述）                       │
│  9. Optional Next Step（含原话引用，防止漂移）               │
│                                                             │
│  + NO_TOOLS_PREAMBLE：压缩过程不允许使用任何工具             │
│  + Partial compact：只压缩最近消息（非全量）                  │
└─────────────────────────────────────────────────────────────┘

---

## 0. Meta-Agent Compact 系统

### 0.1 设计背景：两条路径，两个问题

Meta-agent 有两条执行路径，compact 问题完全不同：

| 路径 | 原有问题 | 根本原因 |
|------|---------|---------|
| **MetaAgentSession** | 无 compact，`maxTurns` 是唯一安全阀，上下文满了直接报错 | 自研 agentic loop，没有继承 CC 的 auto-compact |
| **KernelBridge** | CC auto-compact 会运行，但摘要不保留 provenance ID / campaign state / V&V events | CC 的摘要章节面向代码工作，不知道工程仿真领域的关键信息 |

这两个问题需要不同层次的修复，且不能互相替代。

---

### 0.2 CC Compact vs Meta-Agent Compact 对比

| 维度 | CC Compact | Meta-Agent Compact |
|------|-----------|-------------------|
| **触发机制** | token 数超过 contextWindow - 13K buffer | token 数超过 contextWindow - 20K - 10K buffer |
| **执行策略** | 5种（full / partial-from / partial-up_to / micro / cache-fork） | 1种（full compact，替换全部 mutableMessages） |
| **摘要章节数** | 9章节 | 10章节（扩展3个 + 替换1个） |
| **章节 3** | Files and Code Sections（文件路径 + 代码片段） | **Campaign State**（phase / escalation决策 / Pareto摘要） |
| **章节 4** | Errors and fixes | **Computations and Results**（全部 provenance ID 逐条列出）★ |
| **章节 5** | Problem Solving | **V&V Events**（PRE/POST-CALL ABORT + WARNING 详情）★ |
| **章节 6** | Problem Solving（保留） | Problem Solving（保留） |
| **章节10** | Optional Next Step（verbatim引用） | Optional Next Step（verbatim引用 + 最后一个prov-xxx） |
| **NO_TOOLS_PREAMBLE** | ✓ | ✓ |
| **`<analysis>` 草稿块** | ✓ 写完后剥离 | ✓ 写完后剥离 |
| **KernelBridge 集成** | 原生 | 通过 `## Compact Instructions` 注入，无需改 CC 代码 |

---

### 0.3 整体架构图

```
用户请求
    │
    ├─── MetaAgentSession（自研 agentic loop）
    │         │
    │         │  每轮 finalMsg 返回后
    │         ▼
    │    shouldCompact(model, input_tokens)?
    │         │ Yes（超过阈值）
    │         ▼
    │    runCompact()
    │    ├── system: getMetaAgentCompactPrompt()   ← 10章节 meta-agent prompt
    │    ├── messages: 当前 mutableMessages
    │    ├── tools: [] (禁止工具)
    │    └── max_tokens: 20,000
    │         │
    │         ▼
    │    formatCompactSummary()                    ← 剥离 <analysis> 草稿
    │         │
    │         ▼
    │    mutableMessages = [{ role:'user', content: summary }]
    │    sectionRegistry.invalidateAll()           ← 动态区全部重算
    │    agentic loop 继续 ──────────────────────────────────┐
    │                                                        │
    └─── KernelBridge（CC QueryEngine 路由）                  │
              │                                              │
              │  每次 submit() 前                            │
              ▼                                              │
         _buildEnrichedSuffix()                              │
         ├── Part 1: campaign context（已有）                 │
         └── Part 2: buildCompactInstructions()  ← 新增      │
              ├── ## Compact Instructions header              │
              ├── 保留规则（prov ID / Campaign / V&V）        │
              ├── 当前 provenance 快照（live）                 │
              └── 当前 campaign 状态快照（live）              │
                   │                                         │
                   ▼ 注入 CC system prompt                   │
              CC auto-compact 运行时读取指令并遵循             │
              （CC compact prompt 原生支持，无需改 CC 代码）    │
                                                             ▼
                                              compact 后的会话继续
```

---

### 0.4 触发阈值

```
threshold = contextWindow - COMPACT_MAX_OUTPUT(20K) - COMPACT_BUFFER(10K)

模型          上下文窗口    触发阈值
──────────────────────────────────────
claude-*      200,000      170,000
deepseek-*     64,000       34,000
qwen-max       32,000        2,000
qwen-plus     131,072      101,072
glm-*         128,000       98,000
```

触发条件：`finalMsg.usage.input_tokens ≥ threshold`（每轮 API 返回实际消耗的 token 数，包含 system prompt + 全部历史）

失败处理：compact 失败非致命 — 记录警告日志，session 继续，下轮再次检测。

---

### 0.5 摘要章节详解

```
┌─────────────────────────────────────────────────────────────────┐
│  Meta-Agent Compact 摘要（10章节）                               │
│  文件：src/core/compact/compactPrompt.ts                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Primary Request and Intent                                  │
│     用户所有明确工程请求，逐条列出                                │
│                                                                 │
│  2. Key Technical Concepts                                      │
│     工程概念、DOE策略、仿真工具、领域常数                         │
│                                                                 │
│  3. Campaign State  ★ 替换 CC 的 "Files and Code Sections"      │
│     无活跃 campaign 时略去此章节                                  │
│     ├── Campaign ID / 项目名 / 当前 phase                        │
│     ├── 进入当前 phase 的时间和决策依据                           │
│     │   （含数值证据，如 "L0 Pareto HV=0.73 < 0.85 → 批准L1"）  │
│     ├── 当前 Pareto 前沿摘要（非支配解数量 + 关键设计点坐标）      │
│     └── 下一步意图                                               │
│                                                                 │
│  4. Computations and Results  ★ 新增                            │
│     保留本 session 每一条 provenance ID（不可遗漏、不可合并）     │
│     格式：[prov-xxx] tool_name(key=val,...) → ✓/⚠/✗ L0/L1/L2   │
│     作用：compact 后模型仍可用 get_provenance(id) 查原始结果     │
│                                                                 │
│  5. V&V Events  ★ 替换/扩展 CC 的 "Errors and fixes"           │
│     ├── PRE-CALL ABORTs：[prov-xxx] tool_name — 触发hook / 修复  │
│     ├── POST-CALL ABORTs：[prov-xxx] tool_name — 输出问题 / 替代 │
│     └── WARNINGs：[prov-xxx] tool_name — 低置信度原因            │
│                                                                 │
│  6. Problem Solving                                             │
│     工程问题和持续故障排查                                        │
│                                                                 │
│  7. All user messages                                           │
│     所有用户消息逐条列出（防意图漂移的核心）                       │
│                                                                 │
│  8. Pending Tasks                                               │
│     明确待办的用户请求                                            │
│                                                                 │
│  9. Current Work                                                │
│     compact 前正在做的事，含最近一次工具调用和结果                  │
│                                                                 │
│  10. Optional Next Step                                         │
│      ← 最重要的防漂移措施                                        │
│      必须 verbatim 引用最近对话原文                               │
│      campaign 工作：注明当前 phase + 最后引用的 prov-xxx          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### 0.6 KernelBridge 的 `## Compact Instructions` 机制

CC compact prompt 原文包含：
> "There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary."

这意味着只要在 system prompt 里放 `## Compact Instructions` block，CC 的 compact 就会自动遵循，**不需要修改任何 CC 内部代码**。

`buildCompactInstructions()` 每次 submit 时动态生成，包含：
- 静态规则：要求保留所有 provenance ID、Campaign State、V&V Events
- 动态快照：当前 session 所有 `[prov-xxx] tool_name → ✓/⚠` 列表（live）
- 动态快照：当前活跃 campaign 的 phase 名称（live）

动态快照在 compact 时给摘要模型提供了"答案清单"，大幅降低遗漏 ID 的概率。

---

### 0.7 文件索引

| 文件 | 职责 |
|------|------|
| `src/core/compact/compactPrompt.ts` | 10章节 compact prompt、`formatCompactSummary()`、`buildCompactInstructions()` |
| `src/core/compact/autoCompact.ts` | `shouldCompact()`、`runCompact()`、上下文窗口阈值表 |
| `src/core/MetaAgentSession.ts` | agentic loop 内的 compact 触发检测和执行 |
| `src/cc-kernel/KernelBridge.ts` | `_buildEnrichedSuffix()` 注入 compact instructions |

---

┌─────────────────────────────────────────────────────────────┐
│  MEMORY 系统（src/memdir/memdir.ts）                         │
│                                                             │
│  - MEMORY.md（项目级记忆，最大 200 行 / 25KB）              │
│  - ~/.claude/memory/（全局记忆目录）                        │
│  - Auto Memory（运行时自动写入）                            │
│  - 分类：user_preference / project_fact / tool_shortcut…   │
│  - 读取时机：每次 session 开始，注入 dynamic zone           │
│  - 写入规范：WHEN_TO_ACCESS / WHAT_NOT_TO_SAVE 章节         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  SUB-AGENT 系统（src/tools/AgentTool/）                      │
│                                                             │
│  内置 agent 各有独立 system prompt：                         │
│  - general-purpose：通用研究型                              │
│    "Complete the task fully. Respond with a concise        │
│     report covering what was done and key findings."       │
│  - explore：只读探索型（CRITICAL: READ-ONLY MODE）          │
│  - plan：规划型（ExitPlanMode 专用工具）                    │
│  - verification：对抗性验证型                               │
│  - claude-code-guide：文档查询型                            │
│                                                             │
│  + DEFAULT_AGENT_PROMPT：子 agent 通用基础 prompt           │
│  + enhanceSystemPromptWithEnvDetails()：为子 agent          │
│    追加环境信息（CWD、绝对路径规范、no emoji）               │
│  + getAgentToolSection()：告知主 agent 何时派发子 agent      │
└─────────────────────────────────────────────────────────────┘
```

---

### 1.2 Meta-Agent 现有 Prompt 结构

```
┌─────────────────────────────────────────────────────────────┐
│  基础 System Prompt（src/core/config.ts）                    │
│                                                             │
│  DEFAULT_SYSTEM_PROMPT（8行，单一文本块）：                  │
│  "You are an expert engineering assistant..."               │
│  - Always include units with every numerical result         │
│  - State your assumptions explicitly                        │
│  - Flag results outside typical ranges                      │
│  - If you use a simplifying assumption, note its impact    │
│  - When uncertain, say so and suggest verification          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  动态注入（MetaAgentSession.submit()，每次 submit 执行）      │
│                                                             │
│  A. config.systemPrompt + appendSystemPrompt（基础拼接）    │
│  B. MetaAgentContextStore.buildInjectionBlock()             │
│     → "## Active Engineering Campaigns"                     │
│     → 每个 campaign 的 contextBlock（capsule 预计算）        │
│  C. _buildProvencePreamble()（仅有 runtimeContext 时）       │
│     → "## Recent Computations (this session)"               │
│     → 最近 3 条计算记录（ID + 工具名 + 时间 + V&V 状态）    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  ModeDetector LLM Prompt（src/routing/ModeDetector.ts）     │
│                                                             │
│  模型：claude-haiku-4-5-20251001，max_tokens: 5            │
│  用途：将用户首条消息分类为 direct / agentic / campaign      │
│  格式：单轮分类，无 few-shot examples                       │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Tool Descriptions（tools/provenance/*/prompt.md）          │
│                                                             │
│  5 个工具，description 从 .md 文件加载：                    │
│  - get_provenance / list_recent_results                     │
│  - find_duplicate_computation / get_computation_lineage     │
│  - echo（测试工具）                                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Tool Result 格式（src/runtime/instrumentTool.ts）           │
│                                                             │
│  正常：{output}\n\n[provenance: prov-xxx]                   │
│  V&V abort：[V&V PRE-CALL ABORT] Tool "x" was blocked...   │
│  V&V warning：[V&V WARNING]\n• [hook] message\n\n{output}  │
└─────────────────────────────────────────────────────────────┘
```

---

### 1.3 差距对比表

| 维度 | Claude Code | Meta-Agent 现状 | 差距 |
|------|------------|----------------|------|
| **System prompt 结构** | 7个静态章节 + 9个动态 section | 单块文本 8 行 | ❌ 无结构、无行为规范 |
| **身份定义** | 明确角色 + 能力边界 + 领域 | "expert engineering assistant"（过于泛） | ❌ 缺乏工程领域专项知识 |
| **Tool-use 规范** | 详细（何时用/不用、并行原则） | 无 | ❌ 模型自行决策，不可控 |
| **行动风险规范** | 可逆性判断、哪些要先确认 | 无 | ❌ 对高风险操作无约束 |
| **输出格式规范** | 简洁、lead with answer、无冒号 | 无 | ❌ 格式无约束 |
| **Memory 系统** | MEMORY.md + 自动记忆 + 分类 | 无 | ❌ 跨 session 无记忆 |
| **Context 压缩** | 9章节结构化摘要 + 防漂移引用 | 无（KernelBridge 用 CC auto-compact） | ⚠️ MetaAgentSession 路径无压缩 |
| **Prompt cache 分层** | global / user 两层，boundary marker | 无 | ❌ 每次 session 重算全部 |
| **Sub-agent prompt** | 每种 agent 有专属角色 + 约束 | Worker 无独立 system prompt | ❌ Worker 行为不可控 |
| **环境信息注入** | CWD、git、平台、模型、cutoff | 无 | ❌ 模型不知道运行上下文 |
| **Campaign 知识** | N/A（非工程用途） | 在注入块里有，但主 prompt 无 | ⚠️ 主 prompt 不知道 DOE 是什么 |
| **Provenance 知识** | N/A | preamble 格式过于简略 | ⚠️ 模型不知道何时该查 |
| **V&V 失败处理** | N/A | 错误消息无恢复指导 | ❌ 模型收到 abort 后不知如何响应 |
| **ModeDetector prompt** | N/A | 存在但缺 few-shot | ⚠️ 边界案例分类不稳定 |
| **Tool description 质量** | 每个工具有完整 when-to-use | 4个 provenance 工具描述可改进 | ⚠️ 缺 when-NOT-to-use |

---

## 2. Prompt Engineering 改进计划

按优先级分为 P0（影响正确性）、P1（影响质量）、P2（影响效率）。

---

### P0 — 正确性问题（必须修复）

#### P0-A：Tool Description 与实现不匹配（find_duplicate）

**文件：** `src/tools/provenance/find_duplicate/prompt.md`

**问题：** description 说"Given a tool name and input parameters"，但 inputSchema 没有这两个字段，实际实现哈希的是整个 `input` 对象。描述让模型带错误的参数调用工具。

**修复：** 重写 description，准确描述 inputSchema 实际接受的字段（tool_name + input_json）。

---

#### P0-B：V&V abort 消息缺乏恢复指导

**文件：** `src/runtime/instrumentTool.ts`

**问题：** `[V&V PRE-CALL ABORT]` 只说"was blocked"，模型收到后不知道该修正输入、换工具还是告知用户，容易进入重试死循环。

**修复：** 在 abort 消息末尾追加标准化的 NEXT_STEPS 提示，告知模型可选的恢复路径：修正输入参数 / 查询 get_provenance 获取之前结果 / 向用户说明约束。

---

### P1 — 质量问题（显著影响行为）

#### P1-A：重写基础 System Prompt（最高影响）

**文件：** `src/core/config.ts` — `DEFAULT_SYSTEM_PROMPT`

**问题：** 现有 8 行内容对工程 AI 来说太薄。模型不知道：
- 自己有 provenance 系统，可以查历史计算
- 存在 DOE / campaign 概念
- V&V 结果的含义和响应方式
- 何时用 direct 回答 vs 调用工具
- 工程计算的精度、单位、溯源要求

**修复：** 按 CC 的章节结构重写，包含：
1. 身份定义（工程 AI + DOE 领域 + 多 fidelity 体系知识）
2. 工具使用规范（何时查 provenance / 何时用 find_duplicate）
3. V&V 响应规范（warning vs abort 的不同处理）
4. 计算规范（单位、假设、精度、溯源）
5. Campaign 知识（什么是 PARETO_READY、什么是 escalation）
6. 输出规范（工程报告格式 vs 对话格式）

---

#### P1-B：ModeDetector Prompt 增加 few-shot examples

**文件：** `src/routing/ModeDetector.ts` — `LLM_SYSTEM_PROMPT`

**问题：** 三个模式的边界定义是文字描述，无具体 examples。"agentic"用排除法定义，导致边界模糊案例（"帮我算一下这个参数"）倾向误判。

**修复：**
- 为每个模式增加 3 个典型 examples（正/负各一组）
- 明确 agentic 的正向特征（不只是"非 campaign"）
- 加入"不确定时默认 agentic"的兜底规则

---

#### P1-C：Campaign Context 注入优化

**文件：** `src/coordination/MetaAgentContextStore.ts` — `buildInjectionBlock()`  
**文件：** `src/coordination/CapsuleBuilder.ts` — `callToAction()`

**问题：**
- 多个 campaign 时无 token 预算控制，可能注入几千 token
- callToAction 文本是"用户友好"语气，不是面向 agent 的操作指令
- 注入块 header `## Active Engineering Campaigns` 对模型的指示不清晰

**修复：**
- 增加 token 预算上限（例如总 campaign context ≤ 800 token），超出时按活跃度截断
- 将 callToAction 改为面向 agent 的操作指令格式（NEXT_ACTION: / AWAITING_INPUT: 前缀）
- 在 header 后加一行说明 agent 应如何响应 campaign context

---

#### P1-D：Provenance Preamble 格式改进

**文件：** `src/core/MetaAgentSession.ts` — `_buildProvencePreamble()`

**问题：** 现有格式只有一行：`• [prov-id] timestamp — toolName (L0) ✓`，模型看不到输入参数和输出摘要，无法判断是否需要查详情。导致模型要么过度调用 get_provenance，要么忽略提示。

**修复：** 每条记录增加 1 行 input 摘要（关键参数，≤ 60 chars），让模型可以判断相关性后再决定是否查询。

---

#### P1-E：Worker 系统增加独立 System Prompt

**文件：** `src/coordination/WorkerCoordinator.ts`

**问题：** DOE Worker 在执行评估任务时没有专用 system prompt，完全依赖调用方注入的 context。Worker 是长任务执行者，需要：
- 明确的任务完成标准
- 结果格式规范（submit_evaluation_results 的格式要求）
- 错误处理规范（何时 failTask vs 重试）

**修复：** 为 WorkerCoordinator 设计专用的 worker system prompt，注入到 worker session 中。

---

### P2 — 效率问题（优化 token 消耗和缓存）

#### P2-A：Prompt Cache 分层（参考 CC 的 static/dynamic boundary）

**文件：** `src/core/config.ts`、`src/core/MetaAgentSession.ts`

**问题：** 现在每次 submit 都重新构建完整 system prompt（A+B+C 三段全部重算），没有区分静态内容（可 cache）和动态内容（需更新）。

**修复：**
- 将 system prompt 拆分为静态前缀（基础 prompt + 工程规范，使用 `cache_control: ephemeral`）和动态后缀（campaign context + preamble）
- 静态前缀在 session 内只计算一次 cache creation token，后续复用
- 预期节省：每轮 API 调用减少 300-500 input tokens

---

#### P2-B：Section Registry Pattern（参考 CC 的 systemPromptSection）

**文件：** `src/core/MetaAgentSession.ts`

**问题：** B 路径（campaign context）和 C 路径（preamble）每次 submit 都执行磁盘读取，即使没有变化。

**修复：** 实现类似 CC 的 `systemPromptSection(name, compute, cacheBreak)` 机制：
- campaign context：TTL 缓存（已有 2s TTL，但 `buildInjectionBlock` 没利用）
- preamble：仅在有新的 provenance record 时重算（对比上次记录数）

---

#### P2-C：KernelBridge 与 MetaAgentSession 注入路径对齐

**文件：** `src/cc-kernel/KernelBridge.ts`

**问题：** KernelBridge 有 `_buildCampaignContext()` 但没有 preamble（C路径）。两个 backend 的实际 context 内容不一致，campaign 模式缺少 provenance 历史。

**修复：** 将 B+C 注入逻辑提取为独立函数 `buildDynamicContext()`，两个 backend 统一调用。

---

## 3. 实施顺序建议

```
Sprint 1（P0，1-2天）
  P0-A  fix_duplicate_tool_description
  P0-B  vv_abort_recovery_guidance

Sprint 2（P1 核心，3-5天）
  P1-A  rewrite_default_system_prompt       ← 最高影响，先做
  P1-B  modedetector_few_shot_examples
  P1-D  provenance_preamble_format

Sprint 3（P1 扩展，3-4天）
  P1-C  campaign_context_token_budget
  P1-E  worker_system_prompt

Sprint 4（P2 优化，2-3天）
  P2-A  prompt_cache_layering
  P2-B  section_registry_pattern
  P2-C  kernelbridge_preamble_alignment
```

---

## 4. Meta-Agent 静态/动态 System Prompt 工程设计（Sprint 2+ 实施目标）

借鉴 CC 的分层缓存架构，结合 campaign/provenance 特性设计。

---

### 4.1 完整 Section 映射

```
┌─────────────────────────────────────────────────────────────────┐
│  STATIC ZONE（cache_control: ephemeral, scope: 'global'）        │
│  内容不随 session 变化，跨 session 完全可缓存                     │
│                                                                 │
│  S1. identity_definition（身份定义）                             │
│      "You are Meta-Agent, an expert AI for engineering          │
│       simulation workflows using Design of Experiments (DOE)." │
│      - 领域：电化学/热管理/流体等工程仿真                         │
│      - 能力：DOE 采样、多保真度工具调用、V&V、溯源管理            │
│                                                                 │
│  S2. system_rules（系统规则）                                    │
│      - 工具调用权限模型（何种工具可以在无确认的情况下调用）         │
│      - 溯源 ID 格式（prov-xxx），所有工具调用产生 ID              │
│      - session_id / agent_id 的含义与使用规范                    │
│                                                                 │
│  S3. task_execution_rules（任务执行规范）                        │
│      - 调用工具前先 find_duplicate_computation 检查重复           │
│      - 工程假设必须显式声明                                       │
│      - 结果超出典型范围时必须 flag                               │
│      - 完成前验证：确认输出的 V&V 状态                           │
│                                                                 │
│  S4. provenance_protocol（溯源系统使用规范）★ meta-agent 专属    │
│      - 何时调 find_duplicate（所有高开销工具调用前）              │
│      - 何时调 get_provenance（需要查原始输出时）                  │
│      - 何时调 list_recent_results（概览本 session 计算历史时）    │
│      - 何时调 get_computation_lineage（追溯参数影响链时）         │
│      - provenanceId 的引用格式                                   │
│                                                                 │
│  S5. vv_response_protocol（V&V 响应规范）★ meta-agent 专属      │
│      - PRE-CALL ABORT → 工具未执行；修正输入后可重试             │
│      - POST-CALL ABORT → 工具已执行；查 provenance 看原始输出    │
│                         → 不要同输入重试，换思路或 escalate      │
│      - WARNING → 工具成功；结果低置信度，考虑独立验证            │
│                                                                 │
│  S6. doe_campaign_knowledge（DOE/Campaign 领域知识）★            │
│      - Campaign 生命周期：IDLE→SAMPLING→EVALUATING→PARETO→…     │
│      - L0/L1/L2 escalation 触发条件（Pareto 未改善时升级精度）   │
│      - Pareto 前沿含义：多目标优化的非支配解集                   │
│      - fidelity_level 含义（0=analytical, 1=surrogate, 2=HF）   │
│                                                                 │
│  S7. engineering_calculation_standards（工程计算规范）★          │
│      - 所有数值结果必须带单位                                     │
│      - 不确定度来源必须说明                                       │
│      - 量纲一致性检查规范                                         │
│      - 数值精度约定（有效位数、scientific notation 使用场景）     │
│                                                                 │
│  S8. action_risk_rules（行动风险规范）                           │
│      - 哪些 campaign 操作是不可逆的（DONE 终态无法回退）          │
│      - 跨 session 写磁盘的工具需要用户确认                        │
│      - escalate 决策前需要呈现 Pareto 证据                       │
│                                                                 │
│  S9. tool_use_rules（工具使用规范）                              │
│      - 无依赖工具可并行调用                                       │
│      - 有 provenanceId 的历史结果优先复用                        │
│      - 工具错误后的重试策略（修正参数 vs 换工具 vs 报告）         │
│                                                                 │
│  S10. style_rules（风格规范）                                    │
│       - 对话结果：简洁、直接、Lead with answer                   │
│       - 工程报告：标准章节结构（假设→方法→结果→结论）             │
│       - 数值表格：对齐、单位在表头                               │
│                                                                 │
│  ═══════════ SYSTEM_PROMPT_DYNAMIC_BOUNDARY ═══════════         │
│                                                                 │
│  DYNAMIC ZONE — 公共基础（所有模式都加载）                       │
│                                                                 │
│  D1. memory（memoized，session 内不变）                          │
│      → engineering_memory.md 中保存的工程经验                    │
│      → 参数范围记忆、失败工具配置记录                            │
│                                                                 │
│  D2. env_info（memoized，session 内不变）                        │
│      → 当前 session_id、可用工具列表                             │
│      → session 开始时间戳                                        │
│                                                                 │
│  D3. language（memoized，session 内不变）                        │
│      → 用户语言偏好，中文 or 英文 or 技术混合                    │
│                                                                 │
│  D4. current_mode（memoized，session 内不变）                    │
│      → 单行："Current mode: CAMPAIGN / AGENTIC / DIRECT"        │
│      → 轻量，让模型知晓自身所处模式                              │
│                                                                 │
│  D5. mcp_instructions（memoized，MCP 连接变化时失效）            │
│      → 已连接 MCP 工具的使用说明                                 │
│                                                                 │
│  D6. output_style（memoized，用户偏好变化时失效）                │
│      → 工程报告详略程度（summary / detailed / raw_numbers）      │
│                                                                 │
│  D7. summarize_tool_results（memoized，永不重算）                │
│      → 提示模型在工作中记录关键数值                              │
│      → 避免工具结果滚出 context 后丢失                           │
│                                                                 │
│  ── Campaign Assembly（仅 CAMPAIGN 模式追加）────────────────    │
│     无活跃 campaign 时各 section 返回空串，不破坏 cache           │
│                                                                 │
│  D8. campaign_context（DANGEROUS_uncached，每轮重算）★           │
│      → 当前活跃 campaign 的 phase + 进度（采样数/总数）           │
│      → 最新 Pareto 前沿摘要（≤ 200 chars）                       │
│      → 当前 NEXT_ACTION / AWAITING_INPUT 指令                   │
│      → 正式化现有 B-path（MetaAgentContextStore.buildInjectionBlock） │
│                                                                 │
│  D9. session_provenance（memoized，新 record 写入时失效）★       │
│      → 本 session 最近 N 条计算记录（ID + 工具 + 关键参数摘要）   │
│      → record 数量变化时清除缓存（对比上次 count）               │
│      → 正式化现有 C-path（_buildProvencePreamble）               │
│                                                                 │
│  D10. phase_guidance（DANGEROUS_uncached，随 D8 一起重算）★      │
│       → 基于当前 campaign phase 的具体操作指令                   │
│       → SAMPLING: 聚焦仿真工具调用                               │
│       → PARETO_READY: 审阅 Pareto 前沿，决定是否 escalate        │
│       → REPORTING: 整理工程报告                                  │
│       → 无活跃 campaign 时返回空串                               │
└─────────────────────────────────────────────────────────────────┘
```

---

### 4.2 与用户初始方案的差异说明

| 用户方案 | 调整 | 原因 |
|---------|------|------|
| `scratchpad` | **删除** | meta-agent 的中间状态通过 provenance 持久化，不需要额外 scratchpad |
| `frc`（失败结果缓存） | **合并进 session_provenance (D9)** | 失败工具调用已有 provenance ID，find_duplicate 可查询，无需独立 section |
| `session_guidance` | **简化为 current_mode(D4) + phase_guidance(D10)** | 模式切换用单行 current_mode（轻量），phase_guidance 归入 Campaign Assembly 块 |
| 静态区 7 sections | **扩展为 10 sections** | 额外 3 个 meta-agent 专属：provenance_protocol、vv_response_protocol、doe_campaign_knowledge |
| 动态区无 campaign 专属 | **Campaign Assembly 块（D8-D10），仅 CAMPAIGN 模式追加** | 模式分层装配：DIRECT/AGENTIC 不加载 campaign 相关内容，干净无冗余 |

---

### 4.3 Volatility 分类汇总

| Section | 类型 | 失效触发 |
|---------|------|---------|
| S1–S10 | 永久静态 | 永不重算（代码更新时重部署） |
| D1 memory | memoized | memory 文件更新时 |
| D2 env_info | memoized | session 开始时计算一次 |
| D3 language | memoized | 用户显式切换语言时 |
| D4 current_mode | memoized | session 开始时计算一次（submit 时传入） |
| D5 mcp_instructions | memoized | MCP 连接/断开时 |
| D6 output_style | memoized | 用户偏好变化时 |
| D7 summarize_tool_results | memoized | 永不重算 |
| **D8 campaign_context** | **DANGEROUS_uncached** | **每轮重算（仅 CAMPAIGN 模式）** |
| D9 session_provenance | memoized | provenance record 数量变化时 |
| **D10 phase_guidance** | **DANGEROUS_uncached** | **随 D8 一起重算（仅 CAMPAIGN 模式）** |

**注：** D8 和 D10 仅在 CAMPAIGN 模式下装载；无活跃 campaign 时返回空串，不破坏 cache。DIRECT/AGENTIC 模式完全不加载 Campaign Assembly 块。

---

### 4.4 实施步骤（Sprint 2 补充）

```
Phase 1：基础设施（P2-B Section Registry）
  - 实现 systemPromptSection(name, compute) 
  - 实现 DANGEROUS_uncachedSystemPromptSection(name, compute, reason)
  - 实现 resolveSystemPromptSections(sections) 带缓存机制

Phase 2：静态区重写（P1-A）
  - src/core/prompts.ts：实现 S1–S10 的 getter 函数
  - 将 DEFAULT_SYSTEM_PROMPT 替换为 buildStaticSystemPrompt()

Phase 3：动态区迁移
  - 将 B-path 迁移为 D6 campaign_context（DANGEROUS_uncached）
  - 将 C-path 迁移为 D7 session_provenance（memoized + record-count 失效）
  - 新增 D8 phase_guidance（DANGEROUS_uncached）

Phase 4：KernelBridge 对齐（P2-C）
  - 提取 buildDynamicContext() 供两个 backend 统一调用
```

---

## 5. Meta-Agent Memory 系统

### 5.1 设计目标

Meta-agent memory 完全采用 Claude Code 的双层文件结构，并针对工程场景做了两处扩展：
增加 `campaign_lessons` 记忆类型、引入三条硬边界防止与 provenance / campaign context 系统的数据污染。

### 5.2 存储结构

```
~/.claude/meta-agent/memory/          ← 全局目录（跨项目共享）
  MEMORY.md                           ← 索引文件，每条 session 必注入
  user_role.md                        ← 用户背景 (type: user)
  feedback_escalation.md              ← 工作方式 (type: feedback)
  ss316_thermal_conductivity.md       ← 物理常数 (type: domain_knowledge)
  battery_l0_threshold_lesson.md      ← Campaign 经验 (type: campaign_lessons)
  internal_material_db.md             ← 外部系统指针 (type: reference)
```

**全局而非 per-project（与 CC 的关键差异）：**
CC 使用 `~/.claude/projects/<git-root>/memory/` 做项目隔离，因为 `project` 类记忆高度项目专属。
Meta-agent 的 `domain_knowledge`（物理常数）和 `campaign_lessons`（优化策略）跨项目有效，
全局路径让同一用户的不同工程项目可以互相借鉴经验。

### 5.3 记忆类型（5 类 vs CC 的 4 类）

| 类型 | 继承 | 说明 |
|---|---|---|
| `user` | CC user | 用户角色、专业、沟通偏好 —— 完全对齐 |
| `feedback` | CC feedback | 纠正 + 确认，两类都记，含 **Why** + **How to apply** |
| `domain_knowledge` | CC reference（扩展）| 物理常数、材料属性、工程标准；**必须**带 source + date |
| `campaign_lessons` | **新增** | 从已完成 campaign 提炼的可迁移经验（见 §5.5）|
| `reference` | CC reference（收窄）| 外部系统指针：工具 API、数据库 URL |

**CC 的 `project` 类型在 meta-agent 中被拆分掉了：**
- 当前 campaign 的活跃状态 → D8 `campaign_context`（实时注入，非 memory）
- 已完成 campaign 的经验 → `campaign_lessons` 类型（可迁移，持久化）

### 5.4 Frontmatter 格式

```markdown
---
name: Li-ion battery L0→L1 escalation threshold
description: L0 hypervolume threshold for triggering L1 escalation in battery thermal campaigns
type: campaign_lessons
date: 2026-04-15
campaign: camp-abc123
---

**Lesson:** For Li-ion battery thermal problems, use hypervolume ≥ 0.85 for L0→L1 escalation.

**Evidence:** camp-abc123 — threshold 0.73 triggered premature escalation;
L1 Pareto front differed by 22% from L0 prediction.

**How to apply:** Use 0.85 for any battery-thermal campaign.
Caution: may not transfer to solid-state electrolyte chemistries.
```

```markdown
---
name: SS316 thermal conductivity
description: Stainless steel 316 thermal conductivity at 20°C for thermal simulations
type: domain_knowledge
date: 2025-09-01
source: Supplier data sheet rev 3.2, ASTM A240
---

**Fact:** SS316 thermal conductivity = 16.3 W/(m·K) at 20°C.

**Source:** Supplier DS rev 3.2 (2025-09); ASTM A240.

**How to apply:** Valid 20–200°C. Drops ~8% at 500°C — use temperature-dependent table for high-T runs.
```

### 5.5 campaign_lessons — 新类型详解

`campaign_lessons` 是 meta-agent memory 最核心的扩展，在 CC 中无对应类型。

**写入时机：** campaign 进入 `REPORTING` 阶段完成后，模型主动提炼本次 campaign 中可迁移的经验。
不是"这次跑了什么"（那是 provenance 的职责），而是"这类问题下次该怎么做"。

**典型内容：**
- L0 代理模型在特定物理域的偏差规律（方向 + 量级）
- L0→L1 超体积阈值的校准值
- 用户对采样策略的偏好（LHC 点数、是否批准自动升级）
- Pareto front 收敛的典型迭代次数

**不写的内容：**
- 当前 campaign 的具体设计点（→ provenance）
- 当前 Pareto front 数值（→ D8 campaign_context）
- 项目特定的设计变量边界（→ campaign 配置文件）

### 5.6 三条硬边界

工程场景特有的数据系统边界，在 CC 中不存在：

```
┌─────────────────────────────────────────────────────────────────┐
│  禁止写入 memory 的内容          正确的系统               原因   │
├─────────────────────────────────────────────────────────────────┤
│  仿真计算结果（特定输入→输出）    ProvenanceTracker        可溯源 │
│  当前 campaign 活跃状态          D8 campaign_context      实时性 │
│  项目专属参数（设计边界/目标）    Campaign 配置文件        权威性 │
└─────────────────────────────────────────────────────────────────┘
```

违反边界的后果：memory 里的过期数值会通过 provenance 链传播，污染整个 Pareto front。

### 5.7 System Prompt 注入架构

D1 拆成两个 section（CC 是单 section，meta-agent 因分离关注点而拆分）：

```
D1a  memory_guidance   [systemPromptSection — memoized]
     ├─ 5 类 taxonomy（含示例）
     ├─ 三条硬边界
     ├─ 写入协议（两步：topic 文件 + MEMORY.md 索引）
     ├─ 访问时机
     └─ 工程 drift caveat

D1b  memory_content    [DANGEROUS_uncachedSystemPromptSection]
     ├─ MEMORY.md 内容（截断至 200 行 / 25 KB）
     └─ 按 query 召回的 topic 文件（≤5 个）
```

D1a memoized 原因：taxonomy 和写入协议是静态文本，不因 session 变化，可利用 prompt cache。
D1b uncached 原因：①模型可能在本 turn 写入新 topic 文件；②不同 query 召回不同文件。

### 5.8 按 Query 相关性过滤

```
每次 submit(prompt) 时：

1. scanTopicFiles()     读取所有 *.md 的 frontmatter（name, description, type）
2. 分区
   ├─ always-relevant:  user + feedback → 每次全量加载
   └─ candidates:       domain_knowledge + campaign_lessons + reference → 按 query 过滤
3. 过滤（优先 Haiku，降级 keyword match）
   ├─ client 存在：Haiku side-call → JSON 返回 filename 列表（≤5）
   └─ fallback：tokenize(query) 对 name+description 做 keyword score，取 top-5
4. loadMemoryContent()  读取选中文件内容，内联注入 D1b
```

**与 CC 的差异：** CC 将 topic 文件注入为 user turn attachment（每轮 API call 前追加到 user 消息）；
meta-agent 将其内联到 system prompt（D1b）。原因是 MetaAgentSession 没有 user attachment 机制，
且 system prompt 注入更稳定（不受 compact 影响）。

### 5.9 文件索引

| 文件 | 职责 |
|---|---|
| `src/core/memory/paths.ts` | 全局路径常量、`getMemoryEntrypoint()` |
| `src/core/memory/types.ts` | 5 类 taxonomy、frontmatter 格式、所有 prompt text block |
| `src/core/memory/memdir.ts` | 截断（200 行/25KB）、`ensureMemoryDirExists()`、`loadMemoryIndex()`、`buildMemoryGuidanceLines()` |
| `src/core/memory/findRelevantMemories.ts` | frontmatter 解析、topic 文件扫描、Haiku side-call / keyword match |
| `src/core/memory/index.ts` | 公开导出 |
| `src/core/dynamicPrompt.ts` D1a/D1b | `buildMemoryGuidanceSection()` + `buildMemoryContentSection()` |

### 5.10 Meta-Agent Memory vs CC Memory 完整对比

| 维度 | Claude Code | Meta-Agent |
|---|---|---|
| **存储路径** | `~/.claude/projects/<git-root>/memory/` （per-project） | `~/.claude/meta-agent/memory/` （全局跨项目）|
| **索引文件** | `MEMORY.md`，200 行 / 25 KB cap | 同上 |
| **类型数量** | 4（user / feedback / project / reference）| 5（+`campaign_lessons`，去掉 `project`）|
| **project 类型** | 有（项目进行中的决定）| 无；活跃状态 → D8；完成经验 → `campaign_lessons` |
| **domain_knowledge** | 无（reference 含部分）| 独立类型，强制 source + date |
| **campaign_lessons** | 无 | 新增：已完成 campaign 的可迁移经验 |
| **写入协议** | 两步（topic 文件 + MEMORY.md 索引）| 同上 |
| **per-query 过滤** | Sonnet side-call（`sideQuery`）| Haiku side-call（更轻量）+ keyword match fallback |
| **注入位置** | MEMORY.md → system prompt；topic 文件 → user attachment | 全部 → system prompt（D1a/D1b）|
| **缓存策略** | 单 `systemPromptSection`（memoized）| D1a memoized + D1b DANGEROUS_uncached（按 query）|
| **截断** | 200 行 / 25 KB + 警告 | 同上 |
| **Drift caveat** | 推荐前验证文件/函数是否存在 | 更强：数值必须标注"来源待验证"，误用会污染 provenance |
| **硬边界** | 无（项目记忆类型模糊）| 三条硬边界：仿真结果/活跃状态/项目参数各有专属系统 |
| **Team memory** | 有（`memory/team/` 子目录）| 暂无（单用户工程场景）|
| **Background extract** | 有（`EXTRACT_MEMORIES` feature-gated）| 暂无 |

---

## 7. 远期架构扩展：DAG Campaign 编排 + JobManager 守护进程

本节记录两个**已在架构层面预留扩展点、但当前版本暂不实现**的方向。  
写在此处是为了让未来的实现者明白"哪里留了缝"，以及为什么这样设计。

---

### 7.1 DAG Campaign 编排（扩展性预留）

#### 7.1.1 当前状态（线性 Phase 链）

当前 `CampaignStateStore` 把一个 Campaign 的进度建模为**单条线性 Phase 链**：

```
DOE_PLANNING → RUNNING_L0 → PARETO_READY_L0 → RUNNING_L1 → PARETO_READY_L1 → REPORTING
```

每个 Phase 有一个 `parentPhaseId`，`phase_transitions` 表记录转换原因和时间戳。  
这个模型对当前"单目标 → 逐步精细化"的 DOE 工作流已经足够。

#### 7.1.2 问题场景（触发 DAG 需求）

随着工程复杂度增加，以下场景在线性模型下无法优雅表达：

| 场景 | 问题 |
|------|------|
| 多保真度并行分支（L0 Pareto 的两个子区域同时用 L1 精细化）| 两个 RUNNING_L1 同时存在，parentPhaseId 无法区分 |
| 参数空间分割（材料 A / 材料 B 两条 DOE 支线独立运行，最后合并 Pareto）| 需要一个"合并节点"概念 |
| 探索 + 开发并行（全局搜索线程 + 局部精细化线程共存）| 单条链天然序列化，无法表达 |
| 中途插入人工实验节点（实验室实测打断自动化 DOE，结果回注）| 线性链的插入位置不明确 |

#### 7.1.3 DAG 扩展方案（预留设计）

**核心数据结构变化**（仅需改 `CampaignStateStore`，不影响 Agent 接口）：

```typescript
// 当前（线性）
interface Phase {
  id: string
  name: string
  parentPhaseId: string | null  // 单父节点
  status: PhaseStatus
}

// 扩展后（DAG）
interface PhaseNode {
  id: string
  name: string
  parentPhaseIds: string[]       // 多父节点（合并节点的情况）
  childPhaseIds: string[]        // 多子节点（分叉的情况）
  status: PhaseStatus
  mergeStrategy?: 'union' | 'intersection' | 'weighted'  // 合并 Pareto 前沿时的策略
}
```

**扩展点（已在代码中预留）**：

`CampaignStateStore` 的 `phase_transitions` 表已经记录了完整的 `fromPhase` / `toPhase` 对，天然是一张有向图的边表。升级时只需：

1. 将 `parentPhaseId: string | null` 改为 `parentPhaseIds: string[]`，并加 DB migration
2. `CampaignContextBuilder.buildInjectionBlock()` 改为 DFS/BFS 遍历活跃叶节点（当前只取 `activeCampaigns[0]`）
3. D8 section（`campaign_context`）的摘要改为多分支摘要格式

**何时升级**：当出现同一 Campaign 下需要同时运行两个独立 Phase 的真实需求时。  
当前单测试验证"单活跃分支"场景已足够覆盖现有工作流。

#### 7.1.4 Agent 接口稳定性

DAG 改造**不会破坏任何 Agent 接口**：
- `ProvenanceTracker.record()` 的参数不变（provenance 挂在 Phase 上，Phase 是节点 ID）
- `MetaAgentContextStore.read()` 返回的 `activeCampaigns` 语义从"线性链的当前节点"变为"DAG 的所有活跃叶节点"
- 工具的 `ToolCallContext` 完全不变

---

### 7.2 JobManager 守护进程化（远期方向）

#### 7.2.1 当前状态（进程内 TypeScript 对象）

`JobManager` 目前是一个**纯进程内 TypeScript 对象**，与 `MetaAgentSession` / `KernelBridge` 运行在同一个 Node.js 进程里：

```
┌─────────────────────────────────────────────┐
│  Node.js 进程（主进程）                       │
│                                             │
│  KernelBridge ──→ CC QueryEngine            │
│       ↓                                     │
│  wrapMetaAgentTool → tool.call()            │
│       ↓                                     │
│  instrumentTool → ProvenanceTracker          │
│       ↓                                     │
│  JobManager.submit(job)   ← 在这里            │
│  ↓                                          │
│  子进程 / Worker Thread（运行仿真脚本）        │
└─────────────────────────────────────────────┘
```

这个模型的**当前限制**：
- 主进程崩溃/重启 → 所有进行中的 Job 状态丢失（需要从 ProvenanceTracker 重新推断）
- 无法跨多个 MetaAgentSession 实例共享 Job 队列（每个 instance 有自己的 JobManager）
- CampaignMonitor 的轮询循环 (`setInterval`) 绑在主进程的 event loop 上

#### 7.2.2 守护进程化方案（远期目标）

将 `JobManager` + `CampaignMonitor` 提取为**独立的守护进程**（daemon process），通过 IPC 与主进程通信：

```
┌──────────────────────────────────────────────────────────────┐
│  meta-agent-daemon  (独立 Node.js 进程，开机自启 or on-demand)│
│                                                              │
│  JobQueueStore (SQLite / Redis)                              │
│  CampaignMonitor (内部轮询，管理 Job 生命周期)               │
│  REST / Unix Socket API:                                     │
│    POST /jobs         → submit                               │
│    GET  /jobs/:id     → status                               │
│    POST /jobs/:id/cancel                                     │
│    GET  /campaigns/:id → phase + Pareto summary              │
└──────────────────────────────────────────────────────────────┘
          ↑ HTTP / IPC
┌─────────────────────────────┐
│  MetaAgentSession / Kernel  │
│  Bridge（主进程）            │
│  JobManager (thin client)   │
└─────────────────────────────┘
```

**接口稳定性设计**：

为了让守护进程化对上层透明，`JobManager` 的公共接口已经设计为**可以被 thin-client 替代**：

```typescript
interface IJobManager {
  submit(job: JobSpec): Promise<JobHandle>
  status(jobId: string): Promise<JobStatus>
  cancel(jobId: string): Promise<void>
  list(filter?: JobFilter): Promise<JobSummary[]>
}
```

当前 `JobManager` 实现这个接口（进程内）；未来的 `RemoteJobManager` 也实现这个接口（HTTP/IPC 客户端）。`instrumentTool` 和所有 Agent 工具代码只依赖 `IJobManager`，切换时**零代码改动**。

#### 7.2.3 何时守护进程化

触发条件（满足任意一个）：
1. 出现"Campaign 在 MetaAgentSession 断开后需要继续运行"的需求
2. 多个并发 MetaAgentSession 需要共享同一个 Job 队列（资源调度）
3. 仿真脚本运行时间超过一个 session 的生命周期（小时量级）
4. 需要 `systemctl`/`launchd` 管理的生产级别稳定性

**当前不做**的原因：增加了 IPC 序列化、进程管理、错误恢复的复杂度，在单用户本地研究场景下得不偿失。

#### 7.2.4 CampaignMonitor 的位置变化

| 阶段 | CampaignMonitor 在哪 |
|------|----------------------|
| 当前（进程内）| `new CampaignMonitor(jobManager, ctxStore).start()` — 绑在 MetaAgentSession 生命周期 |
| 守护进程后 | daemon 内部启动，与任何 session 解耦 |

进程内阶段，Monitor 的 `start()` / `stop()` 由 `MetaAgentSession.interrupt()` 驱动（session 结束 → monitor 停止）；  
守护进程阶段，Monitor 永远运行，session 只是"注册观察者"而非"拥有 Monitor"。

---

## 8. 事件驱动自主循环（Autonomous Event-Driven Loop）

> **状态：设计完成，待实施。** 本章记录完整方案，作为后续升级的直接输入。  
> 当前系统是"用户驱动的 checkpoint"模型；本章升级为"系统自驱的决策节点"模型。

---

### 8.1 现状与痛点

Campaign 在当前架构中的执行流程是被动的：

```
用户触发 campaign
  → JobManager 提交 N 个仿真 job
  → CampaignMonitor 每 5s 轮询 state.json
  → 所有 job 完成 → Monitor 刷新 Context → 通知用户
  → 等待用户下次发消息
  → 用户问"结果怎么样？"
  → LLM 读 context → 决定是否升级 fidelity
```

**关键问题**：

| 痛点 | 影响 |
|------|------|
| 轮询延迟最大 5s，长任务无影响，短任务（<10s）浪费一个轮询周期 | 小问题 |
| 用户必须回来问才能推进 campaign | 核心痛点 |
| LLM 决策能力在 job 运行期间完全闲置 | 资源浪费 |
| Monitor 完成检测后无法触发 LLM 做判断，只能刷新静态 context | 功能缺口 |

---

### 8.2 目标

**将 campaign 推进从"用户驱动"变为"事件驱动 + 自主决策"**：

- job 完成 / phase 转换 时，系统自动装载 context 并调用 LLM
- LLM 以 autonomous agent 身份做决策：升级 fidelity、生成报告、标记异常
- 人工关卡（L2 升级、最终报告）必须等用户确认，其余自动推进
- 所有自主决策写入 campaign state + memory，可审计

---

### 8.3 新增组件全景

```
┌────────────────────────────────────────────────────────────────────────┐
│  现有层（不改接口，只加 emit 调用）                                        │
│                                                                        │
│  JobManager._transition()          ──┐                                 │
│  CampaignMonitor._onPhaseComplete() ─┼──→ [emit 事件]                  │
│  instrumentTool → VVHookChain      ──┘                                 │
└────────────────────────────────────────────────────────────────────────┘
                          ↓
┌────────────────────────────────────────────────────────────────────────┐
│  新增层 1：CampaignEventBus                                              │
│  src/coordination/CampaignEventBus.ts                                  │
│                                                                        │
│  TypedEventEmitter，4 种事件：                                           │
│    job:completed   { campaignId, jobId, fidelityLevel, result }        │
│    job:failed      { campaignId, jobId, error }                        │
│    phase:transitioned { campaignId, fromPhase, toPhase, capsule,       │
│                         completedJobCount, failedJobCount }            │
│    vv:aborted      { campaignId, toolName, provenanceId, reason }      │
└────────────────────────────────────────────────────────────────────────┘
                          ↓ 订阅
┌────────────────────────────────────────────────────────────────────────┐
│  新增层 2：AutonomousLoopController                                      │
│  src/coordination/AutonomousLoopController.ts                          │
│                                                                        │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────────┐  │
│  │ TriggerScheduler  │  │  CircuitBreaker  │  │   SessionPool       │  │
│  │                  │  │                  │  │                     │  │
│  │ 聚合 phase 事件   │  │ max turns/phase  │  │ 每 campaign 一个    │  │
│  │ debounce 防风暴   │  │ token budget     │  │ autonomous session  │  │
│  │ 人工关卡拦截      │  │ failure counter  │  │ 独立 history        │  │
│  └──────────────────┘  └──────────────────┘  └─────────────────────┘  │
│                                ↓ 通过后                                 │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  autonomous session.submit(structuredTriggerPrompt, 'campaign') │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                ↓                                       │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────────┐  │
│  │ CampaignState    │  │ Memory System    │  │ NotifyFn            │  │
│  │ 决策记录写入      │  │ campaign_lessons  │  │ 用户通知摘要         │  │
│  └──────────────────┘  └──────────────────┘  └─────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 8.4 `CampaignEventBus` 详细设计

**文件**：`src/coordination/CampaignEventBus.ts`

```typescript
import { EventEmitter } from 'events'
import type { JobId, JobResult }        from '../jobs/types.js'
import type { CampaignPhase, CampaignContextCapsule } from './types.js'

// ── 事件载荷类型 ──────────────────────────────────────────────────────────────

export interface CampaignJobCompletedEvent {
  campaignId: string
  jobId: JobId
  fidelityLevel: number
  result: JobResult
}

export interface CampaignJobFailedEvent {
  campaignId: string
  jobId: JobId
  error: string
}

export interface CampaignPhaseTransitionedEvent {
  campaignId: string
  projectName: string
  fromPhase: CampaignPhase
  toPhase: CampaignPhase
  capsule: CampaignContextCapsule
  completedJobCount: number
  failedJobCount: number
}

export interface CampaignVVAbortedEvent {
  campaignId: string
  toolName: string
  provenanceId: string
  reason: string
}

// ── 类型安全的总线（进程内单例） ───────────────────────────────────────────────

interface TypedEventBus extends EventEmitter {
  emit(event: 'job:completed',      data: CampaignJobCompletedEvent):      boolean
  emit(event: 'job:failed',         data: CampaignJobFailedEvent):         boolean
  emit(event: 'phase:transitioned', data: CampaignPhaseTransitionedEvent): boolean
  emit(event: 'vv:aborted',         data: CampaignVVAbortedEvent):         boolean

  on(event: 'job:completed',      listener: (d: CampaignJobCompletedEvent) => void):      this
  on(event: 'job:failed',         listener: (d: CampaignJobFailedEvent) => void):         this
  on(event: 'phase:transitioned', listener: (d: CampaignPhaseTransitionedEvent) => void): this
  on(event: 'vv:aborted',         listener: (d: CampaignVVAbortedEvent) => void):         this
}

export const campaignEventBus = new EventEmitter() as TypedEventBus
campaignEventBus.setMaxListeners(50)  // 多 campaign 并发时不触发 Node.js 警告
```

**接入点（最小改动）**：

```typescript
// CampaignMonitor._onPhaseComplete() 末尾（已有 _refreshContext 调用之后）：
campaignEventBus.emit('phase:transitioned', {
  campaignId: store.campaignId,
  projectName: store.projectName,
  fromPhase: currentPhase,        // emit 前保存
  toPhase: nextPhase,
  capsule,
  completedJobCount,
  failedJobCount,
})

// JobManager._transition() 在 completed / failed 时：
if (newStatus === 'completed') {
  campaignEventBus.emit('job:completed', { campaignId, jobId, fidelityLevel, result })
} else if (newStatus === 'failed') {
  campaignEventBus.emit('job:failed', { campaignId, jobId, error })
}
```

---

### 8.5 `AutonomousLoopController` 详细设计

**文件**：`src/coordination/AutonomousLoopController.ts`

#### 8.5.1 配置

```typescript
export interface AutonomousLoopConfig {
  /**
   * 每个 campaign 每个 phase 最多触发的自主 LLM turn 数。
   * 默认 3 — 防止 LLM 在同一 phase 反复循环。
   */
  maxTurnsPerPhase: number            // default: 3

  /**
   * 每个 campaign 自主 LLM 调用的总 token 费用上限（USD）。
   * 超出后停止自主触发，通知用户接管。
   * 默认 $2。
   */
  maxAutonomousBudgetUsd: number      // default: 2.0

  /**
   * 人工确认关卡：到达这些 phase 后，Controller 不自动触发 LLM，
   * 而是通过 NotifyFn 告知用户，等待用户下次交互。
   * 默认锁定 PARETO_READY_L2 和 REPORTING：
   *   - PARETO_READY_L2 是最高精度数据，升级决策影响最大
   *   - REPORTING 是最终报告，需要用户确认内容方向
   */
  humanCheckpointPhases: CampaignPhase[]  // default: ['PARETO_READY_L2', 'REPORTING']

  /**
   * 触发粒度：
   *   'phase_only' — 只在 phase 转换时触发（推荐起点）
   *   'batch'      — N 个 job 完成或 T 秒超时时触发（更实时，适合超长 phase）
   */
  triggerMode: 'phase_only' | 'batch'     // default: 'phase_only'

  /** batch 模式：触发所需的最小 job 完成数 */
  batchSize?: number                  // default: 5

  /** batch 模式：距上次触发的最长等待时间 ms */
  batchTimeoutMs?: number             // default: 60_000

  /**
   * 连续失败次数上限。自主 turn 连续抛错 N 次后停止并通知用户。
   * 防止网络问题导致无限重试。
   * 默认 2。
   */
  maxConsecutiveFailures: number      // default: 2
}

export const DEFAULT_AUTONOMOUS_CONFIG: AutonomousLoopConfig = {
  maxTurnsPerPhase:        3,
  maxAutonomousBudgetUsd:  2.0,
  humanCheckpointPhases:   ['PARETO_READY_L2', 'REPORTING'],
  triggerMode:             'phase_only',
  maxConsecutiveFailures:  2,
}
```

#### 8.5.2 核心状态机

```typescript
// per-campaign 运行时状态
interface CampaignLoopState {
  turnsThisPhase:   number       // 当前 phase 已触发的 turn 数
  totalBudgetUsd:   number       // 本 campaign 累计 autonomous 花费
  consecutiveFails: number       // 连续失败次数
  currentPhase:     CampaignPhase
  session:          MetaAgentSession   // 专属 autonomous session
  isRunning:        boolean       // 防并发：同一时刻只允许一个 autonomous turn
}
```

#### 8.5.3 触发流程（`phase_only` 模式）

```
phase:transitioned 事件到达
  ↓
① 人工关卡检查
   toPhase ∈ humanCheckpointPhases → NotifyFn("需要您的判断") → 停止
  ↓
② 终态检查
   toPhase ∈ {DONE, FAILED} → cleanup → 停止
  ↓
③ 并发保护
   isRunning === true → 跳过（上一个 turn 还在跑）
  ↓
④ Circuit Breaker
   turnsThisPhase ≥ maxTurnsPerPhase → NotifyFn("turn 上限") → 停止
   totalBudgetUsd ≥ maxAutonomousBudgetUsd → NotifyFn("预算耗尽") → 停止
   consecutiveFails ≥ maxConsecutiveFailures → NotifyFn("连续失败") → 停止
  ↓
⑤ phase 变更 → 重置 turnsThisPhase = 0
  ↓
⑥ isRunning = true
   session.submit(triggerPrompt, 'campaign')
   → 收集 result event → 路由输出
   → 更新 totalBudgetUsd += cost
   → consecutiveFails = 0（成功）
   isRunning = false
  ↓
⑦ 如果 LLM 决策触发了新 phase 转换 → 事件总线再次触发，回到 ①
```

#### 8.5.4 Autonomous Session 设计

每个 campaign 有且仅有一个专属 autonomous session，与用户的 interactive session **完全隔离**：

```typescript
function createAutonomousSession(
  campaignId: string,
  baseConfig: MetaAgentConfig,
): MetaAgentSession {
  return new MetaAgentSession({
    ...baseConfig,
    // 独立 system prompt 后缀：告知模型当前身份
    appendSystemPrompt: [
      '',
      '[AUTONOMOUS MODE] You are running as a background decision agent.',
      `Campaign ID: ${campaignId}`,
      'Rules:',
      '- Make decisive actions based on available data. Do not ask for clarification.',
      '- If data quality is insufficient for a confident decision, call request_human_review().',
      '- Maximum 5 tool calls per turn. Do not over-explore.',
      '- All decisions are logged and auditable.',
    ].join('\n'),
    maxTurns: 5,          // 单次触发最多 5 个 tool call，防止失控
    maxBudgetUsd: 0.5,    // 单次触发最多 $0.5，session 级硬上限
  })
}
```

**为什么不复用用户 session**：

| 特性 | Interactive Session | Autonomous Session |
|------|--------------------|--------------------|
| conversation history | 用户对话历史 | 仅 campaign 上下文 |
| compact 触发 | 用户 context 满时 | 各自独立计算 |
| interrupt() | 用户按 Ctrl+C | circuit breaker 控制 |
| tool 权限 | 用户配置的全量工具 | 仅 campaign management 工具 |
| 输出目标 | 用户终端 | CampaignState + Memory + NotifyFn |

---

### 8.6 结构化触发 Prompt 模板

触发 prompt 使用**结构化格式**，不是自由文本，让 LLM 能可靠提取关键数字：

```
[AUTONOMOUS TRIGGER — phase:transitioned]

Campaign: {projectName} ({campaignId})
Transition: {fromPhase} → {toPhase}

Phase completion summary:
  Jobs completed: {completedJobCount}
  Jobs failed:    {failedJobCount}
  Failure rate:   {failureRatePct}%
  ⚠️  V&V warnings: {warningCount}   ← 仅当 warningCount > 0 时显示

Current campaign context:
{capsule.contextBlock}               ← 完整的 CampaignContextCapsule

Decision rules (apply in order):
1. If failure rate > 20%: call flag_for_human_review("High failure rate")
2. If PARETO_READY_L0 and hypervolume < threshold: call escalate_fidelity(target='L1')
3. If PARETO_READY_L0 and hypervolume ≥ threshold: call escalate_fidelity(target='L1') or proceed to report
4. If PARETO_READY_L1 and confidence is high: call begin_reporting()
5. If uncertain: call request_human_review("Reason: ...")

Take exactly one decisive action.
```

---

### 8.7 输出路由

```
autonomous session.submit() 结果
  ↓
┌──────────────────────────────────────────────────────────────┐
│  结果路由（三路并行，互不阻塞）                                   │
│                                                              │
│  1. CampaignStateStore                                       │
│     写入 autonomous_decision 字段：                            │
│     { timestamp, phase, decision, cost, provenanceRef }      │
│                                                              │
│  2. Memory System (campaign_lessons)                         │
│     写入 ~/.claude/meta-agent/memory/<campaignId>_phase.md   │
│     frontmatter: type=campaign_lessons, campaign=<id>        │
│     body: 决策摘要 + 关键数字 + 采取的行动                      │
│                                                              │
│  3. NotifyFn → 用户通知                                       │
│     标题: Campaign "{name}" 自主推进                          │
│     内容: 最多 200 字的决策摘要                                 │
└──────────────────────────────────────────────────────────────┘
```

---

### 8.8 Circuit Breaker 完整规则表

| 触发条件 | 行为 | 恢复方式 |
|----------|------|----------|
| `turnsThisPhase ≥ maxTurnsPerPhase` | 停止自主触发，通知用户 | phase 转换后自动重置计数器 |
| `totalBudgetUsd ≥ maxAutonomousBudgetUsd` | 永久停止该 campaign 自主循环 | 用户显式重新启用 |
| `consecutiveFails ≥ maxConsecutiveFailures` | 停止并通知用户，保留状态 | 用户确认后重新触发 |
| `toPhase ∈ humanCheckpointPhases` | 停止，通知用户来做判断 | 用户发消息继续 |
| `toPhase ∈ {DONE, FAILED}` | 停止，cleanup，写 campaign_lessons | 无需恢复（终态） |
| autonomous session 抛 AbortError | 停止（视为用户中断） | 下次事件正常触发 |
| autonomous session maxTurns 耗尽（5次工具调用） | 记录为"需要更多上下文"，通知用户 | 下次 phase 事件触发 |

---

### 8.9 与现有代码的接入点

实施时**最小改动原则**：Monitor 和 JobManager 的核心逻辑不变，只在完成路径末尾加 `emit` 调用。

```
src/coordination/
├── CampaignEventBus.ts        ← 新增（纯新文件，~60 行）
├── AutonomousLoopController.ts ← 新增（核心新文件，~250 行）
├── CampaignMonitor.ts          ← 改动：_onPhaseComplete() 末尾 +3 行
├── CampaignStateStore.ts       ← 改动：autonomous_decision 字段 +10 行
└── index.ts                    ← 改动：export 新增的两个文件

src/jobs/
└── JobManager.ts               ← 改动：_transition() +4 行（job:completed/failed emit）

src/routing/
└── SessionRouter.ts            ← 改动：campaign 模式创建 Controller +15 行
```

---

### 8.10 与 §7 的关系（DAG + JobManager 守护进程化）

事件驱动 autonomous loop 是 §7 两个方向的**前置条件**，而不是竞争方案：

| 升级方向 | 与事件驱动的关系 |
|----------|-----------------|
| DAG Campaign 编排（§7.1） | EventBus 天然支持多分支：每个 Phase Node 完成时 emit 事件，Controller 订阅对应节点的完成事件即可 |
| JobManager 守护进程化（§7.2） | 守护进程通过 IPC/HTTP 将 job 完成事件推给主进程的 EventBus；主进程侧不变 |

因此实施顺序建议：**EventBus 先行** → 为 DAG 和守护进程化铺路。

---

### 8.11 实施阶段规划

```
Phase 1（纯管道，无 LLM，~1 天）
  目标: 建立事件基础设施
  交付:
    - CampaignEventBus（含类型定义）
    - CampaignMonitor._onPhaseComplete() 接入 emit
    - 单元测试：事件能否被订阅者收到
  风险: 极低（纯加法，无破坏性）

Phase 2（通知驱动，无 LLM，~0.5 天）
  目标: phase:transitioned → 用户通知
  交付:
    - AutonomousLoopController（仅 CircuitBreaker + NotifyFn 路径）
    - SessionRouter 接入 Controller
    - 测试：L0 完成后用户能收到系统通知
  风险: 低（不触发 LLM）

Phase 3（LLM 自主决策，~3 天）
  目标: 全自主推进 L0→L1 流程
  交付:
    - Autonomous Session 创建与管理
    - TriggerPrompt 模板
    - 输出路由（State + Memory + Notify）
    - Circuit Breaker 完整逻辑
    - 集成测试：端到端 campaign 无人值守完成 L0→L1
  风险: 中（需要充分测试 circuit breaker 的各个触发条件）

Phase 4（批次触发，按需，~1 天）
  目标: 超长 phase 中途进度摘要
  交付:
    - TriggerScheduler batch 模式
    - batchSize + batchTimeoutMs 配置
  风险: 低（是 Phase 3 的扩展，复用已有 autonomous session）
```

---

### 8.12 设计约束与不变量

1. **默认关闭** — `AutonomousLoopController` 必须显式启用（`autonomousLoop: true`）。用户不会在不知情的情况下触发后台 LLM 调用。

2. **Monitor 轮询作为 fallback** — EventBus 是 best-effort。进程重启后事件丢失，Monitor 的 5s 轮询确保最终一致性。两者互补，不是替代。

3. **autonomous session 绝对隔离** — autonomous session 的 conversation history、compact 周期、tool 权限完全独立于用户 interactive session。两者无任何共享状态。

4. **人工关卡不可被 LLM 绕过** — `humanCheckpointPhases` 的检查在 Controller 代码层面执行，不在 LLM prompt 里声明。LLM 无法通过工具调用或 prompt 注入跨越人工关卡。

5. **所有自主决策可审计** — 每次 autonomous turn 的决策、花费、使用的工具调用都写入 CampaignStateStore，同时写入 memory system，不存在"系统悄悄做了什么但用户不知道"的情况。

---

## 9. Sub-Agent Task System（子 Agent 任务系统）

### 9.1 问题背景与目标

主 Agent 在执行 Campaign 时，常需要将"长时子任务"委派给子 Agent：

| 委派场景 | 示例 |
|---|---|
| 并行工程仿真 | 同时运行 L0 / L1 / L2 评估 |
| 异构工具链 | 子 Agent 持有不同的 MCP 工具集 |
| 人工在环审批 | 子任务完成后，需人类决策才能继续 |
| 长时后台任务 | 任务耗时数小时，主 Agent 不阻塞 |

**核心不变量：**

1. **上下文隔离** — 子 Agent 有独立 `MetaAgentSession`，不共享主 Agent 的对话历史
2. **状态单向流动** — 主 Agent 只能获取子任务最终状态（成功/失败/结果摘要），不获取中间过程（除非主动请求）
3. **熔断器硬编码** — `maxTurns` / `maxBudgetUsd` 在代码层执行，不依赖 prompt 层约束
4. **默认关闭自治** — `requireHumanApproval: false` 是可选项，不是默认值

---

### 9.2 架构全景

```
┌─────────────────────────────────────────────────────────┐
│                  主 Agent Session                        │
│   MetaAgentSession (主对话上下文)                         │
│                                                         │
│  spawn_sub_agent ──────────────────────────────────┐   │
│  get_sub_agent_status ─────────────────────────┐   │   │
│  get_sub_agent_intermediate ───────────────┐   │   │   │
│  cancel_sub_agent ─────────────────────┐   │   │   │   │
│                                        │   │   │   │   │
│           SubAgentBridge               │   │   │   │   │
│  ┌─────────────────────────────────────▼───▼───▼───▼─┐ │
│  │  spawnSubAgent()  getStatus()  getIntermediate()   │ │
│  │  cancelTask()     drainNotifications()             │ │
│  │                                                    │ │
│  │  pendingNotifications: Map<sessionId, string[]>    │ │
│  │  pollTimers:  Map<taskId, NodeJS.Timeout>          │ │
│  └───────────────────┬────────────────────────────────┘ │
└──────────────────────┼──────────────────────────────────┘
                       │ spawn
                       ▼
┌──────────────────────────────────────────────────────────┐
│                SubAgentRunner                            │
│                                                          │
│  隔离 MetaAgentSession                                    │
│    sessionId:  独立 UUID                                  │
│    history:    空（不继承主 Agent 历史）                    │
│    tools:      config.allowedTools 子集                   │
│                                                          │
│  熔断器                          写入 TaskStore           │
│    turnCount >= maxTurns  ──────► status=failed           │
│    costUsd   >= maxBudget ──────► status=failed           │
│    abort signal ──────────────► status=cancelled          │
│                                                          │
│  事件发布                                                 │
│    completed → CampaignEventBus.emit('subagent:completed')│
│    failed    → CampaignEventBus.emit('subagent:failed')   │
│    每 N 轮   → CampaignEventBus.emit('subagent:checkpoint')│
└────────────────────────────────┬─────────────────────────┘
                                 │
                ┌────────────────▼──────────────────┐
                │        CampaignEventBus            │
                │  (TypedEventEmitter 单例)           │
                └────────────────┬──────────────────┘
                                 │ on('subagent:completed')
                ┌────────────────▼──────────────────┐
                │       SubAgentTaskStore            │
                │  ~/.claude/meta-agent/subtasks/    │
                │  <taskId>.json                     │
                │  序列化写链（per-taskId）            │
                └───────────────────────────────────┘
```

---

### 9.3 两种通知模式

#### 模式 A：事件驱动（`useEventDriven: true`，推荐）

```
子 Agent 完成
    │
    ├─► CampaignEventBus.emit('subagent:completed')
    │         │
    │         └─► SubAgentBridge 监听器
    │                   │
    │                   └─► pendingNotifications[parentSessionId].push(通知文本)
    │
    └─► SubAgentTaskStore.write(status=completed, result)

主 Agent 下一轮 submit() 时：
    │
    ├─► 动态 prompt section "D-SubAgent" 调用 drainNotifications()
    │         返回：["子任务 task-abc 已完成，结果：..."]
    │
    └─► 模型看到通知，调用 get_sub_agent_status(taskId) 获取完整结果并继续
```

**通知注入机制（与 SectionRegistry 集成）**

`SubAgentBridge.drainNotifications(parentSessionId)` 在每轮 `submit()` 的动态 prompt 构建阶段被调用，将所有待处理通知以 `D-SubAgent` section 注入系统提示：

```
## Sub-Agent Notifications (pending)
- [task-abc-1234] 已完成 ✓  用时 3 轮 / $0.12
  摘要：L1 仿真收敛，最优设计点 capacity=4.3 Ah, η=0.92
- [task-def-5678] 失败 ✗  原因：turn limit exceeded (10/10 turns)
```

模型收到通知后，自行决定下一步（调用 `get_sub_agent_status` 获取详情 / 处理失败 / 向用户报告）。

#### 模式 B：Monitor 轮询（`useEventDriven: false`）

```
子 Agent 完成
    │
    └─► SubAgentTaskStore.write(status=completed, result)

主 Agent 轮询（每 pollIntervalMs = 30min）：
    │
    └─► 定时器调用 SubAgentBridge._pollCheck(taskId)
              │
              └─► 读 TaskStore → 如果 terminal → drainNotifications() 追加通知
```

两种模式最终都通过 **通知队列 → 动态 prompt section** 路径触达主 Agent，区别仅在于写入队列的触发时机。

---

### 9.4 人工审批门（`requireHumanApproval`）

```
requireHumanApproval: false（默认）        requireHumanApproval: true
─────────────────────────────────────     ──────────────────────────────────────
子任务完成                                  子任务完成
    │                                          │
    ▼                                          ▼
通知注入主 Agent                          通知注入主 Agent
    │                                          │
    ▼                                     pendingHumanApproval: true
主 Agent 自主继续                               │
                                               ▼
                                          主 Agent 向用户报告：
                                          "子任务 X 已完成，结果：...
                                           请确认是否继续执行下一步？"
                                               │
                                          用户回复："继续" / 拒绝 / 修改方向
                                               │
                                               ▼
                                          主 Agent 继续 / 分叉 / 终止
```

`pendingHumanApproval: true` 时，`get_sub_agent_status` 返回的记录中包含该字段，主 Agent 系统提示中有硬编码规则：**收到 `pendingHumanApproval=true` 的任务状态，必须向用户呈现结果并等待确认，不得自主继续。**

---

### 9.5 熔断器规则

| 熔断条件 | 触发 | 子 Agent 状态 | 主 Agent 收到 |
|---|---|---|---|
| `turnCount >= maxTurns` | 在每轮开始前检查 | `failed` | `error: "turn limit exceeded (N/N)"` |
| `costUsd >= maxBudgetUsd` | 在每轮开始前检查 | `failed` | `error: "budget exceeded ($X.XX / $Y.YY)"` |
| 主 Agent 调用 `cancel_sub_agent` | 即时 | `cancelled` | 确认取消 |
| AbortSignal 触发 | 即时 | `cancelled` | — |
| 子 Agent 任务本身抛异常 | 捕获 | `failed` | 异常消息（截断至 500 字符） |

熔断检查在 `SubAgentRunner._runLoop()` 的 **每次迭代开始前** 执行，不依赖 LLM 自我报告。

---

### 9.6 主 Agent 可用工具

#### `spawn_sub_agent`

```typescript
input: {
  task_description: string       // 子任务自然语言描述（注入为子 Agent 首条 user 消息）
  system_prompt?: string         // 子 Agent 系统提示（不填则继承主 Agent 配置）
  allowed_tools?: string[]       // 允许子 Agent 使用的工具名列表（不填则无工具）
  max_turns?: number             // 默认 10
  max_budget_usd?: number        // 默认 0.5
  require_human_approval?: boolean // 默认 false
  use_event_driven?: boolean     // 默认 true
  poll_interval_ms?: number      // 默认 1_800_000 (30 min)，仅 event_driven=false 时有效
}
output: {
  task_id: string
  status: 'pending'
  message: string  // "Sub-agent started. Task ID: task-xxx. You will be notified on completion."
}
```

#### `get_sub_agent_status`

```typescript
input: { task_id: string }
output: {
  task_id: string
  status: SubAgentStatus          // 'pending'|'running'|'completed'|'failed'|'cancelled'
  pending_human_approval: boolean
  result?: {
    success: boolean
    summary: string               // 子 Agent 最后一条 text 输出（截断至 2000 字符）
    turns_used: number
    cost_usd: number
    duration_ms: number
    error?: string
  }
  created_at: string              // ISO 8601
  started_at?: string
  completed_at?: string
}
```

#### `get_sub_agent_intermediate`

```typescript
// 主动获取子任务最新 checkpoint（子 Agent 每 checkpointEveryNTurns 轮自动保存一次）
input: { task_id: string }
output: {
  task_id: string
  status: SubAgentStatus
  latest_checkpoint?: string      // 最新一轮完整 text 输出
  latest_checkpoint_at?: string   // ISO 8601
  turns_so_far: number
}
```

#### `cancel_sub_agent`

```typescript
input: { task_id: string; reason?: string }
output: { task_id: string; cancelled: boolean; message: string }
```

---

### 9.7 SubAgentConfig 完整接口

```typescript
export interface SubAgentConfig {
  // ── 任务描述 ──────────────────────────────────────────────────────────────
  taskDescription: string         // 作为子 Agent 第一条 user 消息
  systemPrompt?: string           // 不填则使用 DEFAULT_SYSTEM_PROMPT
  allowedTools?: string[]         // 不填则子 Agent 无工具（纯推理模式）

  // ── 熔断器 ────────────────────────────────────────────────────────────────
  maxTurns: number                // default: 10
  maxBudgetUsd: number            // default: 0.5

  // ── 通知模式 ──────────────────────────────────────────────────────────────
  useEventDriven: boolean         // default: true
  pollIntervalMs: number          // default: 1_800_000；仅 event_driven=false 时有效

  // ── 人工审批 ──────────────────────────────────────────────────────────────
  requireHumanApproval: boolean   // default: false

  // ── Checkpoint ────────────────────────────────────────────────────────────
  checkpointEveryNTurns: number   // default: 3；0 = 禁用 checkpoint
}
```

---

### 9.8 SubAgentRecord 持久化结构

```typescript
// 存储于 ~/.claude/meta-agent/subtasks/<taskId>.json
export interface SubAgentRecord {
  schemaVersion: '1.0'
  taskId: string
  parentSessionId: string
  status: SubAgentStatus
  config: SubAgentConfig
  createdAt: number               // epoch ms
  startedAt?: number
  completedAt?: number
  result?: SubAgentResult
  // Checkpoint（每 N 轮更新）
  latestCheckpoint?: string
  latestCheckpointAt?: number
  // 人工审批门
  pendingHumanApproval: boolean
}
```

---

### 9.9 与现有系统的接入点（5 处改动，~50 行）

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/subagent/` | 全新目录（7 个文件） | 核心实现 |
| `src/core/dynamicPrompt.ts` | 新增 `D-SubAgent` section（~15 行） | 通知注入 |
| `src/index.ts` | `export * from './subagent/index.js'` | 公开 API |
| `src/subagent/tools/index.ts` | 4 个工具 export | 主 Agent 注册 |
| `meta-agent-architecture.md` | 本节（§9） | 设计记录 |

与 §8 `AutonomousLoopController` 的区别：§8 是 Campaign Phase 驱动的**系统级**自主循环；§9 是主 Agent 显式委派的**任务级**子 Agent 系统。两者均使用 `CampaignEventBus`，但事件类型不同。

---

### 9.10 设计约束与不变量

1. **上下文不泄漏** — 子 Agent 启动时 `mutableMessages = []`，无法访问主 Agent 历史
2. **主 Agent 只看最终态** — 默认路径只传递 `SubAgentResult`，中间 turn 不上浮
3. **中间过程按需获取** — 仅当主 Agent 显式调用 `get_sub_agent_intermediate` 才读 checkpoint
4. **熔断器不可绕过** — `maxTurns` / `maxBudgetUsd` 在 `SubAgentRunner._runLoop()` 硬检查，LLM 输出无法覆盖
5. **人工审批门代码级实现** — `pendingHumanApproval` 检查在工具 handler 层，不依赖 prompt 层约束
6. **通知幂等** — `drainNotifications()` 清空后重复调用返回空数组，防止重复通知
7. **任务持久化** — 进程重启后可通过 `SubAgentTaskStore.read(taskId)` 恢复状态；但 runner 的 `AbortController` 不跨进程，已运行中的子任务在重启后状态停留在 `running`，需调用方调用 `cancel_sub_agent` 后重新 spawn

---

## 10. Campaign Plugin 框架（§10）

### 10.1 设计动机

DOE Campaign 是第一种 Campaign 类型，但工程场景还需要其他类型（PaperRepro、SweepOnly、…）。
如果每种类型都各自硬编码到 dynamicPrompt.ts、CampaignMonitor.ts、MetaAgentContextStore.ts，
维护成本随类型数量线性增长。Campaign Plugin 框架的目标是：

> 新增一种 Campaign 类型 = 新增一个文件（`src/campaigns/<type>/plugin.ts`）+ 一行注册代码

### 10.2 目录结构

```
src/campaign/               ← 框架层（与具体类型无关）
  types.ts                  ← CampaignPlugin<TPhase,TState,TParams> 接口
  registry.ts               ← CampaignPluginRegistry 单例
  store.ts                  ← GenericCampaignStore（非DOE类型的持久化实现）

src/campaigns/              ← 具体 Campaign 类型实现
  index.ts                  ← 启动时注册所有内置插件（import once）
  doe/
    plugin.ts               ← DOE 插件（wraps CampaignStateStore，不改原文件）
    index.ts
  paper-repro/
    plugin.ts               ← PaperRepro 插件（使用 GenericCampaignStore）
    index.ts
```

### 10.3 CampaignPlugin 接口关键设计

```typescript
interface CampaignPlugin<TPhase extends string, TState extends object, TParams = Record<string,unknown>> {
  readonly type: string           // 稳定的标识符，写入持久化 state
  readonly version: string        // SemVer — 变化触发 migrateState()
  readonly displayName: string
  readonly description: string

  readonly phases: PhaseDefinition<TPhase>  // 状态机拓扑

  createInitialState(params: TParams): TState
  validateState(raw: unknown): raw is TState
  migrateState?(oldState: unknown, fromVersion: string): TState  // 向前兼容

  buildCapsule(state: TState, phase: TPhase): string        // D8 注入
  buildPhaseGuidance(phase: TPhase, state: TState): string  // D10 注入

  readonly tools: readonly MetaAgentTool[]   // 仅当此 Campaign 激活时注册

  onPhaseEnter?(phase: TPhase, state: TState): Promise<void>  // 可选钩子
  onPhaseExit?(phase: TPhase, state: TState): Promise<void>
  buildFinalReport?(state: TState): string
}
```

### 10.4 D10 变更：hardcoded → plugin dispatch

**改动前：** `dynamicPrompt.ts` 内有一个 DOE 专用的 `PHASE_GUIDANCE` Map，
`buildPhaseGuidanceSection()` 直接查这个 Map。

**改动后：** `buildPhaseGuidanceSection()` 读取 `CampaignSummary.pluginType`，
通过 `campaignRegistry.get(pluginType).buildPhaseGuidance(phase, state)` 获取 guidance。
DOE 的 guidance 字符串移入 `src/campaigns/doe/plugin.ts`，与 DOE 插件逻辑内聚。

向后兼容：`CampaignSummary.pluginType` 为 optional；
若缺失（旧文件），D10 降级到原来的 `USER_CHECKPOINT_PHASES` / `MACHINE_PHASES` 静态判断。

### 10.5 存储分层

| Campaign 类型 | 持久化实现 | 状态文件 |
|---|---|---|
| DOE | `CampaignStateStore`（保持不变） | `~/.claude/meta-agent/campaigns/<id>/state.json` |
| PaperRepro | `GenericCampaignStore` | 同上（不同格式） |
| 未来类型 | `GenericCampaignStore` | 同上 |

`GenericPersistedState` 包含 `pluginType` + `pluginVersion` 字段，
框架可在 open() 时自动路由到正确的插件并按需调用 `migrateState()`。

### 10.6 PaperRepro Campaign 阶段

```
SEARCH → ACCESS → PARSE → PLAN* → ENV_SETUP → IMPLEMENT
  → CODE_REVIEW* → BASELINE_RUN → SWEEP_RUN → VALIDATE → REPORT → DONE
                                                         ↘ BLOCKED（任意阶段可转入）
* = 人工检查点
```

**V&V 接受标准：** 默认 ±10% 相对偏差。系统性偏差记录根因假设而非标记为失败。
**环境隔离：** Docker image + requirements.lock，确保跨机器复现性。

### 10.7 注册模式 vs. 未来插件化

当前：Registration Pattern — 所有内置类型在 `src/campaigns/index.ts` 静态注册。

未来：`campaignRegistry.loadExternalPlugin(packageName)` 接口已预留，
实现时只需把 `import(packageName)` 的 default export 注册进去，
调用侧代码（D10、Monitor、Store）无需任何改动。

---

## 11. 参考：CC Prompt 设计原则（对 Meta-Agent 有借鉴价值）

1. **静态/动态分离** — 不变的内容放静态区（可缓存），随 session 变化的放动态区
2. **Section Registry** — 每个动态 section 有名字、计算函数、是否 cache-break 三个属性，避免全量重算
3. **Volatile 标注** — 真正需要每轮重算的 section 需要显式标注（`DANGEROUS_uncachedSystemPromptSection`），不可随意添加
4. **Compact 防漂移** — 压缩摘要的 "Current Work" 和 "Optional Next Step" 必须引用原话，防止任务解读漂移
5. **Memory 分类** — 不是所有信息都值得记忆；WHAT_NOT_TO_SAVE 和 WHEN_TO_ACCESS 同样重要
6. **Sub-agent 各有角色** — 每种 agent 有明确的能力边界（explore 是只读的、verification 是对抗性的），防止角色混淆
7. **Tool description 的 when-NOT-to-use** — 好的 tool description 不只说能做什么，还要说什么时候不该用
8. **行动风险规范独立成章** — "可逆性"判断框架是一个章节，不散落在其他规则里，模型更容易遵守
9. **Plugin 接口一次设计，实现可演化** — Campaign 类型的接口在框架层固定，具体实现可随时替换/迁移，调用侧不感知
