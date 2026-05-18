# Robotics Algorithm Development Mode — 完备设计方案

> 版本: v1.0 | 状态: 待评审  
> 基础: meta-agent-runtime 现有架构  
> 目标: 在不破坏现有 direct / agentic / campaign 三种模式的前提下，叠加一个针对机器人算法研发的专用模式与配套基础设施

---

## 目录

1. [设计目标与约束](#1-设计目标与约束)
2. [整体架构概览](#2-整体架构概览)
3. [AgentMode 扩展：`robotics`](#3-agentmode-扩展robotics)
4. [ExperienceStore — 经验存储机制](#4-experiencestore--经验存储机制)
5. [多 Agent 专家体系](#5-多-agent-专家体系)
6. [实验隔离模式 (Noise Isolation)](#6-实验隔离模式-noise-isolation)
7. [新增 Robotics 工具集](#7-新增-robotics-工具集)
8. [动态 Prompt 扩展节 R1–R5](#8-动态-prompt-扩展节-r1r5)
9. [RoboticsSession 封装类](#9-roboticssession-封装类)
10. [文件目录结构](#10-文件目录结构)
11. [与现有系统的集成点](#11-与现有系统的集成点)
12. [数据流全景图](#12-数据流全景图)
13. [分阶段实施计划](#13-分阶段实施计划)
14. [开放问题与后续决策](#14-开放问题与后续决策)

---

## 1. 设计目标与约束

### 1.1 核心目标

| # | 目标 | 度量 |
|---|------|------|
| G1 | 噪音隔离：实验过程日志不进入主 Agent 上下文 | 实验 sub-agent 只向主 Agent 返回结构化摘要 |
| G2 | 经验复用：跨任务的算法经验可检索、可召回 | ExperienceStore 支持 tag/domain/keyword 搜索，召回延迟 < 200 ms |
| G3 | 多专家协作：PaperSearch / Experiment / Code / Deploy 等专家 Agent 可并行或串行调度 | 通过现有 SubAgentBridge 实现 |
| G4 | 与现有三种模式共存 | `AgentMode` 扩展为 4 选项，routing 逻辑向后兼容 |
| G5 | 零外部依赖 | 纯文件系统 + 现有 SDK，不引入新数据库 |

### 1.2 约束

- **不重写 MetaAgentSession**：RoboticsSession 通过组合（非继承）复用核心。
- **文件优先**：所有持久化数据写 JSON/Markdown，与 MEMORY.md 体系风格一致。
- **sub-agent 隔离**：实验 Agent 的 tool-set 仅开放文件读写 + shell，不开放 MCP / UI 工具。
- **经验写入是副作用**：主 Agent 不强制触发写入，ExperimentAgent 自主在 finalReport 阶段写入。

---

## 2. 整体架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        RoboticsSession                              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  MetaAgentSession (mode='robotics')                          │   │
│  │  Dynamic Sections: D1-D10 (existing) + R1-R5 (new)          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  ┌───────────┐  │
│  │ExperienceStore│ │SubAgentBridge│ │HardwarePro-│  │ProvenanceT│  │
│  │ (new)        │ │ (existing)   │ │file (new)  │  │racker(ex.)│  │
│  └─────────────┘  └──────┬──────┘  └────────────┘  └───────────┘  │
│                          │                                          │
│         ┌────────────────┼───────────────────────────┐             │
│         ▼                ▼                           ▼             │
│  ┌─────────────┐  ┌─────────────┐           ┌─────────────┐        │
│  │PaperSearch  │  │Experiment   │           │Deploy       │        │
│  │Agent        │  │Agent        │  ...      │Agent        │        │
│  │(sub-agent)  │  │(sub-agent)  │           │(sub-agent)  │        │
│  └─────────────┘  └──────┬──────┘           └─────────────┘        │
│                          │                                          │
│                   ┌──────▼──────┐                                   │
│                   │Experiment   │ ← 实验隔离沙箱                    │
│                   │Results Store│   (噪音留在 sub-agent 内)         │
│                   └─────────────┘                                   │
└─────────────────────────────────────────────────────────────────────┘

持久化层:
  ~/.claude/meta-agent/memory/          ← 现有记忆体系
  ~/.claude/meta-agent/robotics/
    experiences/                        ← ExperienceStore (新)
      EXPERIENCE_INDEX.md
      exp_<id>.json
    hardware_profiles/                  ← 硬件档案
      <robot_name>.json
    experiments/                        ← 实验原始记录 (隔离区)
      <task_id>/
        raw_log.md
        structured_summary.json
```

---

## 3. AgentMode 扩展：`robotics`

### 3.1 类型定义变更

**文件**: `src/core/dynamicPrompt.ts`

```typescript
// 现有
export type AgentMode = 'direct' | 'agentic' | 'campaign'

// 变更后
export type AgentMode = 'direct' | 'agentic' | 'campaign' | 'robotics'
```

### 3.2 SessionRouter 信号扩展

**文件**: `src/routing/ModeDetector.ts`

新增 robotics 模式信号词（权重设计参考现有 `MODE_WEIGHT`）：

```typescript
const ROBOTICS_SIGNALS: ModeSignal[] = [
  { keyword: 'robot',        weight: 3 },
  { keyword: 'firmware',     weight: 3 },
  { keyword: 'ros',          weight: 4 },  // ROS/ROS2
  { keyword: 'trajectory',   weight: 3 },
  { keyword: 'kinematics',   weight: 3 },
  { keyword: 'slam',         weight: 4 },
  { keyword: 'simulation',   weight: 2 },
  { keyword: 'hardware test',weight: 4 },
  { keyword: 'experiment',   weight: 2 },
  { keyword: 'algorithm dev',weight: 3 },
]
// 阈值建议 >= 6 分切换为 robotics 模式
```

### 3.3 模式兼容性矩阵

| 功能 | direct | agentic | campaign | robotics |
|------|--------|---------|----------|----------|
| 工具调用 | ✗ | ✓ | ✓ | ✓ |
| SubAgentBridge | ✗ | ✗ | ✓ | ✓ |
| Memory D1 | ✓ | ✓ | ✓ | ✓ |
| ExperienceStore R2 | ✗ | ✗ | ✗ | ✓ |
| CampaignStateStore | ✗ | ✗ | ✓ | 可选 |
| HardwareProfile R4 | ✗ | ✗ | ✗ | ✓ |
| Experiment isolation | ✗ | ✗ | ✗ | ✓ |

---

## 4. ExperienceStore — 经验存储机制

ExperienceStore 是本方案的核心创新点，设计上与 Memory 体系平行但独立。

### 4.1 设计原则

- **EXPERIENCE_INDEX.md 常驻 prompt**：类比 MEMORY.md，索引页始终注入系统提示（R2 节）
- **经验单按需加载**：主 Agent 可用 `experience_load` 工具按 ID 加载完整经验
- **自动写入**：ExperimentAgent 完成后自动调用 `experience_write` 写入摘要
- **向量索引替代方案留口**：当前用关键词 + tag 匹配，接口预留 `embedSearch()` 扩展点

### 4.2 ExperienceEntry 数据结构

```typescript
// src/robotics/types.ts

export interface ExperienceEntry {
  /** 唯一 ID，格式 exp_<timestamp>_<uuid4[:8]> */
  id: string
  schemaVersion: '1.0'
  createdAt: number       // Unix ms
  updatedAt: number

  // ── 分类与检索 ─────────────────────────────────────────────────────
  domain: RoboticsDomain  // 见下方枚举
  algorithm?: string      // 'RL-PPO' | 'MPC' | 'A-Star' | ...
  tags: string[]          // 自由标签，全小写
  robot?: string          // 机器人型号 / 项目名
  difficulty: 'low' | 'medium' | 'high'

  // ── 内容 ────────────────────────────────────────────────────────────
  title: string           // 一行标题，≤ 80 chars
  problem: string         // 问题描述，≤ 500 chars（索引中显示）
  solution: string        // 解决方案要点，≤ 800 chars
  outcome: ExperienceOutcome
  metrics?: Record<string, number | string>  // e.g. { success_rate: 0.92, fps: 30 }

  // ── 溯源 ────────────────────────────────────────────────────────────
  sourceTaskId?: string   // 产生该经验的 SubAgent taskId
  sourceSessionId?: string
  relatedPapers?: string[] // arXiv IDs or DOIs

  // ── 全文（按需加载） ──────────────────────────────────────────────
  fullReport?: string     // Markdown，不在索引中，仅在 experience_load 时返回
}

export type RoboticsDomain =
  | 'motion_planning'
  | 'perception'
  | 'manipulation'
  | 'locomotion'
  | 'navigation'
  | 'simulation'
  | 'hardware_interface'
  | 'deployment'
  | 'calibration'
  | 'general'

export interface ExperienceOutcome {
  success: boolean
  summary: string   // ≤ 200 chars，在索引行尾显示
  failureReason?: string
  workarounds?: string[]
}
```

### 4.3 EXPERIENCE_INDEX.md 格式

```markdown
# Experience Index
*Last updated: 2026-05-17 12:34 | Total: 42 entries*

## motion_planning (8)
- [exp_1716..._a3f2] **A* on ROS2 Nav2 with dynamic obstacles** | ✓ 成功率92% | tags: ros2, astar, dynamic
- [exp_1716..._b7c1] **MPC轨迹追踪调参经验** | ✓ RMSE < 0.02m | tags: mpc, tuning, mobile-robot
- [exp_1715..._c2d9] **SLAM建图漂移修复** | ✗ 部分解决，见全文 | tags: slam, drift, lidar

## perception (5)
- [exp_1716..._d4e8] **YOLOv8 + 深度图融合目标检测** | ✓ 推理30fps | tags: yolo, depth, ros2
...

## 快速检索提示
使用 `experience_search domain=<domain> tags=<tag1,tag2>` 搜索
使用 `experience_load id=<id>` 加载完整经验单
```

### 4.4 ExperienceStore 类

**文件**: `src/robotics/ExperienceStore.ts`

```typescript
export class ExperienceStore {
  private readonly dir: string   // ~/.claude/meta-agent/robotics/experiences/
  private readonly indexPath: string  // <dir>/EXPERIENCE_INDEX.md

  /** 写入新经验，返回 ID */
  async write(entry: Omit<ExperienceEntry, 'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'>): Promise<string>

  /** 关键词 + tag + domain 搜索，返回匹配的索引行（不含 fullReport） */
  async search(query: ExperienceSearchQuery): Promise<ExperienceEntry[]>

  /** 按 ID 加载完整经验单（含 fullReport） */
  async load(id: string): Promise<ExperienceEntry | null>

  /** 重建 EXPERIENCE_INDEX.md（按 domain 分组，按 createdAt 倒序） */
  async rebuildIndex(): Promise<void>

  /** 加载索引 Markdown 全文（注入 R2 节使用） */
  async loadIndexMarkdown(): Promise<string>

  /** 列出所有 IDs（用于统计、导出） */
  async listIds(): Promise<string[]>
}

export interface ExperienceSearchQuery {
  domain?: RoboticsDomain
  tags?: string[]        // AND 语义
  algorithm?: string
  robot?: string
  keyword?: string       // 在 title + problem + solution 中全文搜索
  successOnly?: boolean
  limit?: number         // 默认 10
}
```

### 4.5 与 Memory 体系的边界

| 维度 | Memory (MEMORY.md) | ExperienceStore |
|------|-------------------|-----------------|
| 写入方 | 主 Agent | 主 Agent + sub-agent 自动写入 |
| 粒度 | 用户偏好、领域知识摘要 | 具体实验/任务结论，含指标 |
| 格式 | Markdown 自由文本 | 强结构化 JSON + 可选 Markdown fullReport |
| 检索 | 相关性召回（findRelevantMemories） | 结构化过滤 + 关键词 |
| 生命周期 | 全局持久 | 全局持久，但可按 robot/project 过滤 |

---

## 5. 多 Agent 专家体系

### 5.1 专家角色定义

```typescript
// src/robotics/agents/types.ts

export type RoboticsAgentRole =
  | 'orchestrator'      // 总协调，不直接执行
  | 'paper_search'      // 论文检索与方向分析
  | 'experiment'        // 实验执行（强隔离）
  | 'code'              // 算法实现、代码修改
  | 'analysis'          // 数据分析、结果解读
  | 'deployment'        // 工程化、部署、集成

export interface RoboticsAgentSpec {
  role: RoboticsAgentRole
  /** 默认允许的工具集（名称列表） */
  defaultAllowedTools: string[]
  /** 系统提示模板路径（相对于 src/robotics/agents/prompts/） */
  systemPromptTemplate: string
  /** 最大轮次 */
  maxTurns: number
  /** 是否强制实验隔离（experiment role = true） */
  isolateExperiments: boolean
  /** 子任务完成后是否自动写入 ExperienceStore */
  autoWriteExperience: boolean
}
```

### 5.2 各专家配置

#### OrchestratorAgent（主 Agent 本身，mode='robotics'）

- **职责**: 任务分解、子 Agent 调度、进度汇总、向用户报告
- **工具**: 全套标准工具 + robotics 工具集
- **不做**: 不直接跑实验、不直接搜索论文（委托给专家）
- **context 策略**: 只消费子 Agent 的 `structuredSummary`，不拉取实验日志

#### PaperSearchAgent

```
允许工具: web_search, web_fetch, experience_write, file_write (摘要输出)
系统提示重点:
  - 搜索 arXiv / IEEE Xplore / Semantic Scholar
  - 按算法创新点、实验结果、适用场景结构化输出
  - 每篇论文输出标准化的 PaperSummary（title/authors/year/key_contribution/limitations）
  - 完成后将"文献调研经验"写入 ExperienceStore
maxTurns: 30
autoWriteExperience: true
```

#### ExperimentAgent（强隔离）

```
允许工具: bash, read_file, write_file, glob, grep, experience_write
不允许: web_*, mcp_*, ask_user, send_message
系统提示重点:
  - 按 ExperimentSpec 执行单个实验
  - 详细日志写入 experiments/<task_id>/raw_log.md（自用）
  - 最终输出 ExperimentSummary JSON（返回主 Agent）
  - 自动调用 experience_write 写结论
maxTurns: 60  (实验可能需要多轮调试)
isolateExperiments: true
autoWriteExperience: true
```

#### CodeAgent

```
允许工具: bash, read_file, write_file, edit_file, glob, grep
系统提示重点:
  - 实现具体算法（给出精确文件路径 + 规范要求）
  - 运行单元测试验证
  - 代码提交前做 diff 自检
maxTurns: 40
autoWriteExperience: false (由 orchestrator 决定是否记录)
```

#### AnalysisAgent

```
允许工具: bash, read_file, write_file, glob, experience_search, experience_load
系统提示重点:
  - 读取实验原始结果（JSON/CSV）
  - 统计分析：均值/方差/显著性检验
  - 与历史经验对比（通过 experience_search 拉取参照）
  - 输出 AnalysisReport（结构化 + Markdown 可读）
maxTurns: 20
```

#### DeploymentAgent

```
允许工具: bash, read_file, write_file, edit_file, glob, experience_search
系统提示重点:
  - 将算法集成进 ROS2 / 固件 / 部署包
  - 运行集成测试
  - 记录部署依赖、版本约束到 ExperienceStore
maxTurns: 40
autoWriteExperience: true
```

### 5.3 子 Agent 调度策略

```
串行 (默认):
  paper_search → code → experiment → analysis → deployment

并行 (可选，通过 SubAgentBridge 并发 spawn):
  paper_search ┐
  experiment_1  ├─ Promise.all ─→ analysis → deployment
  experiment_2 ┘

主 Agent 调度决策树:
  if (需要文献支撑) → spawn PaperSearchAgent
  if (需要验证想法) → spawn ExperimentAgent (隔离)
  if (实验通过) → spawn CodeAgent → spawn DeploymentAgent
  if (任意失败) → spawn AnalysisAgent 分析原因 → 更新规划
```

---

## 6. 实验隔离模式 (Noise Isolation)

### 6.1 问题定义

机器人实验会产生大量噪音信息：
- 硬件连接日志、电机驱动调试输出
- 失败尝试的中间状态（10 次调参失败只有最后 1 次有效）
- 大量 ROS topic 数据、传感器数据片段

这些内容不应该进入主 Agent 上下文，否则会：
1. 消耗大量 token，压缩有效上下文空间
2. 干扰主 Agent 的决策推理
3. 导致主 Agent "陷入"细节而忘记全局目标

### 6.2 隔离架构

```
主 Agent Context
│
│  spawnSubAgent({
│    role: 'experiment',
│    config: {
│      taskDescription: <ExperimentSpec>,
│      allowedTools: ['bash','read_file','write_file','experience_write'],
│      maxTurns: 60,
│      returnFormat: 'structured_summary_only'   // ← 关键
│    }
│  })
│
▼
ExperimentAgent (sub-agent session)
├─ 轮1-59: 执行实验，写 raw_log.md，调参，失败重试...
│          (所有过程信息留在 sub-agent context 内)
└─ 轮60 (finalReport 阶段):
    1. 调用 experience_write 写入 ExperienceStore
    2. 生成 ExperimentSummary（结构化，见下方）
    3. SubAgentRunner 将 summary 作为 result.summary 返回

主 Agent 收到:
  SubAgentRecord.result.summary = JSON.stringify(ExperimentSummary)
  (不包含 raw_log.md 的任何内容)
```

### 6.3 ExperimentSummary 结构

```typescript
// src/robotics/types.ts

export interface ExperimentSpec {
  title: string
  hypothesis: string          // 本次实验要验证什么
  environment: string         // 软硬件环境描述
  procedure: string           // 实验步骤
  successCriteria: string     // 成功判断标准
  timeoutMs?: number          // 超时（默认 30 分钟）
}

export interface ExperimentSummary {
  specTitle: string
  outcome: 'success' | 'partial' | 'failure' | 'timeout'
  metrics: Record<string, number | string>  // e.g. { success_rate: 0.87, latency_ms: 45 }
  key_findings: string[]      // 3-7 条要点，每条 ≤ 150 chars
  failure_analysis?: string   // 失败原因分析（如果失败）
  next_suggestions: string[]  // 建议主 Agent 的后续动作
  experience_id?: string      // 已写入 ExperienceStore 的 ID
  durationMs: number
  turnsUsed: number
}
```

### 6.4 实验日志存储策略

```
~/.claude/meta-agent/robotics/experiments/
  <taskId>/
    spec.json          ← ExperimentSpec（输入）
    raw_log.md         ← 全量过程日志（ExperimentAgent 写入，主 Agent 不读取）
    structured_summary.json  ← ExperimentSummary（输出，主 Agent 只读这个）
```

**主 Agent 约定**：除非用户明确要求"查看实验日志"，否则不调用 `read_file` 读取 `raw_log.md`。  
这一约定通过 R3 节的 prompt 指令强制。

---

## 7. 新增 Robotics 工具集

### 7.1 工具列表

| 工具名 | 类别 | isConcurrencySafe | 说明 |
|--------|------|-------------------|------|
| `experience_write` | robotics | false | 写入新经验条目 |
| `experience_search` | robotics | true | 搜索经验（关键词/tag/domain） |
| `experience_load` | robotics | true | 按 ID 加载完整经验单 |
| `experiment_dispatch` | robotics | false | 向 SubAgentBridge 派发实验任务 |
| `paper_search` | robotics | true | 调用 PaperSearch sub-agent |
| `hardware_profile_read` | robotics | true | 读取机器人硬件档案 |
| `hardware_profile_write` | robotics | false | 更新机器人硬件档案 |

### 7.2 工具详细规范

#### `experience_write`

```typescript
// 输入 schema
{
  domain: RoboticsDomain,
  title: string,           // ≤ 80 chars
  problem: string,         // ≤ 500 chars
  solution: string,        // ≤ 800 chars
  outcome_success: boolean,
  outcome_summary: string, // ≤ 200 chars
  tags?: string[],
  algorithm?: string,
  robot?: string,
  metrics?: Record<string, number | string>,
  full_report?: string,    // 完整 Markdown 报告（可选，按需加载）
  source_task_id?: string,
  related_papers?: string[]
}

// 返回
{ id: string, indexed: true }
```

#### `experience_search`

```typescript
// 输入 schema
{
  keyword?: string,
  domain?: RoboticsDomain,
  tags?: string[],
  algorithm?: string,
  robot?: string,
  success_only?: boolean,
  limit?: number  // 默认 5，最大 20
}

// 返回：摘要列表（不含 full_report）
{ results: ExperienceEntry[], total_matched: number }
```

#### `experiment_dispatch`

```typescript
// 输入 schema
{
  title: string,
  hypothesis: string,
  environment: string,
  procedure: string,
  success_criteria: string,
  timeout_ms?: number,
  await_completion?: boolean  // false = fire-and-forget (默认 false)
}

// 返回
{ task_id: SubAgentTaskId, status: 'spawned' | 'completed', summary?: ExperimentSummary }
// 若 await_completion=true，阻塞直到 sub-agent 结束，返回 summary
// 若 await_completion=false，立即返回 task_id，后续通过 D-SubAgent 通知机制得知结果
```

#### `paper_search`

```typescript
// 输入 schema
{
  query: string,           // 搜索词
  domains?: string[],      // ['arxiv', 'ieee', 'semantic_scholar']
  year_from?: number,
  max_results?: number,    // 默认 10
  focus?: string           // 关注点，如 "sample efficiency", "sim-to-real"
}

// 内部实现: spawn PaperSearchAgent sub-agent（使用 web_search）
// 返回: PaperSummary[] （结构化论文摘要）
```

### 7.3 工具目录结构

```
src/robotics/tools/
  experience_write/
    index.ts
    prompt.md
  experience_search/
    index.ts
    prompt.md
  experience_load/
    index.ts
    prompt.md
  experiment_dispatch/
    index.ts
    prompt.md
  paper_search/
    index.ts
    prompt.md
  hardware_profile_read/
    index.ts
    prompt.md
  hardware_profile_write/
    index.ts
    prompt.md
  index.ts          ← createRoboticsTools(store, bridge) 工厂函数
```

---

## 8. 动态 Prompt 扩展节 R1–R5

Robotics 模式下，在现有 D1-D10 基础上叠加 R1-R5 节。

### R1 — Robotics 领域背景（memoized）

```markdown
## Robotics Algorithm Development Mode

You are operating in **robotics algorithm development mode**. Your responsibilities:

1. **Orchestrate specialist sub-agents** — delegate paper search, experiments, and deployment 
   to dedicated sub-agents. You synthesize results, not execute low-level tasks.
2. **Maintain noise isolation** — when experiments are dispatched, you receive only 
   `ExperimentSummary` (structured JSON). Do NOT read `raw_log.md` unless the user 
   explicitly requests debugging details.
3. **Leverage the Experience Store** — before starting any algorithm development, 
   search `experience_search` for relevant prior work. After completing any significant 
   task, ensure an experience entry is written.
4. **Progressive fidelity** — start with simulation experiments before hardware tests.
   Use `experiment_dispatch(await_completion=false)` for parallel hypothesis testing.

Current specialist agents available: PaperSearch, Experiment, Code, Analysis, Deployment
```

### R2 — Experience Index（DANGEROUS_uncached，每轮刷新）

```typescript
async function buildR2(store: ExperienceStore): Promise<string> {
  const indexMd = await store.loadIndexMarkdown()
  if (!indexMd) return ''
  return [
    '## Experience Store Index',
    '*Use `experience_search` or `experience_load <id>` to access entries.*',
    '',
    indexMd,
  ].join('\n')
}
```

截断策略：若索引超过 **2000 tokens**，只保留最近 30 条 + 各 domain 最高频 tag 摘要，并注明"使用 `experience_search domain=X` 查看更多"。

### R3 — 活跃实验注册表（DANGEROUS_uncached）

```markdown
## Active Experiments

| Task ID | Title | Status | Dispatched |
|---------|-------|--------|------------|
| task_abc123 | MPC 轨迹追踪调参 v3 | running (turn 12/60) | 2m ago |
| task_def456 | YOLOv8 检测延迟优化 | completed ✓ | 8m ago |

> ⚠ Do NOT read raw experiment logs. Wait for `SubAgentNotification` or use 
> `get_sub_agent_status` to check completion. Raw logs are at:
> `~/.claude/meta-agent/robotics/experiments/<task_id>/raw_log.md`
> Only read these if the user explicitly requests debugging.
```

### R4 — 硬件档案（memoized，按 robot 参数加载）

```markdown
## Hardware Profile: <robot_name>

**Platform**: Unitree Go2 / 6-DOF Arm / ...
**Compute**: Jetson Orin NX (16GB) + x86 workstation
**OS**: Ubuntu 22.04 + ROS2 Humble
**Actuators**: 12x servo, max torque 28 Nm
**Sensors**: 2x LiDAR (mid360), stereo camera (D435i), IMU (BMI088)
**Safety limits**: max_joint_vel=5 rad/s, workspace_radius=0.8m
**Known issues**: 
  - 前左腿关节2在低温下存在间隙，实验前需预热5分钟
  - 网络延迟 > 50ms 时控制器需切换到本地模式

*Update with `hardware_profile_write`*
```

### R5 — 开发进度摘要（DANGEROUS_uncached）

由主 Agent 主动维护一个 `robotics_progress.json`，记录当前任务树的高层状态（不含实验细节）。R5 节从该文件读取并注入。

```markdown
## Current Development Progress

**Project**: 四足机器人自适应步态算法
**Phase**: 实验验证 (3/5 完成)

✓ 文献调研 — 确认 CPG+RL 混合方案，参考 exp_171601_a3f2
✓ 基础实现 — CPG 步态生成器 v1.2，代码在 src/gait/cpg_controller.py
⏳ 实验验证 — 平坦地面测试通过(92%)，斜坡测试进行中
○ 泛化测试 — 未开始
○ 部署集成 — 未开始
```

---

## 9. RoboticsSession 封装类

### 9.1 设计思路

不继承 MetaAgentSession（避免破坏现有架构），而是采用**组合模式**，将 MetaAgentSession 作为内部成员，RoboticsSession 负责：
1. 创建 ExperienceStore 并挂载 R1-R5 动态节
2. 创建 HardwareProfile 实例
3. 向 createStandardTools 注入 robotics 工具集
4. 透传 MetaAgentSession 的 submit / stream / on 接口

### 9.2 类结构

```typescript
// src/robotics/RoboticsSession.ts

import { MetaAgentSession } from '../core/MetaAgentSession.js'
import { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import { ExperienceStore } from './ExperienceStore.js'
import { HardwareProfile } from './HardwareProfile.js'
import { createRoboticsTools } from './tools/index.js'
import { buildR1Section, buildR2Section, buildR3Section, buildR4Section, buildR5Section } from './dynamicSections.js'

export interface RoboticsSessionOptions {
  sessionId?: string
  robot?: string                    // 当前机器人型号，用于加载 R4
  model?: string
  apiKey?: string
  experienceDir?: string            // 默认 ~/.claude/meta-agent/robotics/experiences/
  hardwareProfileDir?: string
  extraTools?: MetaAgentTool[]
  maxTokens?: number
}

export class RoboticsSession {
  private readonly inner: MetaAgentSession
  private readonly bridge: SubAgentBridge
  private readonly experienceStore: ExperienceStore
  private readonly hardwareProfile: HardwareProfile

  constructor(options: RoboticsSessionOptions = {}) {
    // 1. 创建 MetaAgentSession (mode='robotics')
    this.inner = new MetaAgentSession({
      ...options,
      agentMode: 'robotics',
    })

    // 2. 创建配套基础设施
    this.bridge = new SubAgentBridge(this.inner.sessionId)
    this.experienceStore = new ExperienceStore(options.experienceDir)
    this.hardwareProfile = new HardwareProfile(options.hardwareProfileDir, options.robot)

    // 3. 注册 R1-R5 动态节（在 D10 之后）
    this.inner.sectionRegistry.register('R1', buildR1Section())
    this.inner.sectionRegistry.register('R2', () => buildR2Section(this.experienceStore))
    this.inner.sectionRegistry.register('R3', () => buildR3Section(this.bridge))
    this.inner.sectionRegistry.register('R4', () => buildR4Section(this.hardwareProfile))
    this.inner.sectionRegistry.register('R5', () => buildR5Section(this.inner.sessionId))
  }

  async init(): Promise<void> {
    // 并行初始化：工具 + experience store 索引
    const roboticsTools = await createRoboticsTools(this.experienceStore, this.bridge)
    await this.experienceStore.ensureIndex()
    await this.inner.init()
    this.inner.registerTools(roboticsTools)
  }

  /** 透传 submit — 主要入口 */
  async submit(userMessage: string): Promise<string>

  /** 透传流式接口 */
  stream(userMessage: string): AsyncIterable<MetaAgentStreamEvent>

  /** 清理：关闭 bridge，清理 cron jobs */
  async destroy(): Promise<void> {
    this.bridge.destroy()
    await this.inner.destroy()
  }

  /** 直接访问 ExperienceStore（测试 / 外部脚本用） */
  get experiences(): ExperienceStore { return this.experienceStore }

  /** 直接访问 SubAgentBridge（测试 / 外部脚本用） */
  get subagents(): SubAgentBridge { return this.bridge }
}
```

### 9.3 使用示例

```typescript
import { RoboticsSession } from '@meta-agent/runtime/robotics'

const session = new RoboticsSession({
  robot: 'unitree_go2',
  model: 'claude-opus-4-6',
})
await session.init()

const result = await session.submit(
  '我们需要在复杂地形上实现自适应步态，先搜索最新的 CPG+强化学习 相关论文，' +
  '然后设计一个验证实验，测试基础 CPG 步态在 15° 斜坡上的稳定性。'
)
console.log(result)

// 使用完毕后清理
await session.destroy()
```

---

## 10. 文件目录结构

```
packages/meta-agent-runtime/src/
├── core/
│   ├── dynamicPrompt.ts          # AgentMode 扩展 'robotics'
│   ├── memory/                   # 现有，不改动
│   └── ...
├── routing/
│   ├── ModeDetector.ts           # 新增 ROBOTICS_SIGNALS
│   └── ...
├── subagent/
│   ├── SubAgentBridge.ts         # 现有，不改动
│   └── ...
├── tools/
│   └── ...                       # 现有，不改动
│
└── robotics/                     ← 新增模块
    ├── index.ts                  # 公开 API barrel
    ├── types.ts                  # ExperienceEntry, ExperimentSpec, ExperimentSummary 等
    ├── RoboticsSession.ts        # 封装类
    ├── ExperienceStore.ts        # 经验存储核心
    ├── HardwareProfile.ts        # 硬件档案读写
    ├── dynamicSections.ts        # R1-R5 section builders
    ├── agents/
    │   ├── types.ts              # RoboticsAgentRole, RoboticsAgentSpec
    │   ├── specs.ts              # 各角色默认配置
    │   └── prompts/
    │       ├── paper_search.md
    │       ├── experiment.md
    │       ├── code.md
    │       ├── analysis.md
    │       └── deployment.md
    └── tools/
        ├── index.ts              # createRoboticsTools 工厂
        ├── experience_write/
        ├── experience_search/
        ├── experience_load/
        ├── experiment_dispatch/
        ├── paper_search/
        ├── hardware_profile_read/
        └── hardware_profile_write/

~/.claude/meta-agent/              ← 运行时数据（不在源码中）
├── memory/                        # 现有
│   ├── MEMORY.md
│   └── ...
└── robotics/
    ├── experiences/
    │   ├── EXPERIENCE_INDEX.md
    │   └── exp_*.json
    ├── hardware_profiles/
    │   └── <robot_name>.json
    └── experiments/
        └── <task_id>/
            ├── spec.json
            ├── raw_log.md
            └── structured_summary.json
```

**index.ts 公开 API：**

```typescript
// src/robotics/index.ts
export { RoboticsSession } from './RoboticsSession.js'
export { ExperienceStore } from './ExperienceStore.js'
export { HardwareProfile } from './HardwareProfile.js'
export { createRoboticsTools } from './tools/index.js'
export type {
  ExperienceEntry, ExperienceSearchQuery, ExperienceOutcome,
  ExperimentSpec, ExperimentSummary,
  RoboticsDomain, RoboticsAgentRole, RoboticsAgentSpec,
} from './types.js'
```

**主包 index.ts 新增导出：**

```typescript
// src/index.ts 末尾追加
// ── Robotics mode ─────────────────────────────────────────────────────────────
export {
  RoboticsSession,
  ExperienceStore,
  HardwareProfile,
  createRoboticsTools,
} from './robotics/index.js'
export type {
  ExperienceEntry, ExperienceSearchQuery, ExperienceOutcome,
  ExperimentSpec, ExperimentSummary,
  RoboticsDomain, RoboticsAgentRole, RoboticsAgentSpec,
} from './robotics/index.js'
```

---

## 11. 与现有系统的集成点

### 11.1 SubAgentBridge（直接复用，无修改）

`experiment_dispatch` 工具内部调用 `bridge.spawnSubAgent()`，ExperimentAgent 的 `taskDescription` 包含完整的 `ExperimentSpec` JSON。SubAgentBridge 的通知机制（CampaignEventBus）负责将完成/失败事件推送给主 Agent，主 Agent 通过 D-SubAgent 节接收。

### 11.2 Memory 系统（协同但不混用）

- Memory 写入（现有 `memory_write` 工具）：记录用户偏好、项目高层方向
- ExperienceStore 写入：记录具体实验/任务结论

两者在 prompt 中并列展示（D1b + R2），主 Agent 自行决策用哪个检索。

### 11.3 ProvenanceTracker（透明集成）

ExperienceStore 在 `write()` 时，可选地向 ProvenanceTracker 记录一条 provenance：

```typescript
await provenanceTracker.record({
  id: makeProvenanceId(),
  tool: 'experience_write',
  inputs: [{ type: 'task', id: entry.sourceTaskId ?? 'manual' }],
  outputs: [{ type: 'experience', id: entry.id }],
  timestamp: Date.now(),
})
```

### 11.4 CampaignStateStore（可选桥接）

如果机器人项目需要 DOE（设计实验规划），可将 `robotics` 模式与 `campaign` 模式叠加：

```typescript
// RoboticsSession 可选挂载 CampaignStateStore
if (options.enableDOE) {
  this.campaignStore = new CampaignStateStore(sessionId)
  // 每次实验 → DesignPoint + EvaluationResult
}
```

这作为 Phase 2 功能，Phase 1 不实现。

### 11.5 SessionRouter 修改

```typescript
// src/routing/ModeDetector.ts
// 在现有检测逻辑之后追加 robotics 分支
if (roboticsScore >= ROBOTICS_THRESHOLD) {
  return { mode: 'robotics', confidence: 'high', signals: matchedSignals }
}
```

SessionRouter 的优先级：`robotics` > `campaign` > `agentic` > `direct`（当 robotics 信号强时直接切换，不降级到 campaign）。

---

## 12. 数据流全景图

```
用户输入
   │
   ▼
RoboticsSession.submit()
   │
   ▼
MetaAgentSession.submit()
   │── 组装系统提示 ──────────────────────────────────────────────────────
   │   D1a memory_guidance (cached)
   │   D1b memory_content (MEMORY.md + recalled topics)
   │   D2  env_info
   │   D3  language
   │   D4  current_mode = "robotics"
   │   D4a engineering_standards
   │   R1  robotics_domain (cached)       ← NEW
   │   R2  experience_index (uncached)    ← NEW (EXPERIENCE_INDEX.md)
   │   R3  active_experiments (uncached)  ← NEW (SubAgentBridge 活跃任务)
   │   R4  hardware_profile (cached)      ← NEW (当前机器人档案)
   │   R5  development_progress (uncached)← NEW (进度摘要)
   │   D-SubAgent notifications           ← 子 Agent 完成通知
   │──────────────────────────────────────────────────────────────────────
   │
   ▼
Anthropic API 推理
   │
   ├─ 工具调用: experience_search ──→ ExperienceStore.search() ──→ 结果
   │
   ├─ 工具调用: experiment_dispatch ─→ SubAgentBridge.spawnSubAgent()
   │                                        │
   │                              ExperimentAgent (isolated)
   │                                        │
   │                              ┌─────────┴──────────┐
   │                              │  内部执行 (60 turns)│
   │                              │  bash / file tools  │
   │                              │  写 raw_log.md      │
   │                              └─────────┬──────────┘
   │                                        │ 完成
   │                                        ▼
   │                              experience_write → ExperienceStore
   │                              返回 ExperimentSummary (JSON, ≤ 2KB)
   │                                        │
   │                              CampaignEventBus.emit('subagent:completed')
   │                                        │
   │                              SubAgentBridge._onCompleted()
   │                                        │
   │                              pendingNotifications.push(summary)
   │                                        │
   │              下一轮 submit → D-SubAgent section 注入通知
   │
   ├─ 工具调用: experience_write ──→ ExperienceStore.write() → 更新索引
   │
   └─ 最终文本回复 ──→ 用户
```

---

## 13. 分阶段实施计划

### Phase 1（核心功能，约 3-4 天）

**优先级：必须实现**

1. `src/robotics/types.ts` — 所有类型定义
2. `src/robotics/ExperienceStore.ts` — 核心存储（write / search / load / rebuildIndex）
3. `src/robotics/tools/` — 5 个工具（experience_write/search/load, experiment_dispatch, paper_search）
4. `src/core/dynamicPrompt.ts` — 扩展 AgentMode + R1/R2 节
5. `src/robotics/dynamicSections.ts` — R1-R5 builder 函数
6. `src/robotics/RoboticsSession.ts` — 封装类
7. `src/robotics/index.ts` + `src/index.ts` 导出更新

**验收标准**：
```typescript
const s = new RoboticsSession({ robot: 'test_bot' })
await s.init()
const r = await s.submit('搜索 SLAM 相关经验')
assert(r.includes('experience'))
await s.destroy()
```

### Phase 2（完整化，约 2 天）

8. `src/robotics/HardwareProfile.ts` — 硬件档案
9. `src/robotics/tools/hardware_profile_*.ts` — 硬件工具
10. `src/routing/ModeDetector.ts` — robotics 信号检测
11. R3/R4/R5 动态节完整实现
12. `src/robotics/agents/specs.ts` — 各专家角色完整系统提示

### Phase 3（增强，按需）

13. DOE 桥接（与 CampaignStateStore 集成）
14. ExperienceStore 向量嵌入扩展（用于语义检索）
15. 实验并行调度优化（多个 ExperimentAgent 并发）
16. 经验质量评分机制（成功率、被引用次数）

---

## 14. 开放问题与后续决策

### Q1: experience_search 的检索质量

**当前方案**：关键词字符串匹配 + tag 过滤  
**问题**：`keyword='轨迹跟踪'` 无法匹配 `'trajectory tracking'`  
**选项 A**：在 tags 中强制双语标注  
**选项 B**：集成 Haiku 嵌入（调用 `askClaude()` 做语义匹配）  
**建议**：Phase 1 用选项 A（简单可控），Phase 3 升级为选项 B

### Q2: ExperimentAgent 超时策略

ExperimentAgent `maxTurns=60` 但实验本身可能需要更长时间（如 ROS 仿真跑 1 小时）。  
**建议**：在 `ExperimentSpec` 中增加 `timeoutMs`，ExperimentAgent 内部用 `createCronJob` 定时写进度检查点，超时后优雅退出并写部分结果。

### Q3: EXPERIENCE_INDEX.md 大小控制

随着时间推移，索引可能超过 2000 tokens。  
**建议**：实现分页索引（EXPERIENCE_INDEX_1.md, _2.md...）+ 智能截断策略（仅展示近 30 天 + 各 domain Top 3）。

### Q4: 多机器人项目隔离

当用户同时开发多个机器人项目时，经验条目可能混用。  
**建议**：在 ExperienceSearchQuery 加 `robot` 字段（已有），约定同一项目统一用相同 `robot` 字符串即可，Phase 1 不做物理隔离。

### Q5: 实验日志保留策略

`raw_log.md` 可能很大（几十 MB），长期积累占磁盘。  
**建议**：默认保留 7 天，超期自动删除 raw_log.md（保留 structured_summary.json）。ExperimentAgent 在写入时记录 `expiresAt`，RoboticsSession.init() 做清理扫描。

---

*文档结束 — 如需调整任何模块边界、接口设计或实施优先级，请在此基础上评审。*
