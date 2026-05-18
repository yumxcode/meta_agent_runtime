# Workflow 系统设计 — AGENT.md 加载机制与阶段门控

> 基于 v1 + v2 方案的增量设计。  
> 核心思路：workflow = prompt 文件，通过加载机制注入，与代码完全解耦。  
> 文件命名与 CLAUDE.md 区分，使用 `AGENT.md` 置于 `.meta-agent/` 目录。

---

## 目录

1. [设计原则与文件命名](#1-设计原则与文件命名)
2. [AGENT.md 格式规范](#2-agentmd-格式规范)
3. [WorkflowLoader — 发现与加载](#3-workflowloader--发现与加载)
4. [WorkflowStateStore — 阶段状态持久化](#4-workflowstatestore--阶段状态持久化)
5. [W1 动态 Prompt 节](#5-w1-动态-prompt-节)
6. [阶段工具集](#6-阶段工具集)
7. [内置 Workflow 模板](#7-内置-workflow-模板)
8. [解耦效果验证](#8-解耦效果验证)
9. [文件变更清单](#9-文件变更清单)

---

## 1. 设计原则与文件命名

### 1.1 核心原则

```
Workflow = 一个 Markdown 文件
模式识别 = SessionRouter 识别 mode
Workflow 注入 = WorkflowLoader 找到对应文件 → W1 动态节注入 prompt
阶段推进 = WorkflowStateStore 持久化当前阶段 → 门控工具验证后推进
```

代码只负责**加载机制**和**状态存储**，**业务逻辑（阶段定义/门控标准/输出物）全部在 Markdown 文件中**。新增一个 workflow，只需新增一个 .md 文件，零代码改动。

### 1.2 文件命名决策

| 对比项 | Claude Code | Meta-Agent Runtime |
|--------|------------|-------------------|
| 配置目录 | `.claude/` | `.meta-agent/` |
| 项目级 workflow | `CLAUDE.md` | `AGENT.md` |
| Skills 目录 | `.claude/skills/` | `.meta-agent/skills/` (可沿用) |
| Settings | `.claude/settings.json` | `.meta-agent/settings.json` |

选用 `AGENT.md` 而非 `CLAUDE.md`：
- 语义更通用（"Agent 的工作规范"）
- 不会与 Claude Code 的 `CLAUDE.md` 冲突（两个工具可能同时存在于一个项目）
- 作为专属命名空间，便于工具链区分

### 1.3 发现优先级（三层覆盖）

```
优先级 高 → 低:

① <project>/.meta-agent/AGENT.md
   — 项目专属 workflow，完全覆盖其他层
   — 开发者为具体机器人项目定制的开发流程

② <project>/.meta-agent/workflows/<mode>.md
   — 项目内的 mode 专属覆盖
   — 例: .meta-agent/workflows/robotics.md

③ ~/.meta-agent/workflows/<mode>.md
   — 用户全局自定义（跨项目共享）
   — 用户把自己习惯的流程保存在家目录

④ <package>/src/workflows/templates/<mode>.md
   — 包内置默认模板（随版本发布）
   — 保底，零配置即可工作

找到第一个存在的文件即停止搜索。
```

发现逻辑是**纯文件读取**，零网络请求，< 1ms。

---

## 2. AGENT.md 格式规范

### 2.1 设计目标

- **人类可编辑**：纯 Markdown，无 YAML frontmatter，无 JSON 嵌入
- **机器可解析**：约定固定的 header 格式，正则即可提取结构
- **提示词友好**：文件内容本身就是高质量 prompt，加载后直接注入
- **无额外依赖**：不引入 js-yaml、frontmatter 解析库

### 2.2 文件结构

```markdown
<!--
  AGENT.md — Meta-Agent Workflow Definition
  Mode: robotics
  Version: 1.0
  Author: ...
-->

# <Workflow Title>

<一段总体说明，会注入到每个阶段的 prompt 中（全局上下文）>

---

## Phase: <phase-id> | <中文名> | <English Name>

<本阶段的角色定位和工作重点描述，自由 Markdown 文本>

### Focus
<本阶段的核心关注点>

### Primary Agents
<哪些 Agent 在本阶段起主导作用>

### Key Activities
<本阶段的主要工作内容>

### Gate Criteria
<!--
  门控标准。每行格式: - [ ] <TYPE>: <description>
  TYPE 取值:
    REQUIRED  — 硬性要求，必须完成才能推进
    APPROVAL  — 需要用户确认（workflow_advance 会触发 ask_user）
    SUGGESTED — 建议完成，不强制
  已完成的门控写成: - [x] REQUIRED: ...（WorkflowStateStore 追踪）
-->
- [ ] REQUIRED: <condition description>
- [ ] REQUIRED: <another condition>
- [ ] APPROVAL: User confirms direction and approves advancing to next phase

### Outputs
<!--
  本阶段结束时应该产出的文件/经验/结论
  供主智能体参照检查，不作强制验证
-->
- `docs/algorithm_survey.md`
- ExperienceStore entries tagged with current project

---

## Phase: <next-phase-id> | ...

...
```

### 2.3 解析规则（WorkflowParser）

| 需要提取的信息 | 正则/规则 |
|----------------|---------|
| workflow 元信息 | HTML 注释中 `Mode: xxx` `Version: xxx` |
| 全局上下文 | 第一个 `## Phase:` 之前的所有文本 |
| 阶段 ID / 名称 | `^## Phase:\s*(\S+)\s*\|\s*(.+?)\s*\|\s*(.+)$` |
| 阶段正文 | 两个 `## Phase:` 之间的所有内容 |
| 门控条目 | `^- \[([ x])\] (REQUIRED|APPROVAL|SUGGESTED):\s*(.+)$` |
| 输出物 | `### Outputs` 下的 `- ` 列表项 |

解析后生成 `WorkflowDefinition` 结构（内存中，不写磁盘）：

```typescript
// src/workflow/types.ts

export interface GateItem {
  id: string            // 自动生成: <phaseId>_gate_<index>
  type: 'REQUIRED' | 'APPROVAL' | 'SUGGESTED'
  description: string
  completed: boolean    // 从 WorkflowStateStore 读取
}

export interface WorkflowPhase {
  id: string            // e.g. 'research'
  chineseName: string   // e.g. '算法研究'
  englishName: string   // e.g. 'Algorithm Research'
  index: number         // 0-based
  content: string       // 完整的 Markdown 正文（注入 prompt 时使用）
  gateItems: GateItem[]
  outputs: string[]
}

export interface WorkflowDefinition {
  mode: string          // 对应的 AgentMode
  version: string
  title: string
  globalContext: string  // 全局说明（每个阶段都注入）
  phases: WorkflowPhase[]
  sourceFile: string    // 加载自哪个文件（调试用）
}
```

---

## 3. WorkflowLoader — 发现与加载

```typescript
// src/workflow/WorkflowLoader.ts

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { WorkflowDefinition } from './types.js'
import { WorkflowParser } from './WorkflowParser.js'

export class WorkflowLoader {
  /**
   * 发现并加载 workflow 文件。
   * 
   * @param mode    SessionMode，用于查找对应模板
   * @param projectDir  项目目录，用于查找 .meta-agent/AGENT.md
   * @returns WorkflowDefinition 或 null（当 mode 没有对应模板时）
   */
  static load(mode: string, projectDir: string): WorkflowDefinition | null {
    const candidatePath = WorkflowLoader._discover(mode, projectDir)
    if (!candidatePath) return null

    const raw = readFileSync(candidatePath, 'utf-8')
    return WorkflowParser.parse(raw, candidatePath)
  }

  /**
   * 按优先级查找 workflow 文件路径。
   * 返回第一个存在的文件路径，否则返回 null。
   */
  static _discover(mode: string, projectDir: string): string | null {
    const candidates = [
      // ① 项目级通用 AGENT.md
      join(projectDir, '.meta-agent', 'AGENT.md'),
      // ② 项目级 mode 专属
      join(projectDir, '.meta-agent', 'workflows', `${mode}.md`),
      // ③ 用户全局
      join(homedir(), '.meta-agent', 'workflows', `${mode}.md`),
      // ④ 包内置默认（与 src/ 同级的 workflows/templates/ 目录）
      join(WorkflowLoader._packageTemplatesDir(), `${mode}.md`),
    ]

    for (const p of candidates) {
      if (existsSync(p)) return p
    }
    return null
  }

  /**
   * 返回包内置模板目录（src/workflow/templates/）
   * 使用 import.meta.url 计算，避免 __dirname 在 ESM 中不可用。
   */
  private static _packageTemplatesDir(): string {
    // __filename equivalent in ESM
    const thisFile = fileURLToPath(import.meta.url)
    return join(dirname(thisFile), 'templates')
  }

  /**
   * 列出当前可用的 workflow 模板（供工具调用/调试）
   */
  static listAvailable(projectDir: string): Array<{
    mode: string
    source: 'project' | 'global' | 'builtin'
    path: string
  }> { /* ... */ }
}
```

### 3.1 WorkflowParser

```typescript
// src/workflow/WorkflowParser.ts

export class WorkflowParser {
  static parse(raw: string, sourceFile: string): WorkflowDefinition {
    const lines = raw.split('\n')

    // 1. 提取元信息（HTML 注释块）
    const modeMatch  = raw.match(/Mode:\s*(\S+)/)
    const verMatch   = raw.match(/Version:\s*(\S+)/)
    const titleMatch = raw.match(/^#\s+(.+)$/m)
    
    const mode    = modeMatch?.[1]  ?? 'unknown'
    const version = verMatch?.[1]   ?? '1.0'
    const title   = titleMatch?.[1] ?? 'Workflow'

    // 2. 分割阶段
    const phaseHeaderRe = /^## Phase:\s*(\S+)\s*\|\s*(.+?)\s*\|\s*(.+)$/
    const phaseStarts: number[] = []
    lines.forEach((line, i) => {
      if (phaseHeaderRe.test(line)) phaseStarts.push(i)
    })

    // 全局上下文 = title 之后、第一个 Phase 之前
    const firstPhaseStart = phaseStarts[0] ?? lines.length
    const globalContext = lines.slice(1, firstPhaseStart).join('\n').trim()

    // 3. 解析每个阶段
    const phases: WorkflowPhase[] = phaseStarts.map((start, idx) => {
      const end = phaseStarts[idx + 1] ?? lines.length
      const headerMatch = lines[start].match(phaseHeaderRe)!
      const [, id, chineseName, englishName] = headerMatch
      const content = lines.slice(start + 1, end).join('\n')

      // 解析门控条目
      const gateRe = /^- \[([ x])\] (REQUIRED|APPROVAL|SUGGESTED):\s*(.+)$/
      const gateItems: GateItem[] = []
      let gateIndex = 0
      for (const line of content.split('\n')) {
        const m = line.match(gateRe)
        if (m) {
          gateItems.push({
            id: `${id}_gate_${gateIndex++}`,
            type: m[2] as GateItem['type'],
            description: m[3].trim(),
            completed: m[1] === 'x',  // 文件中的初始状态，会被 StateStore 覆盖
          })
        }
      }

      // 解析输出物
      const outputs: string[] = []
      let inOutputsSection = false
      for (const line of content.split('\n')) {
        if (/^### Outputs/.test(line)) { inOutputsSection = true; continue }
        if (/^###/.test(line)) { inOutputsSection = false; continue }
        if (inOutputsSection && /^- /.test(line)) {
          outputs.push(line.replace(/^- /, '').trim())
        }
      }

      return { id, chineseName, englishName, index: idx, content, gateItems, outputs }
    })

    return { mode, version, title, globalContext, phases, sourceFile }
  }
}
```

---

## 4. WorkflowStateStore — 阶段状态持久化

与 `WorkflowDefinition`（模板，只读）分离：`WorkflowState` 追踪**运行时的可变状态**。

```typescript
// src/workflow/WorkflowStateStore.ts

export interface WorkflowState {
  schemaVersion: '1.0'
  projectDir: string
  mode: string
  workflowSourceFile: string

  currentPhaseId: string
  currentPhaseEnteredAt: number

  /** 已完成的门控条目 ID 集合 */
  completedGateItems: Set<string>  // 持久化为数组

  /** 阶段历史（审计用） */
  phaseHistory: Array<{
    phaseId: string
    enteredAt: number
    completedAt?: number
    advancedBy: 'agent' | 'user'
  }>
}

// 存储路径: <project>/.meta-agent/workflow-state.json
export class WorkflowStateStore {
  private static readonly FILENAME = 'workflow-state.json'

  static async read(projectDir: string): Promise<WorkflowState | null>
  static async write(projectDir: string, state: WorkflowState): Promise<void>

  /** 初始化：从第一个 phase 开始 */
  static async initialize(
    projectDir: string,
    definition: WorkflowDefinition,
  ): Promise<WorkflowState>

  /** 标记一个门控条目为完成 */
  static async completeGateItem(
    projectDir: string,
    gateItemId: string,
  ): Promise<WorkflowState>

  /** 推进到下一阶段（调用前必须验证门控） */
  static async advancePhase(
    projectDir: string,
    definition: WorkflowDefinition,
    advancedBy: 'agent' | 'user',
  ): Promise<{ newPhase: WorkflowPhase; state: WorkflowState }>

  /** 
   * 获取当前阶段的门控状态（合并 definition + state）
   * definition 提供 gate 定义，state 提供 completed 状态
   */
  static mergeGateStatus(
    definition: WorkflowDefinition,
    state: WorkflowState,
  ): WorkflowPhase & { allRequiredMet: boolean; hasApprovalGates: boolean }
}
```

### 4.1 门控验证逻辑

```typescript
// 在 workflow_advance 工具中调用

function checkGatesForAdvance(phase: WorkflowPhase, completedIds: Set<string>): {
  canAdvance: boolean
  blockedBy: GateItem[]       // REQUIRED 未完成的
  needsApproval: GateItem[]   // APPROVAL 未完成的
} {
  const blocked = phase.gateItems.filter(
    g => g.type === 'REQUIRED' && !completedIds.has(g.id)
  )
  const approval = phase.gateItems.filter(
    g => g.type === 'APPROVAL' && !completedIds.has(g.id)
  )
  return {
    canAdvance: blocked.length === 0,  // REQUIRED 全部完成才允许推进
    blockedBy: blocked,
    needsApproval: approval,
  }
}
```

---

## 5. W1 动态 Prompt 节

W1 是 Robotics Session 注册的新动态节，在 R1-R5 之前注入（作为最高优先级的指导信息）。

```typescript
// src/workflow/dynamicSection.ts

/**
 * W1 — Workflow Phase Context [DANGEROUS_uncached]
 *
 * 每轮重建，因为：
 * 1. 门控条目可以在任意 turn 被标记为完成
 * 2. 阶段可能在任意 turn 推进
 * 3. 内容量小（< 300 tokens），重建成本低
 */
export function buildW1Section(
  definition: WorkflowDefinition,
  state: WorkflowState,
): SystemPromptSection {
  return DANGEROUS_uncachedSystemPromptSection('workflow_phase', () => {
    return renderWorkflowSection(definition, state)
  })
}

function renderWorkflowSection(
  def: WorkflowDefinition,
  state: WorkflowState,
): string {
  const currentPhase = def.phases.find(p => p.id === state.currentPhaseId)
  if (!currentPhase) return ''

  const phaseNum  = currentPhase.index + 1
  const phaseTot  = def.phases.length
  const nextPhase = def.phases[currentPhase.index + 1]

  // 合并门控状态
  const gates = currentPhase.gateItems.map(g => ({
    ...g,
    completed: state.completedGateItems.has(g.id),
  }))
  const allRequiredDone = gates.filter(g => g.type === 'REQUIRED').every(g => g.completed)

  const gateLines = gates.map(g => {
    const check = g.completed ? '[x]' : '[ ]'
    const status = g.completed ? 'DONE' : g.type
    return `- ${check} ${status}: ${g.description}`
  })

  const lines: string[] = [
    `## Workflow: ${def.title}`,
    `*Phase ${phaseNum} / ${phaseTot} — entered ${formatAge(state.currentPhaseEnteredAt)}*`,
    '',
    `### Current Phase: ${currentPhase.chineseName} (${currentPhase.englishName})`,
    '',
    currentPhase.content.split('\n').slice(0, 30).join('\n'),  // 正文截前30行
    '',
    '### Gate Criteria',
    ...gateLines,
    '',
  ]

  if (allRequiredDone && !nextPhase) {
    lines.push('> ✅ All gates met. This is the final phase.')
  } else if (allRequiredDone) {
    lines.push(
      `> ✅ All REQUIRED gates met. Ready to advance to: **${nextPhase.chineseName}**.`,
      `> Run \`workflow_advance\` when ready.`,
    )
  } else {
    const remaining = gates.filter(g => g.type === 'REQUIRED' && !g.completed)
    lines.push(
      `> ⚠ ${remaining.length} REQUIRED gate(s) remain before advancing.`,
      `> Run \`workflow_complete_gate <gateId>\` when a criterion is met.`,
      `> Run \`workflow_status\` for details.`,
    )
  }

  if (nextPhase) {
    lines.push('', `### Next Phase: ${nextPhase.chineseName} (${nextPhase.englishName})`)
    // 只显示 Focus 段落作为预览
    const focusMatch = nextPhase.content.match(/### Focus\n([\s\S]+?)(?=\n###|$)/)
    if (focusMatch) lines.push(focusMatch[1].trim().split('\n').slice(0, 3).join('\n'))
  }

  return lines.join('\n')
}
```

### 5.1 实际注入效果（示例）

当前项目在第 2 阶段、部分门控完成时，W1 节看起来像这样：

```markdown
## Workflow: Robotics Algorithm Development
*Phase 2 / 5 — entered 3 hours ago*

### Current Phase: 算法开发 (Algorithm Development)

**Focus**: Implement the selected CPG+RL hybrid algorithm. Main agent leads code
implementation; CodeAgent sub-agents handle module-level work in parallel branches.

**Primary Agents**: CodeAgent (specialist), Main (integration)
**Recommended tools**: bash, write_file, edit_file, experience_search, git tools

### Gate Criteria
- [x] DONE: Algorithm design document written (docs/algorithm_decision.md)
- [x] DONE: Base class skeleton implemented (src/gait/cpg_base.py)
- [ ] REQUIRED: Unit tests passing (target: ≥ 90% coverage on core classes)
- [ ] REQUIRED: Simulation run successful (≥ 1 full episode without crash)
- [ ] APPROVAL: User confirms implementation is ready for training phase

> ⚠ 2 REQUIRED gate(s) remain before advancing.
> Run `workflow_complete_gate research_gate_2` when a criterion is met.
> Run `workflow_status` for details.

### Next Phase: 训练探索 (Training Exploration)
Parallel ExperimentAgents run hyperparameter sweeps. Main agent coordinates
and analyzes results. Multiple sub-agents work on independent branches.
```

---

## 6. 阶段工具集

这组工具供**主智能体**使用，管理 workflow 的生命周期。

```typescript
// src/workflow/tools/index.ts
// 统一导出，在 createRoboticsTools 中注册

export const WORKFLOW_TOOLS = [
  'workflow_status',        // 查看当前阶段和门控状态
  'workflow_complete_gate', // 标记门控条目完成
  'workflow_advance',       // 推进到下一阶段（带门控验证）
  'workflow_list_phases',   // 列出所有阶段概览（isConcurrencySafe=true）
]
```

### `workflow_status`

```typescript
// 输入: {}（无参数）
// 返回: 当前阶段完整信息 + 每个门控条目的状态

{
  currentPhase: {
    id: "development",
    name: "算法开发",
    index: 1,
    enteredAt: 1716123456789,
  },
  gates: [
    { id: "development_gate_0", type: "REQUIRED", description: "...", completed: true },
    { id: "development_gate_1", type: "REQUIRED", description: "...", completed: false },
    { id: "development_gate_2", type: "APPROVAL", description: "...", completed: false },
  ],
  allRequiredMet: false,
  blockedBy: ["development_gate_1"],
  nextPhase: { id: "training", name: "训练探索" }
}
```

### `workflow_complete_gate`

```typescript
// 输入: { gate_id: string, evidence?: string }
// evidence: 可选的完成证据（如文件路径、指标值），会记录到 StateStore 中

// 内部逻辑：
// 1. 验证 gate_id 属于当前阶段
// 2. WorkflowStateStore.completeGateItem()
// 3. 返回更新后的门控状态

// 注意：不检查 evidence 的真实性，完全依赖主智能体的诚实性
// 这是软门控，约束来自 prompt 中的指导，不来自代码
```

### `workflow_advance`

```typescript
// 输入: { confirm?: boolean }
// 这是整个 workflow 系统中唯一可能触发 ask_user 的工具

// 内部逻辑：
// 1. checkGatesForAdvance() — 检查 REQUIRED 门控
// 2. 如果有 REQUIRED 未完成 → 返回错误，列出未完成项
// 3. 如果有 APPROVAL 门控 → 调用 ctx.askUser() 请求用户确认
//    (askUser 是注入到 ToolCallContext 的函数)
// 4. 用户确认后 → WorkflowStateStore.advancePhase()
// 5. 返回新阶段信息 + 新阶段的完整 prompt 内容（供主智能体知悉）

// 返回示例（成功推进时）:
{
  advanced: true,
  from: { id: "development", name: "算法开发" },
  to: { 
    id: "training",
    name: "训练探索",
    focus: "...",
    primaryAgents: ["ExperimentAgent x N (parallel)", "AnalysisAgent", "Main"],
    firstActivities: ["Launch initial hyperparameter sweep", "Set up experiment tracking"]
  }
}
```

### `workflow_list_phases`

```typescript
// 输入: {}
// 返回: 所有阶段的概览（id/name/gates数量/当前阶段标记）
// isConcurrencySafe: true（只读）

[
  { id: "research",    name: "算法研究",   status: "completed", gateCount: 4 },
  { id: "development", name: "算法开发",   status: "active",    gateCount: 5 },
  { id: "training",    name: "训练探索",   status: "pending",   gateCount: 3 },
  { id: "sim2real",    name: "Sim2Real",    status: "pending",   gateCount: 6 },
  { id: "deployment",  name: "工程化部署", status: "pending",   gateCount: 4 },
]
```

---

## 7. 内置 Workflow 模板

### 7.1 Robotics 模板

**文件**: `src/workflow/templates/robotics.md`

```markdown
<!--
  AGENT.md — Meta-Agent Workflow Definition
  Mode: robotics
  Version: 1.0
  Description: Standard workflow for robot algorithm development projects.
               Covers research → implementation → training → sim2real → deployment.
-->

# Robotics Algorithm Development Workflow

This workflow guides structured development of robot algorithms through five phases.
Each phase has clear focus areas, recommended agent configurations, and gate criteria
that must be satisfied before advancing.

**Core principles**:
- Noise isolation: keep experiment details in sub-agents; only summaries reach main
- Experience accumulation: write ExperienceStore entries at each phase boundary
- Git alignment: sub-agent branches track main; merge only validated code
- User checkpoints: advancing between major phases requires explicit user approval

---

## Phase: research | 算法研究 | Algorithm Research

This phase establishes the algorithmic direction for the project. The goal is to
survey existing approaches, identify gaps, and select a concrete implementation
strategy. Rushing past this phase leads to costly rework later.

### Focus
Literature survey, idea synthesis, hardware feasibility assessment, and direction
decision. The main agent orchestrates PaperSearch sub-agents and synthesizes findings.

### Primary Agents
- **PaperSearchAgent** (lead): parallel searches across arXiv, IEEE, Semantic Scholar
- **Main**: synthesizes papers, identifies contradictions, makes decisions

### Recommended Tools
`paper_search`, `experience_search`, `experience_write`, `write_file`

### Key Activities
- Search recent papers (last 3 years) in the target algorithm domain
- Identify 3–5 candidate approaches with pros/cons
- Cross-reference with ExperienceStore for prior lessons on this domain
- Assess hardware feasibility against HardwareProfile constraints
- Write a concise decision document

### Gate Criteria
- [ ] REQUIRED: At least 5 relevant papers reviewed and summarized
- [ ] REQUIRED: Algorithm direction documented in docs/algorithm_decision.md
- [ ] REQUIRED: Hardware feasibility assessed (confirm approach works on target platform)
- [ ] REQUIRED: ExperienceStore entries created for key papers/insights
- [ ] APPROVAL: User reviews docs/algorithm_decision.md and confirms direction

### Outputs
- `docs/algorithm_survey.md` — paper summaries with structured fields
- `docs/algorithm_decision.md` — chosen approach, rationale, risk assessment
- ExperienceStore entries tagged with `[project]` and relevant algorithm tags

---

## Phase: development | 算法开发 | Algorithm Development

Core implementation phase. Translate the selected algorithm from paper to working
code. Sub-agents handle module-level implementation in parallel git branches;
main agent owns integration and the overall code architecture.

### Focus
Code structure design, module implementation, unit testing, and integration.
Parallel CodeAgent sub-agents work on independent modules. Main agent integrates
and ensures code quality.

### Primary Agents
- **CodeAgent** (specialist, x1–3 parallel): implements individual modules
- **Main**: architecture decisions, code review, integration

### Recommended Tools
`bash`, `write_file`, `edit_file`, `glob`, `grep`, `experience_search`,
`experiment_dispatch` (for quick smoke tests), git tools

### Key Activities
- Define code architecture and module boundaries before spawning sub-agents
- Spawn CodeAgent sub-agents for each major module (separate git branches)
- Implement unit tests alongside code (not after)
- Integrate modules on main branch; resolve conflicts explicitly
- Run smoke test to confirm end-to-end pipeline works

### Gate Criteria
- [ ] REQUIRED: Code architecture documented (module diagram or README)
- [ ] REQUIRED: All core modules implemented (verify with glob/tree)
- [ ] REQUIRED: Unit test coverage ≥ 85% on core classes
- [ ] REQUIRED: End-to-end smoke test passes in simulation
- [ ] SUGGESTED: Code reviewed by user or second CodeAgent pass
- [ ] APPROVAL: User confirms implementation quality before training begins

### Outputs
- `src/` — algorithm implementation code
- `tests/` — unit and integration tests
- `docs/architecture.md` — module structure and dependencies

---

## Phase: training | 训练探索 | Training Exploration

Systematic exploration of hyperparameter and design choices via parallel
ExperimentAgents. Each experiment runs in an isolated sub-agent with its own
git branch. Main agent coordinates, analyzes, and selects the best configuration.

### Focus
Hyperparameter sweep, architecture ablation, and training convergence. Multiple
ExperimentAgents run simultaneously. AnalysisAgent synthesizes results. Noise from
individual training runs stays inside sub-agents; only structured summaries surface.

### Primary Agents
- **ExperimentAgent** (x3–8 parallel): each trains one configuration
- **AnalysisAgent**: statistical analysis of experiment results
- **Main**: designs sweep, monitors progress, selects winner

### Recommended Tools
`experiment_dispatch` (await_completion=false for parallel), `get_sub_agent_status`,
`experience_search`, `experience_write`, `git_diff_subagent`, `git_merge_subagent`

### Key Activities
- Design experiment matrix: identify key hyperparameters and ranges
- Dispatch experiments (use await_completion=false for parallel execution)
- Monitor via D-SubAgent notifications; do NOT read raw experiment logs
- When all complete: spawn AnalysisAgent with all structured summaries
- Write best-configuration experience entry; merge winning branch to main

### Noise Isolation Rules
> ⚠ Do NOT read raw experiment logs (worktree raw_log.md files).
> You receive only ExperimentSummary JSON. Trust the summary.
> If a summary seems suspicious, ask AnalysisAgent to verify, not you directly.

### Gate Criteria
- [ ] REQUIRED: At least 3 experiment configurations completed
- [ ] REQUIRED: AnalysisAgent report written (docs/training_analysis.md)
- [ ] REQUIRED: Best configuration identified with success metric ≥ target threshold
- [ ] REQUIRED: Winning model/config committed to main branch
- [ ] REQUIRED: ExperienceStore entry written with training lessons
- [ ] APPROVAL: User reviews training results and confirms readiness for sim2real

### Outputs
- `docs/training_analysis.md` — comparative analysis across experiments
- `checkpoints/best_model.*` — best training checkpoint
- ExperienceStore entries for each experiment configuration

---

## Phase: sim2real | Sim2Real 验证 | Sim-to-Real Validation

Bridge the gap between simulation and hardware. This is the highest-risk phase:
hardware damage is possible if safety limits are not respected. ExperimentAgents
are hardware-safety-constrained. Main agent defines test protocols carefully.

### Focus
Hardware boundary testing, domain randomization validation, safety limit verification,
and incremental real-world deployment. Move from simulation to hardware deliberately
and cautiously.

### Primary Agents
- **ExperimentAgent** (hardware variant, x1–2): runs physical hardware tests
- **Main**: test protocol design, safety review, result interpretation

### Safety Rules
> ⚠ ALWAYS load HardwareProfile before designing experiments.
> ⚠ Never exceed documented safety limits in any ExperimentSpec.
> ⚠ For untested configurations, start at 50% of the rated limit.
> ⚠ If hardware behaves unexpectedly, STOP and document before continuing.

### Recommended Tools
`hardware_profile_read`, `experiment_dispatch`, `experience_search`,
`experience_write`, `git tools`

### Key Activities
- Load and review HardwareProfile: safety limits, known issues, warm-up requirements
- Design incremental test protocol: start easy (flat surface) → escalate (slopes, obstacles)
- Run each test as an ExperimentAgent (hardware variant)
- Document anomalies immediately in ExperienceStore
- Cross-reference with sim results to identify sim-to-real gaps
- Tune domain randomization parameters to close the gap

### Gate Criteria
- [ ] REQUIRED: HardwareProfile loaded and safety limits reviewed
- [ ] REQUIRED: Test protocol reviewed (docs/sim2real_protocol.md)
- [ ] REQUIRED: Flat terrain test passes (hardware, success_rate ≥ target)
- [ ] REQUIRED: Challenging terrain test attempted and documented
- [ ] REQUIRED: All safety incidents documented in ExperienceStore
- [ ] REQUIRED: Sim-to-real gap analysis written (docs/sim2real_analysis.md)
- [ ] APPROVAL: User reviews hardware test results and approves deployment phase

### Outputs
- `docs/sim2real_protocol.md` — test sequence and criteria
- `docs/sim2real_analysis.md` — gap analysis and adjustments made
- ExperienceStore entries for each hardware experiment

---

## Phase: deployment | 工程化部署 | Engineering Deployment

Package the validated algorithm for production use. Focus on reliability,
reproducibility, and handoff documentation. DeploymentAgent handles integration
work; main agent ensures completeness and correctness.

### Focus
ROS2 / firmware integration, dependency documentation, deployment packaging,
and final system validation. Sub-agent (DeploymentAgent) handles integration;
main agent reviews and approves.

### Primary Agents
- **DeploymentAgent**: ROS2 node wrapping, integration testing, package creation
- **Main**: final validation, documentation review, sign-off

### Recommended Tools
`bash`, `write_file`, `edit_file`, `experience_search`, `experience_write`

### Key Activities
- Wrap algorithm in ROS2 node or target deployment interface
- Write dependency manifest (requirements.txt / package.xml / CMakeLists)
- Run integration test on hardware
- Write deployment guide
- Write final ExperienceStore entry summarizing the entire project

### Gate Criteria
- [ ] REQUIRED: ROS2 node / integration wrapper implemented and tested
- [ ] REQUIRED: Dependency manifest complete and reproducible
- [ ] REQUIRED: Integration test on hardware passes
- [ ] REQUIRED: Deployment guide written (docs/deployment.md)
- [ ] REQUIRED: Final project ExperienceStore entry written
- [ ] APPROVAL: User confirms deployment package is complete

### Outputs
- `deploy/` — deployment package
- `docs/deployment.md` — setup and usage guide
- ExperienceStore entry tagged as `project_complete`
```

### 7.2 其他内置模板（精简版）

**`src/workflow/templates/agentic.md`**（通用工具性任务）:
```markdown
<!-- Mode: agentic, Version: 1.0 -->
# General Agentic Workflow

## Phase: execute | 执行 | Execution
No multi-phase workflow needed. Execute the task directly.
### Gate Criteria
- [ ] REQUIRED: Task objective clearly understood
```

**`src/workflow/templates/campaign.md`**（DOE 实验设计）: 略（可参照现有 D4b/D10 节内容，将其外化为 AGENT.md 文件）。

---

## 8. 解耦效果验证

### 8.1 解耦矩阵

| 关注点 | 存储位置 | 修改方式 | 代码改动 |
|--------|---------|---------|---------|
| 阶段数量 | AGENT.md | 增/删 `## Phase:` 节 | 无 |
| 阶段名称 | AGENT.md | 修改 header 行 | 无 |
| 门控标准 | AGENT.md | 修改 `- [ ] REQUIRED:` 行 | 无 |
| 阶段描述/建议工具 | AGENT.md | 修改正文 | 无 |
| 添加新模式 workflow | 新建 `templates/<mode>.md` | 新文件 | 仅 SessionRouter 加一个 case |
| 项目定制流程 | `<project>/.meta-agent/AGENT.md` | 用户自己写 | 无 |
| 用户全局定制 | `~/.meta-agent/workflows/<mode>.md` | 用户自己写 | 无 |

### 8.2 典型扩展场景

**场景 A：为无人机项目定制 robotics workflow**

```bash
mkdir -p my_drone_project/.meta-agent
cp ~/.meta-agent/workflows/robotics.md my_drone_project/.meta-agent/AGENT.md
# 编辑 AGENT.md：
# - 修改 sim2real 阶段，加入飞控专项测试门控
# - 在 hardware profile 中注明飞控安全参数
# - 加一个 "flight_test" 阶段在 sim2real 之后
```

零代码改动，新 workflow 立即生效。

**场景 B：添加一个全新的 "data_science" 模式**

```bash
# 1. 在 SessionRouter 中加 'data_science' mode（5行代码）
# 2. 新建 src/workflow/templates/data_science.md（纯写作）
```

**场景 C：团队共享 workflow 规范**

```bash
# 将 AGENT.md 提交到项目 git 仓库，团队共享同一套 workflow 定义
git add .meta-agent/AGENT.md
git commit -m "define: standard robotics workflow for this project"
```

AGENT.md 本身就是 Markdown，适合 git 管理，适合 code review。

### 8.3 与现有 Skill 系统的对比

| 维度 | Skill（已有） | Workflow（新增） |
|------|-------------|----------------|
| 加载时机 | 主智能体主动调用 `skill load` | SessionRouter 启动时自动加载 |
| 注入位置 | 工具返回值（临时） | W1 系统 prompt 节（每轮可见） |
| 生命周期 | 单次对话轮次 | 整个项目生命周期 |
| 状态 | 无状态 | 有状态（阶段追踪） |
| 内容 | 具体任务技巧 | 宏观开发流程 |

两者互补：Skill 解决"怎么做一件事"，Workflow 解决"整体该怎么走"。

---

## 9. 文件变更清单

### 新增文件

```
src/workflow/
  types.ts                          ← WorkflowDefinition, WorkflowPhase, GateItem, WorkflowState
  WorkflowLoader.ts                 ← 发现与加载逻辑
  WorkflowParser.ts                 ← Markdown → WorkflowDefinition 解析器
  WorkflowStateStore.ts             ← 阶段状态持久化
  dynamicSection.ts                 ← buildW1Section
  tools/
    workflow_status/index.ts
    workflow_complete_gate/index.ts
    workflow_advance/index.ts
    workflow_list_phases/index.ts
    index.ts                        ← createWorkflowTools(definition, stateStore) 工厂
  templates/
    robotics.md                     ← 内置机器人算法开发 workflow（本文 §7.1）
    agentic.md                      ← 内置通用 workflow
    campaign.md                     ← 内置 DOE workflow

.meta-agent/                        ← 项目模板目录（文档约定，非源码）
  AGENT.md                          ← 项目级 workflow（用户创建）
  workflow-state.json               ← 运行时状态（自动生成）
  settings.json                     ← 项目配置（从 .claude/ 迁移/共存）
```

### 修改文件

```
src/robotics/RoboticsSession.ts
  + WorkflowLoader.load(mode, projectDir) 调用
  + WorkflowStateStore 初始化/恢复
  + sectionRegistry.register('W1', buildW1Section(...))
  + workflow tools 注入（createWorkflowTools）

src/robotics/tools/index.ts
  + createWorkflowTools 注册到 createRoboticsTools

src/routing/SessionRouter.ts
  + 'robotics' case 中：从 RoboticsSession 配置拿 workflowDef

src/index.ts
  + export WorkflowLoader, WorkflowStateStore, WorkflowParser
  + export type WorkflowDefinition, WorkflowPhase, GateItem, WorkflowState
```

### 运行时数据布局补充

```
<project>/
  .meta-agent/
    AGENT.md              ← 用户定制 workflow（可选，有则优先）
    workflow-state.json   ← 阶段运行状态（自动维护）

~/.meta-agent/workflows/  ← 用户全局自定义（可选）
  robotics.md
  ...

<npm package>/
  src/workflow/templates/ ← 内置默认（随包发布）
  robotics.md
  ...
```

---

## 设计关键决策汇总

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 文件名 | `AGENT.md` | 区别于 `CLAUDE.md`；语义清晰（Agent 的工作规范） |
| 配置目录 | `.meta-agent/` | 区别于 `.claude/`；命名空间隔离 |
| 格式 | 纯 Markdown，约定 header 格式 | 人类可编辑；无额外解析依赖；Git 友好 |
| 门控类型 | REQUIRED / APPROVAL / SUGGESTED | REQUIRED 是硬卡口；APPROVAL 触发 ask_user；SUGGESTED 是建议 |
| 门控执行方式 | 软门控（prompt 约束 + 工具验证） | 灵活性优先；过度刚性的硬门控会妨碍紧急情况下的人工干预 |
| 状态与定义分离 | WorkflowDefinition（只读）+ WorkflowState（可变） | 定义可以更新而不丢失运行状态 |
| W1 缓存策略 | DANGEROUS_uncached（每轮重建） | 门控完成事件随时可能发生；内容量小，重建成本低 |
| 内置模板位置 | `src/workflow/templates/` | 随包发布，零配置即可工作；用户可在上层覆盖 |
