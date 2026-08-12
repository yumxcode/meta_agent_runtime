# Workflow 系统设计 — As-Built 参考

> 本文档描述**当前代码实际状态**，不是规划文档。  
> 最后更新：2026-05

---

## 目录

1. [设计原则与文件命名](#1-设计原则与文件命名)
2. [AGENT.md 格式规范](#2-agentmd-格式规范)
3. [WorkflowLoader — 发现与加载](#3-workflowloader--发现与加载)
4. [WorkflowParser — 解析](#4-workflowparser--解析)
5. [WorkflowStateStore — 状态持久化](#5-workflowstatestore--状态持久化)
6. [W1 动态 Prompt 节](#6-w1-动态-prompt-节)
7. [Workflow 工具集](#7-workflow-工具集)
8. [内置模板](#8-内置模板)
9. [文件布局](#9-文件布局)

---

## 1. 设计原则与文件命名

### 1.1 核心原则

```
Workflow = 一个 Markdown 文件
模式识别 = SessionRouter 识别 mode
Workflow 注入 = WorkflowLoader 找到对应文件 → D1c 加载全文 + W1 显示执行状态
阶段推进 = WorkflowStateStore 持久化当前阶段 → 门控工具验证后推进
```

代码只负责**加载机制**和**状态存储**，**业务逻辑（阶段定义/门控标准/输出物）全部在 Markdown 文件中**。新增一个 workflow，只需新增一个 .md 文件，零代码改动。

### 1.2 文件命名

| 配置目录 | `.meta-agent/` |
|---------|---------------|
| 项目级 workflow | `<project>/.meta-agent/AGENT.md` 或 `<project>/AGENT.md` |
| Mode 专属覆盖 | `<project>/.meta-agent/workflows/<mode>.md` |
| 用户全局自定义 | `~/.meta-agent/workflows/<mode>.md` |
| 包内置默认 | `src/workflow/templates/<mode>.md` |
| 运行时状态 | `<project>/.meta-agent/workflow-state.json` |

### 1.3 D1c 与 W1 的分工

| Section | 内容 | 加载时机 |
|---------|------|---------|
| D1c `agent_directives` | AGENT.md 全文（阶段定义、Focus、Gate 规则、输出物）| memoized，首次 submit |
| W1 `workflow_phase` | 运行时执行状态：当前阶段位置、gate 完成情况、advance 提示 | volatile，每轮重建 |

W1 **不重复**输出 phase 内容——phase 内容已在 AGENT.md 中，D1c 会完整加载。W1 只告诉模型"现在在哪、还差什么、下一步做什么"。

---

## 2. AGENT.md 格式规范

### 2.1 设计目标

- **人类可编辑**：纯 Markdown，HTML 注释作元信息载体
- **机器可解析**：约定固定的 header 格式，正则即可提取结构
- **提示词友好**：文件内容本身即高质量 prompt，D1c 直接注入

### 2.2 文件结构

```markdown
<!--
  AGENT.md — Meta-Agent Workflow Definition
  Mode: robotics
  Version: 1.0
-->

# <Workflow Title>

<全局上下文说明，在 WorkflowDefinition.globalContext 中保存>

---

## Phase: <phase-id> | <中文名> | <English Name>

<本阶段完整描述——Focus、Primary Agents、Key Activities 等>

### Gate Criteria
- [ ] REQUIRED: <必须满足的条件>
- [ ] REQUIRED: <另一个条件>
- [ ] APPROVAL: User confirms direction and approves advancing to next phase
- [ ] SUGGESTED: <建议但不强制的条件>

### Outputs
- `docs/algorithm_survey.md`
- ExperienceStore entries tagged with current project

---

## Phase: <next-phase-id> | ...
```

### 2.3 Gate 类型语义

| 类型 | 语义 | `workflow_advance` 行为 |
|------|------|------------------------|
| `REQUIRED` | 硬性要求，必须完成 | 未完成时 advance 返回错误 |
| `APPROVAL` | 需要用户确认 | 触发 `ctx.askUser()` 弹出确认对话 |
| `SUGGESTED` | 建议完成，不强制 | advance 不阻塞，仅在 `workflow_status` 中提示 |

### 2.4 解析规则（WorkflowParser）

**文件：** `src/workflow/WorkflowParser.ts`

| 提取目标 | 正则 / 规则 |
|----------|------------|
| mode | `Mode:\s*(\S+)` in HTML 注释 |
| version | `Version:\s*(\S+)` in HTML 注释 |
| title | `^#\s+(.+)$` |
| 全局上下文 | title 行之后、第一个 `## Phase:` 之前的所有文本 |
| 阶段 header | `^## Phase:\s*(\S+)\s*\|\s*(.+?)\s*\|\s*(.+)$` |
| gate 条目 | `^- \[([ x])\] (REQUIRED\|APPROVAL\|SUGGESTED):\s*(.+)$` |
| gate ID | 自动生成：`<phaseId>_gate_<index>`（0-based） |
| outputs | `### Outputs` 下的 `- ` 列表项 |

---

## 3. WorkflowLoader — 发现与加载

**文件：** `src/workflow/WorkflowLoader.ts`

### 3.1 `load(mode, projectDir)`

按优先级发现并解析 workflow 文件，返回 `WorkflowDefinition | null`：

```typescript
static load(mode: string, projectDir: string): WorkflowDefinition | null
```

**发现优先级（高 → 低）：**

```
① <project>/.meta-agent/AGENT.md           项目通用（覆盖所有层）
② <project>/.meta-agent/workflows/<mode>.md  项目 mode 专属
③ ~/.meta-agent/workflows/<mode>.md         用户全局自定义
④ src/workflow/templates/<mode>.md           包内置默认（随版本发布）
```

找到第一个存在的文件即停止搜索，性能 < 1ms（纯文件系统读取）。

### 3.2 `discover(mode, projectDir)`

只返回文件路径，不解析，`load()` 内部调用。

### 3.3 `loadRaw(projectDir)`

加载 AGENT.md 原始 Markdown 文本（不解析），供 D1c 注入使用。  
发现顺序与 `load()` 略不同（不带 mode 参数）：

```
① <project>/.meta-agent/AGENT.md
② <project>/AGENT.md
③ ~/.meta-agent/AGENT.md
```

---

## 4. WorkflowParser — 解析

**文件：** `src/workflow/WorkflowParser.ts`

```typescript
static parse(raw: string, sourceFile: string): WorkflowDefinition
```

生成的 `WorkflowDefinition` 结构（内存中，不写磁盘）：

```typescript
interface WorkflowDefinition {
  mode: string          // 对应的 AgentMode
  version: string
  title: string
  globalContext: string  // 全局说明文字
  phases: WorkflowPhase[]
  sourceFile: string    // 加载自哪个文件（调试用）
}

interface WorkflowPhase {
  id: string
  chineseName: string
  englishName: string
  index: number         // 0-based
  content: string       // 完整 Markdown 正文（所有子节，含 Gate Criteria）
  gateItems: GateItem[]
  outputs: string[]
}

interface GateItem {
  id: string            // '<phaseId>_gate_<N>'
  type: 'REQUIRED' | 'APPROVAL' | 'SUGGESTED'
  description: string
  completed: boolean    // 初始值来自文件（`[x]`），运行时由 StateStore 覆盖
}
```

---

## 5. WorkflowStateStore — 状态持久化

**文件：** `src/workflow/WorkflowStateStore.ts`  
**存储路径：** `<project>/.meta-agent/workflow-state.json`

### 5.1 状态结构

```typescript
interface WorkflowState {
  schemaVersion: '1.0'
  projectDir: string
  mode: string
  workflowSourceFile: string    // 加载时的 AGENT.md 路径

  currentPhaseId: string
  currentPhaseEnteredAt: number // ms 时间戳

  completedGateItems: string[]  // gate ID 数组（JSON 序列化后恢复为 Set 语义）

  phaseHistory: Array<{
    phaseId: string
    enteredAt: number
    completedAt?: number
    advancedBy: 'agent' | 'user'
  }>
}
```

### 5.2 API

| 方法 | 说明 |
|------|------|
| `read(projectDir)` | 读取状态，schema 校验，返回 `null` 如无状态 |
| `write(projectDir, state)` | 原子写入（`atomicWriteJson`） |
| `initialize(projectDir, definition)` | 首次初始化：从第一个 phase 开始 |
| `completeGateItem(projectDir, gateItemId)` | 标记 gate 完成（幂等） |
| `advancePhase(projectDir, definition, advancedBy)` | 推进到下一阶段（不做 gate 验证，调用方负责） |
| `checkGates(definition, state)` | 返回当前阶段 gate 状态（不写盘，纯计算） |

### 5.3 `checkGates()` 返回值

```typescript
interface GateCheckResult {
  canAdvance: boolean       // REQUIRED 全部完成时为 true
  blockedBy: GateItem[]     // REQUIRED 且未完成
  needsApproval: GateItem[] // APPROVAL 且未完成
  suggested: GateItem[]     // SUGGESTED 且未完成
}
```

---

## 6. W1 动态 Prompt 节

**文件：** `src/workflow/dynamicSection.ts`  
**缓存策略：** `DANGEROUS_uncachedSystemPromptSection`（每轮重建）

```typescript
export function buildW1Section(
  definition: WorkflowDefinition,
  getState: () => WorkflowState | null,  // getter 函数，每次调用获取最新状态
): SystemPromptSection
```

> **注意：** 第二个参数是 getter 函数（不是直接的 state 对象），确保每轮 resolve 时拿到最新状态。

### 6.1 W1 输出内容（当前实现）

```markdown
## Workflow Status: <title>
*Phase N / Total — <中文名> (<English Name>) — entered Xh ago*

### Gate Criteria
- [x] DONE: <已完成的 gate>
- [ ] REQUIRED: <未完成的必须 gate>
- [ ] APPROVAL: <待确认的 gate>
- [ ] SUGGESTED: <建议 gate>

> ⚠ N REQUIRED gate(s) remain. Run `workflow_complete_gate <gateId>` when met.
> **Next**: <下一阶段中文名> (<下一阶段英文名>)
```

**W1 不包含 phase content**（Focus、Primary Agents、Key Activities 等）——这些内容在 AGENT.md 中，D1c 已完整加载。

### 6.2 W1 返回 null 的情况

- `getState()` 返回 `null`（未初始化 workflow state）
- `currentPhaseId` 在 definition 中找不到

---

## 7. Workflow 工具集

**文件：** `src/workflow/tools/`  
工具由 `createWorkflowTools()` 工厂函数统一创建，在 RoboticsSession 初始化时注册。

### `workflow_status`

```
输入: {}
返回: 当前阶段信息 + 所有 gate 状态 + GateCheckResult
```

### `workflow_complete_gate`

```
输入: { gate_id: string, evidence?: string }
说明: 标记 gate 完成（幂等）
      验证 gate_id 属于当前阶段
      不验证 evidence 真实性（软门控，依赖模型诚实性）
```

### `workflow_advance`

```
输入: { confirmed?: boolean }
流程:
  1. checkGates() — 验证 REQUIRED gate 全部完成
  2. 未完成 → 返回错误（列出 blockedBy）
  3. 有 APPROVAL gate 且 confirmed != true → 调用 ctx.askUser() 请求用户确认
  4. 用户确认 → 自动标记 APPROVAL gates 完成
  5. WorkflowStateStore.advancePhase()
  6. 回调 onStateChange(newState)（W1 下次 resolve 时自动反映）
  7. 返回新阶段信息（前 20 行 content 作为预览）
```

### `workflow_list_phases`

```
输入: {}（无参数）
返回: 所有阶段的 id/中文名/英文名/gate数/当前阶段标记
isConcurrencySafe: true（只读）
```

---

## 8. 内置模板

**目录：** `src/workflow/templates/`

| 文件 | 用途 |
|------|------|
| `robotics.md` | 机器人算法开发：research → development → training → sim2real → deployment |
| `agentic.md` | 通用工具性任务：单阶段 execute（无多步 workflow） |

**robotics.md 的 5 个阶段：**

| Phase ID | 中文名 | 英文名 | Gate 数 |
|----------|-------|-------|---------|
| `research` | 算法研究 | Algorithm Research | 5 |
| `development` | 算法开发 | Algorithm Development | 6 |
| `training` | 训练探索 | Training Exploration | 6 |
| `sim2real` | Sim2Real 验证 | Sim-to-Real Validation | 7 |
| `deployment` | 工程化部署 | Engineering Deployment | 6 |

---

## 9. 文件布局

### 源码

```
src/workflow/
├── types.ts                   WorkflowDefinition, WorkflowPhase, GateItem, WorkflowState
├── WorkflowLoader.ts          发现 + 加载（load / discover / loadRaw）
├── WorkflowParser.ts          Markdown → WorkflowDefinition
├── WorkflowStateStore.ts      阶段状态持久化
├── dynamicSection.ts          buildW1Section
├── index.ts                   公开 API barrel
├── tools/
│   ├── index.ts               createWorkflowTools() 工厂
│   ├── workflow_status/
│   ├── workflow_complete_gate/
│   ├── workflow_advance/
│   └── workflow_list_phases/
└── templates/
    ├── robotics.md
    └── agentic.md
```

### 运行时数据

```
<project>/
├── .meta-agent/
│   ├── AGENT.md              用户定制 workflow（优先级最高）
│   └── workflow-state.json   阶段运行状态（自动维护）
│
└── AGENT.md                  备用位置（WorkflowLoader.loadRaw() 会查找）

~/.meta-agent/workflows/      用户全局自定义（跨项目共享）
  robotics.md
  ...
```

### RoboticsSession 集成

```typescript
// RoboticsSession 初始化 workflow 的伪代码
const definition = WorkflowLoader.load('robotics', projectDir)
if (definition) {
  const state = await WorkflowStateStore.read(projectDir)
               ?? await WorkflowStateStore.initialize(projectDir, definition)
  this._workflowState = state
  // W1 节通过 modeExtensions 注入
  const w1 = buildW1Section(definition, () => this._workflowState)
  // ... 工具注册
  tools.push(...createWorkflowTools(projectDir, definition, s => { this._workflowState = s }))
}
```

---

## 解耦效果

| 修改内容 | 代码改动 |
|---------|---------|
| 修改阶段数量 / 名称 / gate 标准 | 只改 AGENT.md |
| 新增 workflow（新 mode） | 新建 `templates/<mode>.md`，SessionRouter 加一个 case |
| 项目定制流程 | 用户在 `<project>/.meta-agent/AGENT.md` 覆盖 |
| 用户全局定制 | 写 `~/.meta-agent/workflows/<mode>.md` |

AGENT.md 本身是 Markdown，适合 git 管理和代码审查。团队可以把 AGENT.md 提交到项目仓库，共享同一套开发流程规范。
