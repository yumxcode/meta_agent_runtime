# Robotics Mode 增量设计 v2 — 路由、会话持久化与 Git 多智能体协同

> 在 `robotics-mode-design.md` (v1) 基础上的增量方案。  
> 涵盖三个核心议题：SessionRouter 扩展、跨日会话持久化、Git 分支协同。

---

## 目录

1. [SessionRouter 扩展：支持 `robotics` 模式检测](#1-sessionrouter-扩展)
2. [会话持久化：跨日无缝恢复](#2-会话持久化跨日无缝恢复)
3. [Git 分支协同：主智能体与子智能体的代码对齐](#3-git-分支协同)
4. [三者联动：完整生命周期流](#4-三者联动完整生命周期流)
5. [文件变更清单](#5-文件变更清单)

---

## 1. SessionRouter 扩展

### 1.1 现有架构梳理

现有路由已经是三层架构：

```
Layer 1: explicit hint   → 直接返回，零成本
Layer 2: LLM 分类         → 一次 Haiku 调用（300-500ms，$0.00012），超时5秒自动降级
        └─ fallback: 正则启发式 (ModeDetector.detectSync)
Layer 3: 环境信号         → 磁盘读取，active campaigns → 至少 agentic
```

已有的 Haiku 分类 prompt 涵盖 `direct / agentic / campaign` 三种模式。我们的改动是**最小侵入式**的：只需扩展这三个文件，不改动 `SessionRouter.ts` 的整体逻辑。

### 1.2 `types.ts` 变更

```typescript
// ── 原来 ──────────────────────────────────────────────────────────────────────
export type SessionMode = 'direct' | 'agentic' | 'campaign'

export const MODE_WEIGHT: Record<SessionMode, number> = {
  direct:   0,
  agentic:  1,
  campaign: 2,
}

// ── 变更后 ────────────────────────────────────────────────────────────────────
export type SessionMode = 'direct' | 'agentic' | 'campaign' | 'robotics'

export const MODE_WEIGHT: Record<SessionMode, number> = {
  direct:   0,
  agentic:  1,
  campaign: 2,
  robotics: 3,   // 最高权重：robotics 是 agentic+multi-agent 的超集
}

// DetectionConfidence 无需改动
```

**权重设计说明**：robotics=3 > campaign=2 > agentic=1 > direct=0。  
"永不降级"规则意味着：一旦检测到 robotics，不会被之后的 campaign 信号覆盖。  
robotics 模式隐含了 multi-agent + ExperienceStore，campaign 模式隐含了 DOE + KernelBridge，两者是不同维度的能力，不互斥，但 robotics 优先级更高。

### 1.3 `ModeDetector.ts` 变更

#### 变更1：LLM 分类 System Prompt 扩展

在现有 `LLM_SYSTEM_PROMPT` 后追加 robotics 说明与示例：

```typescript
// 在现有 VALID_MODES 定义后面追加
const VALID_MODES = new Set<string>(['direct', 'agentic', 'campaign', 'robotics'])

// LLM_DETECTION_MODEL 不变，仍用 Haiku

// LLM_SYSTEM_PROMPT 在三种模式描述后新增第四段 + 示例
const LLM_SYSTEM_PROMPT_ROBOTICS_ADDENDUM = `

robotics — The user is developing robot algorithms, coordinating hardware-software 
           integration, running multi-agent experiments, or working on any task 
           involving physical robots, ROS, trajectory planning, SLAM, locomotion,
           manipulation, sim-to-real transfer, or robot algorithm deployment.
           This mode enables multi-agent orchestration (paper search, experiment,
           code, deployment sub-agents) and an experience store for lessons learned.

Key distinctions from agentic:
- Single algorithm calculation → agentic
- Multi-step robot algorithm development with experiments → robotics
- ROS/SLAM/trajectory/locomotion/manipulation mentioned → robotics
- Hardware-in-the-loop testing → robotics
- "Sub-agent" for experiments or paper search → robotics

Additional examples:
User: 我要开发一个四足机器人的自适应步态算法
Mode: robotics

User: 搜索最新的 SLAM 论文，然后设计实验验证
Mode: robotics

User: 在仿真中测试 MPC 轨迹追踪，记录失败的调参经验
Mode: robotics

User: 实现一个基于 RL 的机械臂抓取算法并部署到 ROS2
Mode: robotics

User: 给我解释一下 CPG 步态生成器的原理
Mode: direct

User: 计算这个关节的最大扭矩
Mode: agentic

Reply with exactly one word: direct, agentic, campaign, or robotics.`

// 将两段 prompt 合并
const FULL_LLM_SYSTEM_PROMPT = LLM_SYSTEM_PROMPT + LLM_SYSTEM_PROMPT_ROBOTICS_ADDENDUM
```

#### 变更2：正则启发式降级路径新增 Tier 0 — ROBOTICS_ALWAYS

在 CAMPAIGN_ALWAYS（Tier A）之前插入优先级更高的 Tier 0：

```typescript
// ── Tier 0: ROBOTICS_ALWAYS (最高优先，Haiku 降级时使用) ────────────────────
//
// 明确机器人领域意图 + 开发/实验/部署动作 = robotics 无歧义
// 注: \b 不适用 CJK，中文模式用子串匹配

const ROBOTICS_ALWAYS: Array<{ pattern: RegExp; label: string }> = [
  {
    // ROS / ROS2 框架
    pattern: /\bROS2?\b|ros_?2?\b|roslaunch|roscpp|rclpy/i,
    label: 'ROS/ROS2 framework reference',
  },
  {
    // SLAM 算法族
    pattern: /\bSLAM\b|建图定位|激光雷达建图|lidar.{0,8}mapping|点云/i,
    label: 'SLAM / mapping',
  },
  {
    // 步态、运动规划
    pattern: /步态|gait|locomotion|trajectory.{0,15}robot|机器人.{0,10}轨迹|运动规划/i,
    label: 'robot motion planning / gait',
  },
  {
    // 机械臂
    pattern: /机械臂|robotic.?arm|manipulat|end.?effector|抓取算法/i,
    label: 'robotic arm / manipulation',
  },
  {
    // 强化学习 + 机器人
    pattern: /(?:强化学习|reinforcement.?learning|RL).{0,30}(?:robot|机器人|硬件|deploy)/i,
    label: 'RL for robotics',
  },
  {
    // 仿真到实物迁移
    pattern: /sim.?to.?real|仿真.{0,10}实物|仿真迁移|sim2real/i,
    label: 'sim-to-real transfer',
  },
  {
    // 动作 + 机器人算法开发
    pattern: /(?:开发|实现|部署|设计实验|验证|调参).{0,30}(?:机器人|robot|四足|六轴|无人机|UAV|drone)/i,
    label: 'robot algorithm development action',
  },
  {
    // 机器人 + 多子智能体 / 经验存储
    pattern: /(?:机器人|robot).{0,50}(?:子智能体|sub.?agent|经验存储|experiment.?agent)/i,
    label: 'robotics multi-agent pattern',
  },
]
```

#### 变更3：`detectSync` 流程插入 Tier 0

```typescript
static detectSync(prompt, hint = 'auto', hasTools = false): ModeDetectionResult {
  if (hint !== 'auto') { /* Layer 1 — unchanged */ }

  const toolSignal = hasTools ? { mode: 'agentic' as SessionMode, label: '...' } : null

  // ── 新增 Tier 0: ROBOTICS_ALWAYS ─────────────────────────────────────────
  const roboticsSignal = firstMatch(prompt, ROBOTICS_ALWAYS, 'robotics')
  if (roboticsSignal) {
    return {
      mode: 'robotics',
      confidence: 'heuristic',
      signals: [roboticsSignal, ...(toolSignal ? [toolSignal] : [])],
    }
  }

  // ── 以下保持原有 Tier A-F 不变 ─────────────────────────────────────────────
  const alwaysSignal = firstMatch(prompt, CAMPAIGN_ALWAYS, 'campaign')
  // ... 原有逻辑
}
```

#### 变更4：`_detectWithLLM` 中适配新的第四种模式

```typescript
private static async _detectWithLLM(prompt, hasTools, client): Promise<ModeDetectionResult> {
  try {
    const msg = await withTimeout(client.messages.create({
      model: LLM_DETECTION_MODEL,
      max_tokens: 10,  // 'robotics' 比 'campaign' 长，max_tokens 从5改10
      system: FULL_LLM_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    }), 5_000)

    const raw = msg.content[0]?.type === 'text'
      ? msg.content[0].text.trim().toLowerCase()
      : ''

    const llmMode: SessionMode = VALID_MODES.has(raw) ? raw as SessionMode : 'agentic'
    // hasTools → minimum agentic（不影响 robotics，robotics > agentic）
    const mode: SessionMode =
      hasTools && llmMode === 'direct' ? 'agentic' : llmMode

    return { mode, confidence: 'llm', signals: [{ mode, label: `Haiku: "${llmMode}"` }] }
  } catch {
    return ModeDetector.detectSync(prompt, 'auto', hasTools)
  }
}
```

### 1.4 `SessionRouter._createImpl` 变更

```typescript
private _createImpl(mode: SessionMode): SessionImpl {
  switch (mode) {
    case 'direct':
      return new MetaAgentSession({ ...this._cfgAsConfig(), tools: [] })
    case 'agentic':
      return new MetaAgentSession(this._cfgAsConfig())
    case 'campaign':
      return new KernelBridge(this._cfgAsConfig())
    case 'robotics':
      // RoboticsSession 包装 MetaAgentSession（组合模式）
      // 注意：RoboticsSession 实现了与 MetaAgentSession 相同的 SessionImpl 接口
      return new RoboticsSession({
        ...this._cfgAsConfig(),
        robot: this._cfg.robot,               // 新增配置项
        sessionPersistenceStore: this._persistenceStore,
      })
  }
}
```

### 1.5 设计决策：LLM 分类 vs 纯启发式的边界

```
用户输入
    │
    ├─ [有 Anthropic client] ─→ Haiku 分类（300-500ms）
    │       │                        │
    │       │                   [超时/错误] ─→ 降级到启发式
    │       │
    │       └─ Tier 0 启发式已预处理（作为 LLM 的兜底）
    │
    └─ [无 client，纯离线] ─→ 直接启发式
            │
            Tier 0 ROBOTICS_ALWAYS
            Tier A CAMPAIGN_ALWAYS
            Tier B DIRECT_OPENER
            Tier C/D CAMPAIGN_ACTION/VOCAB
            Tier E short question
            Tier F default agentic
```

**关键原则**：LLM 分类是"软决策"，Tier 0 的启发式匹配是"硬保障"。  
Haiku 的 prompt 包含语义示例，覆盖了启发式正则难以处理的复杂自然语言情境（如"帮我搭一个验证四足行走的实验框架"——没有明显关键词但语义是 robotics）。

---

## 2. 会话持久化：跨日无缝恢复

### 2.1 问题分析

当前架构的 session 生命周期是**进程内的**：
- `MetaAgentSession` / `RoboticsSession` 在内存中持有状态
- 进程退出后，会话状态丢失
- 第二天重新启动时，`SessionRouter` 再次调用 `ModeDetector.detect()` 重新判断模式
- 更严重的是：正在运行的子智能体（`SubAgentBridge`）、git worktree、活跃实验的上下文全部丢失

解决方案：引入 `RoboticsProjectStore`——以项目目录为 key 的轻量状态持久化层。

### 2.2 核心原则

- **以项目目录为持久化 key**：不需要用户手动指定 session ID，`cwd` 就是最自然的项目标识符
- **状态分层存储**：重量级数据（实验日志）留在现有位置，只持久化"导航状态"（mode、进度、git 上下文）
- **自动恢复，不强制**：`RoboticsSession.init()` 检查是否有可恢复的状态；如有则恢复，无则新建
- **时间窗口**：30 天内可恢复（可配置）

### 2.3 数据结构

```typescript
// src/robotics/persistence/types.ts

export interface RoboticsProjectState {
  schemaVersion: '1.0'

  // ── 标识 ──────────────────────────────────────────────────────────────────
  sessionId: string           // 首次创建时生成，此后不变
  projectDir: string          // 绑定的项目目录（绝对路径）
  robot?: string              // 机器人型号

  // ── 时间 ──────────────────────────────────────────────────────────────────
  createdAt: number           // 首次创建时间（ms）
  lastActiveAt: number        // 最近一次 submit() 时间

  // ── 进度（轻量级） ────────────────────────────────────────────────────────
  currentPhase?: string       // 用户可读的进度描述，如 "实验验证 3/5"
  progressNotes: string[]     // 主 Agent 主动写入的进度摘要（≤10条，滚动）

  // ── 子智能体状态 ──────────────────────────────────────────────────────────
  activeSubAgentTasks: ActiveSubAgentRecord[]
  completedSubAgentTaskIds: string[]

  // ── Git 协同状态（见 §3） ──────────────────────────────────────────────────
  git: RoboticsGitState
}

export interface ActiveSubAgentRecord {
  taskId: string
  role: RoboticsAgentRole
  title: string
  branchName?: string         // git 分支（如有）
  worktreePath?: string       // git worktree 路径
  spawnedAt: number
  lastCheckpointAt?: number
}

export interface RoboticsGitState {
  enabled: boolean            // 项目是否是 git repo
  mainBranch: string          // 'main' | 'master' | ...
  subAgentBranches: Record<string, string>  // taskId → branch name
  /** 主智能体在各 sub-agent 分叉时的 commit hash（用于 rebase 基准） */
  forkPoints: Record<string, string>         // taskId → commitHash
}
```

### 2.4 `RoboticsProjectStore` 类

```typescript
// src/robotics/persistence/RoboticsProjectStore.ts

/**
 * 以项目目录为 key 的持久化存储。
 * 
 * 文件布局:
 *   ~/.claude/meta-agent/robotics/projects/
 *     <hash(projectDir)>/
 *       state.json          ← RoboticsProjectState
 *       conversation.jsonl  ← 可选：消息历史（用于恢复对话上下文）
 * 
 * hash: SHA-1(absoluteProjectDir) 取前16位，避免路径特殊字符问题
 */
export class RoboticsProjectStore {
  private static readonly ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'projects')
  private static readonly RESUME_WINDOW_MS = 30 * 24 * 60 * 60 * 1000  // 30天

  /** 根据项目目录查找已有状态 */
  static async findByProjectDir(dir: string): Promise<RoboticsProjectState | null> {
    const stateFile = RoboticsProjectStore._stateFilePath(dir)
    try {
      const raw = await readFile(stateFile, 'utf-8')
      const state = JSON.parse(raw) as RoboticsProjectState
      if (state.schemaVersion !== '1.0') return null
      // 30天超时检查
      if (Date.now() - state.lastActiveAt > RoboticsProjectStore.RESUME_WINDOW_MS) {
        return null  // 超时视为新会话
      }
      return state
    } catch {
      return null
    }
  }

  /** 保存状态（原子写入：先写 .tmp，再 rename） */
  static async save(state: RoboticsProjectState): Promise<void>

  /** 更新 lastActiveAt（轻量，每次 submit 调用） */
  static async touch(projectDir: string): Promise<void>

  /** 追加一条进度摘要（滚动保留最近10条） */
  static async appendProgress(projectDir: string, note: string): Promise<void>

  /** 注册新的子智能体任务 */
  static async registerSubAgentTask(projectDir: string, record: ActiveSubAgentRecord): Promise<void>

  /** 标记子智能体任务完成 */
  static async completeSubAgentTask(projectDir: string, taskId: string): Promise<void>

  /** 更新 git 状态 */
  static async updateGitState(projectDir: string, git: Partial<RoboticsGitState>): Promise<void>

  private static _stateFilePath(projectDir: string): string {
    const hash = createHash('sha1').update(projectDir).digest('hex').slice(0, 16)
    return join(RoboticsProjectStore.ROOT, hash, 'state.json')
  }
}
```

### 2.5 `RoboticsSession` 恢复逻辑

```typescript
// src/robotics/RoboticsSession.ts（init 方法扩展）

export class RoboticsSession {
  private state: RoboticsProjectState | null = null

  async init(): Promise<{ resumed: boolean; sessionAge?: number }> {
    const projectDir = this.options.projectDir ?? process.cwd()

    // ── 尝试恢复已有会话 ──────────────────────────────────────────────────────
    const existingState = await RoboticsProjectStore.findByProjectDir(projectDir)

    if (existingState) {
      this.state = existingState
      await RoboticsProjectStore.touch(projectDir)

      // 恢复 git worktree 状态（验证分支是否还存在）
      await this.gitManager.reconcileWorktrees(existingState.git)

      // 恢复子智能体状态（检查 SubAgentTaskStore 中的状态）
      await this._reconcileSubAgentTasks(existingState.activeSubAgentTasks)

      // 注入 R5 节（进度摘要恢复）
      if (existingState.progressNotes.length > 0) {
        this._resumptionContext = existingState.progressNotes.join('\n')
      }

      return {
        resumed: true,
        sessionAge: Date.now() - existingState.lastActiveAt,
      }
    }

    // ── 新建会话 ──────────────────────────────────────────────────────────────
    const gitState = await this.gitManager.detectGitState(projectDir)
    this.state = {
      schemaVersion: '1.0',
      sessionId: this.inner.sessionId,
      projectDir,
      robot: this.options.robot,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      progressNotes: [],
      activeSubAgentTasks: [],
      completedSubAgentTaskIds: [],
      git: gitState,
    }
    await RoboticsProjectStore.save(this.state)
    return { resumed: false }
  }
}
```

### 2.6 恢复时的用户体验

RoboticsSession 恢复后，R5（开发进度）节会自动注入：

```markdown
## Session Resumed
*Last active: 8 hours ago (yesterday at 22:14)*

## Development Progress (Restored)
- ✓ 文献调研完成 — CPG+RL 方案确认
- ✓ 基础 CPG 实现 (src/gait/cpg_v1.py)  
- ⏳ 实验进行中 — sub/task_abc123/experiment 分支, 3 commits ahead of main
- ○ 部署集成 — 未开始

## Active Sub-Agent Tasks (Restored)
| Task | Role | Branch | Status |
|------|------|--------|--------|
| task_abc123 | experiment | sub/task_abc123/experiment | running? |

> Run `get_sub_agent_status task_abc123` to check current status.
> Run `git_sync_to_subagent task_abc123` to push yesterday's main commits.
```

这样用户回来看到的第一条 prompt 就是完整的项目状态，无需重新描述背景。

---

## 3. Git 分支协同

### 3.1 设计哲学

机器人算法开发的代码协同本质上是**并行探索 + 择优合并**的过程：

```
main (稳定代码线)
  │
  ├─ sub/task_abc/experiment  (MPC调参实验，自由修改)
  ├─ sub/task_def/code        (CPG算法实现，并行开发)
  └─ sub/task_ghi/deployment  (部署分支)
```

核心映射关系：

| 概念 | Git 对应 | 说明 |
|------|---------|------|
| 主智能体 | `main` 分支 + 工作目录 | 稳定、已验证的代码 |
| 子智能体 | `sub/<taskId>/<role>` 分支 + worktree | 自由探索，不污染 main |
| 主 → 子同步 | `git rebase main` in worktree | 让子智能体拿到最新进展 |
| 子 → 主合并 | `git merge --squash` or cherry-pick | 选择性吸收成果 |
| 实验失败 | 分支保留（不合并），经验写入 ExperienceStore | 失败本身是知识 |

**为什么用 git worktree 而不是只用分支**：
- worktree 让每个子智能体有**独立的文件系统视图**
- 子智能体的 bash 工具运行在 worktree 目录中，文件操作天然隔离
- 多个 worktree 可以同时存在，互不影响
- worktree 背后仍是同一个 `.git` 目录，git 历史共享，rebase/merge 正常工作

### 3.2 `GitWorkspaceManager` 类

```typescript
// src/robotics/git/GitWorkspaceManager.ts

export interface GitWorktreeRecord {
  taskId: SubAgentTaskId
  role: RoboticsAgentRole
  branchName: string         // 'sub/<taskId>/<role>'
  worktreePath: string       // 物理目录路径
  forkPoint: string          // 创建时 main 的 HEAD commit hash
  createdAt: number
}

export interface GitSyncResult {
  branchName: string
  commitsAhead: number       // sub-agent 分支超前 main 的 commit 数
  commitsBehind: number      // main 超前 sub-agent 的 commit 数（需要 rebase 时 > 0）
  hasConflicts: boolean
}

export class GitWorkspaceManager {
  private readonly projectDir: string
  private readonly worktreeBaseDir: string  // ~/.cache/meta-agent/worktrees/

  constructor(projectDir: string) {
    this.projectDir = projectDir
    this.worktreeBaseDir = join(homedir(), '.cache', 'meta-agent', 'worktrees')
  }

  // ── 初始化 ────────────────────────────────────────────────────────────────

  /** 检测项目是否是 git repo，返回初始 git 状态 */
  async detectGitState(dir: string): Promise<RoboticsGitState> {
    try {
      const result = await this._git(['rev-parse', '--is-inside-work-tree'], dir)
      if (result.trim() !== 'true') return { enabled: false, mainBranch: 'main', subAgentBranches: {}, forkPoints: {} }
      const branch = (await this._git(['symbolic-ref', '--short', 'HEAD'], dir)).trim()
      return { enabled: true, mainBranch: branch, subAgentBranches: {}, forkPoints: {} }
    } catch {
      return { enabled: false, mainBranch: 'main', subAgentBranches: {}, forkPoints: {} }
    }
  }

  // ── Worktree 管理 ────────────────────────────────────────────────────────

  /**
   * 为子智能体任务创建 git branch + worktree。
   * 从当前 main 的 HEAD 分叉。
   * 
   * @returns GitWorktreeRecord 供 SubAgentBridge.spawnSubAgent 注入到 sub-agent config
   */
  async createWorktreeForTask(
    taskId: SubAgentTaskId,
    role: RoboticsAgentRole,
  ): Promise<GitWorktreeRecord> {
    const branchName = `sub/${taskId}/${role}`
    const worktreePath = join(this.worktreeBaseDir, taskId)
    const forkPoint = (await this._git(['rev-parse', 'HEAD'], this.projectDir)).trim()

    // 创建分支
    await this._git(['checkout', '-b', branchName], this.projectDir)

    // 回到 main
    await this._git(['checkout', '-'], this.projectDir)

    // 创建 worktree，指向新分支
    await this._git(
      ['worktree', 'add', worktreePath, branchName],
      this.projectDir,
    )

    return {
      taskId,
      role,
      branchName,
      worktreePath,
      forkPoint,
      createdAt: Date.now(),
    }
  }

  // ── 同步操作 ─────────────────────────────────────────────────────────────

  /**
   * 将 main 的最新进展同步到子智能体的分支（rebase 方式）。
   * 
   * 调用时机：
   *   1. 主智能体完成了一个阶段（代码有重要更新），希望正在运行的子智能体能基于新代码工作
   *   2. 子智能体请求同步（通过 R3 节提示）
   *
   * 如果存在冲突，返回 hasConflicts=true，主智能体决策如何处理
   */
  async syncMainToTask(taskId: SubAgentTaskId): Promise<GitSyncResult> {
    const record = await this._getWorktreeRecord(taskId)
    if (!record) throw new Error(`No worktree for task ${taskId}`)

    const worktreePath = record.worktreePath

    // 在 worktree 中执行 rebase
    try {
      await this._git(['rebase', record.forkPoint ? 'main' : 'main'], worktreePath)
      const ahead  = parseInt((await this._git(['rev-list', '--count', 'main..HEAD'], worktreePath)).trim())
      const behind = parseInt((await this._git(['rev-list', '--count', 'HEAD..main'], worktreePath)).trim())
      return { branchName: record.branchName, commitsAhead: ahead, commitsBehind: behind, hasConflicts: false }
    } catch {
      // rebase 有冲突：中止，保持原状，报告冲突
      await this._git(['rebase', '--abort'], worktreePath).catch(() => {})
      return { branchName: record.branchName, commitsAhead: 0, commitsBehind: 0, hasConflicts: true }
    }
  }

  /**
   * 将子智能体的分支合并到 main。
   * 
   * strategy:
   *   'squash'       — 所有 sub-agent commits 压缩成一个 commit（推荐，保持 main 历史整洁）
   *   'merge'        — 保留完整历史（带 merge commit）
   *   'cherry-pick'  — 只挑选特定 commits（需要提供 commitHashes）
   */
  async mergeTaskBranch(
    taskId: SubAgentTaskId,
    opts: {
      strategy: 'squash' | 'merge' | 'cherry-pick'
      message?: string
      commitHashes?: string[]  // cherry-pick 时使用
    },
  ): Promise<{ merged: boolean; commitHash: string }> {
    const record = await this._getWorktreeRecord(taskId)
    if (!record) throw new Error(`No worktree for task ${taskId}`)

    const msg = opts.message ?? `feat: sub-agent ${record.role} results (${taskId})`

    switch (opts.strategy) {
      case 'squash':
        await this._git(['merge', '--squash', record.branchName], this.projectDir)
        await this._git(['commit', '-m', msg], this.projectDir)
        break
      case 'merge':
        await this._git(['merge', '--no-ff', '-m', msg, record.branchName], this.projectDir)
        break
      case 'cherry-pick':
        if (!opts.commitHashes?.length) throw new Error('cherry-pick requires commitHashes')
        await this._git(['cherry-pick', ...opts.commitHashes], this.projectDir)
        break
    }

    const commitHash = (await this._git(['rev-parse', 'HEAD'], this.projectDir)).trim()
    return { merged: true, commitHash }
  }

  // ── 检查 ─────────────────────────────────────────────────────────────────

  /** 获取分支状态摘要（用于 R3 节展示） */
  async getTaskBranchStatus(taskId: SubAgentTaskId): Promise<{
    branchName: string
    commitsAhead: number
    commitsBehind: number
    lastCommitMessage: string
    lastCommitAt: number
  } | null>

  /** 恢复时验证 worktree 是否还存在（进程重启后 worktree 仍在磁盘） */
  async reconcileWorktrees(gitState: RoboticsGitState): Promise<void> {
    for (const [taskId, branchName] of Object.entries(gitState.subAgentBranches)) {
      const worktreePath = join(this.worktreeBaseDir, taskId)
      try {
        await stat(worktreePath)  // 验证 worktree 目录存在
        // 验证 git 认为这个 worktree 仍然有效
        await this._git(['status'], worktreePath)
      } catch {
        // worktree 目录不存在（被清理了？）— 重建
        await this._git(
          ['worktree', 'add', worktreePath, branchName],
          this.projectDir,
        ).catch(() => {
          console.warn(`[GitWorkspaceManager] Could not restore worktree for ${taskId}`)
        })
      }
    }
  }

  /** 清理 worktree（任务完成/放弃后调用） */
  async removeWorktree(taskId: SubAgentTaskId, opts: { deleteBranch?: boolean } = {}): Promise<void> {
    const worktreePath = join(this.worktreeBaseDir, taskId)
    await this._git(['worktree', 'remove', '--force', worktreePath], this.projectDir).catch(() => {})
    if (opts.deleteBranch) {
      const record = await this._getWorktreeRecord(taskId)
      if (record) {
        await this._git(['branch', '-D', record.branchName], this.projectDir).catch(() => {})
      }
    }
  }

  // ── 内部工具 ─────────────────────────────────────────────────────────────

  private async _git(args: string[], cwd: string): Promise<string> {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const { stdout } = await execFileAsync('git', args, { cwd })
    return stdout
  }

  private async _getWorktreeRecord(taskId: SubAgentTaskId): Promise<GitWorktreeRecord | null> {
    // 从 RoboticsProjectStore 读取（已持久化到 state.json）
    const state = await RoboticsProjectStore.findByProjectDir(this.projectDir)
    if (!state) return null
    const branchName = state.git.subAgentBranches[taskId]
    if (!branchName) return null
    return {
      taskId,
      role: branchName.split('/')[2] as RoboticsAgentRole,
      branchName,
      worktreePath: join(this.worktreeBaseDir, taskId),
      forkPoint: state.git.forkPoints[taskId] ?? '',
      createdAt: 0,  // 不需要
    }
  }
}
```

### 3.3 子智能体的 Git 上下文注入

`experiment_dispatch` 工具在 spawn sub-agent 之前，将 git 上下文注入到 `taskDescription`：

```typescript
// src/robotics/tools/experiment_dispatch/index.ts

async function experimentDispatch(spec: ExperimentSpec, bridge: SubAgentBridge, gitMgr: GitWorkspaceManager) {
  const taskId = makeSubAgentTaskId()

  // 1. 创建 worktree
  const worktreeRecord = gitMgr.enabled
    ? await gitMgr.createWorktreeForTask(taskId, 'experiment')
    : null

  // 2. 构造注入到 sub-agent 的 Git Context 段落
  const gitContext = worktreeRecord ? `
## Git Context for This Experiment
You are working on branch: \`${worktreeRecord.branchName}\`
Working directory: \`${worktreeRecord.worktreePath}\`
Forked from main at commit: \`${worktreeRecord.forkPoint}\`

Rules:
- All file changes MUST be made in your worktree directory: ${worktreeRecord.worktreePath}
- Commit your work regularly with descriptive messages
- Do NOT run \`git push\`, \`git checkout\`, or \`git merge\`
- Do NOT switch branches or create new branches
- The main agent will decide whether to merge your branch into main
` : ''

  // 3. Spawn sub-agent
  const record = await bridge.spawnSubAgent({
    config: {
      taskDescription: JSON.stringify(spec) + '\n\n' + gitContext,
      allowedTools: ['bash', 'read_file', 'write_file', 'glob', 'grep', 'experience_write'],
      maxTurns: spec.maxTurns ?? 60,
      workingDir: worktreeRecord?.worktreePath,  // bash 工具的 CWD 设为 worktree
    }
  })

  // 4. 持久化 git 状态
  if (worktreeRecord) {
    await RoboticsProjectStore.updateGitState(gitMgr.projectDir, {
      subAgentBranches: { [taskId]: worktreeRecord.branchName },
      forkPoints: { [taskId]: worktreeRecord.forkPoint },
    })
    await RoboticsProjectStore.registerSubAgentTask(gitMgr.projectDir, {
      taskId, role: 'experiment',
      title: spec.title,
      branchName: worktreeRecord.branchName,
      worktreePath: worktreeRecord.worktreePath,
      spawnedAt: Date.now(),
    })
  }

  return record
}
```

### 3.4 Git 协同工具集（主智能体使用）

```typescript
// src/robotics/tools/git_sync/index.ts

/**
 * git_sync_to_subagent — 将 main 的最新代码推送到子智能体的分支
 * 
 * 使用时机：主智能体完成一个里程碑（如 CodeAgent 写好了核心库），
 *   希望正在运行的 ExperimentAgent 能在新代码基础上继续实验
 */
export async function createGitSyncToSubAgentTool(
  gitMgr: GitWorkspaceManager
): Promise<MetaAgentTool>

/**
 * git_merge_subagent — 将子智能体分支合并入 main
 * 
 * 通常在子智能体完成后、主智能体决策"这份工作值得保留"时调用
 * strategy 默认 squash，保持 main 历史整洁
 */
export async function createGitMergeSubAgentTool(
  gitMgr: GitWorkspaceManager
): Promise<MetaAgentTool>

/**
 * git_diff_subagent — 查看子智能体相对于 main 做了哪些改动
 * 
 * 通常在决定是否 merge 之前用来检查
 * isConcurrencySafe: true（只读）
 */
export async function createGitDiffSubAgentTool(
  gitMgr: GitWorkspaceManager
): Promise<MetaAgentTool>

/**
 * git_discard_subagent — 放弃子智能体的分支（实验失败，不合并代码）
 * 
 * 注意：放弃代码 ≠ 放弃经验。Experience 已写入 ExperienceStore，
 *   git 分支可以删除，但教训永久保留。
 */
export async function createGitDiscardSubAgentTool(
  gitMgr: GitWorkspaceManager
): Promise<MetaAgentTool>
```

### 3.5 R3 节增强：展示 Git 状态

```typescript
// src/robotics/dynamicSections.ts — buildR3Section 增强

export async function buildR3Section(
  bridge: SubAgentBridge,
  gitMgr: GitWorkspaceManager,
  persistedState: RoboticsProjectState | null,
): Promise<string> {
  const activeTasks = persistedState?.activeSubAgentTasks ?? []
  if (activeTasks.length === 0) return ''

  const rows = await Promise.all(activeTasks.map(async (task) => {
    const record = await bridge.getStatus(task.taskId as SubAgentTaskId)
    const gitStatus = task.branchName && gitMgr.enabled
      ? await gitMgr.getTaskBranchStatus(task.taskId as SubAgentTaskId)
      : null

    const status = record?.status ?? 'unknown'
    const gitInfo = gitStatus
      ? `${gitStatus.branchName} (+${gitStatus.commitsAhead}/-${gitStatus.commitsBehind})`
      : 'no branch'
    const lastCommit = gitStatus?.lastCommitMessage?.slice(0, 40) ?? '—'

    return `| ${task.taskId.slice(-8)} | ${task.role} | ${task.title.slice(0, 30)} | ${status} | ${gitInfo} | ${lastCommit} |`
  }))

  return [
    '## Active Sub-Agent Tasks',
    '',
    '| Task (short) | Role | Title | Status | Branch (±commits) | Last Commit |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '> ⚠ Raw experiment logs are in worktree dirs — only read on user request.',
    '> Use `git_sync_to_subagent <taskId>` to push new main commits to a running agent.',
    '> Use `git_diff_subagent <taskId>` before merging to review changes.',
  ].join('\n')
}
```

### 3.6 主智能体协同决策树（Prompt 指引）

写入 R1 节（robotics domain 背景）的决策指引：

```markdown
## Git Coordination Protocol

When a sub-agent task completes:
1. Run `get_sub_agent_status <taskId>` to read ExperimentSummary
2. If outcome=success AND code changes are valuable:
   - Run `git_diff_subagent <taskId>` to review what changed
   - If acceptable: run `git_merge_subagent <taskId>` (default: squash)
   - Announce the merge in your progress notes
3. If outcome=partial or failure:
   - The experience has already been written to ExperienceStore (exp_*)
   - Run `git_discard_subagent <taskId>` to clean up the branch
   - Do NOT merge failed experiment code into main
4. When you (main agent) have significant updates on main and sub-agents are 
   still running:
   - Run `git_sync_to_subagent <taskId>` so they can rebase on your latest code
   - This is especially important when CodeAgent finishes a core library that 
     ExperimentAgent depends on
```

---

## 4. 三者联动：完整生命周期流

### 4.1 首次启动（第一天）

```
用户: "我要开发四足机器人步态算法，先搜索论文，然后做仿真实验"

SessionRouter
  ├─ Haiku: "robotics"（识别到机器人开发意图）
  └─ _createImpl('robotics') → new RoboticsSession()

RoboticsSession.init()
  ├─ RoboticsProjectStore.findByProjectDir('/home/user/gait_robot') → null (新建)
  ├─ GitWorkspaceManager.detectGitState() → { enabled: true, mainBranch: 'main' }
  └─ 保存 state.json

主智能体推理
  ├─ experience_search(domain='locomotion') → 3条相关历史经验
  ├─ paper_search("CPG locomotion RL 2024") → spawn PaperSearchAgent
  │     ├─ 无 git worktree（paper search 不涉及代码）
  │     └─ 完成后: 经验写入 ExperienceStore, 返回 PaperSummary[]
  │
  └─ experiment_dispatch("验证 CPG 基础步态稳定性")
        ├─ GitWorkspaceManager.createWorktreeForTask(taskId, 'experiment')
        │     ├─ git checkout -b sub/<taskId>/experiment
        │     ├─ git worktree add ~/.cache/.../worktrees/<taskId> sub/<taskId>/experiment
        │     └─ forkPoint = current main HEAD
        ├─ Sub-agent 注入: git context (worktreePath + branchName)
        ├─ SubAgentBridge.spawnSubAgent(workingDir=worktreePath)
        └─ RoboticsProjectStore 记录 activeSubAgentTasks

会话结束（进程退出）
  └─ RoboticsProjectStore.touch() — lastActiveAt 已更新
```

### 4.2 次日恢复

```
用户（第二天打开，输入任意内容或空）

SessionRouter
  ├─ Haiku 分类... 但 RoboticsSession.init() 已先行检查持久化状态
  └─ RoboticsProjectStore.findByProjectDir('/home/user/gait_robot') → 恢复!

RoboticsSession.init() 恢复路径
  ├─ GitWorkspaceManager.reconcileWorktrees()
  │     └─ 验证 ~/.cache/.../worktrees/<taskId> 仍然存在 ✓
  ├─ _reconcileSubAgentTasks()
  │     └─ SubAgentTaskStore.readTask(<taskId>) → status='running'（昨天还没完成）
  └─ R5 节注入恢复摘要

主智能体看到:
  "Session Resumed (8h ago). Active: sub/<taskId>/experiment (branch, 5 commits ahead of main)"

主智能体推理
  ├─ get_sub_agent_status <taskId> → status='completed' (昨晚凌晨完成了!)
  ├─ ExperimentSummary: outcome=partial, metrics={flat_terrain: 92%, slope_15deg: 67%}
  ├─ git_diff_subagent <taskId> → 查看代码改动
  ├─ 决策: slope 测试失败，不合并实验代码，但经验已记录
  ├─ git_discard_subagent <taskId>
  └─ 继续推进: "斜坡测试失败，需要调整 CPG 参数，dispatch 新实验..."
```

### 4.3 多子智能体并行场景

```
main (主智能体，main 分支)
  │
  ├─ git_sync_to_subagent(task_code)  ← 主智能体更新了通用工具库
  │                                      子智能体 rebase，拿到最新代码
  │
  ├─ sub/task_abc/experiment  ← ExperimentAgent: 仿真测试
  │     └─ 完成 → outcome=success
  │           └─ git_merge_subagent(task_abc, squash)
  │                 └─ main 吸收实验优化的参数调整
  │
  ├─ sub/task_def/code  ← CodeAgent: 实现新的 RL 微调层
  │     └─ 仍在运行
  │           └─ git_sync_to_subagent(task_def) ← 将 task_abc 的成果同步给 CodeAgent
  │
  └─ sub/task_ghi/paper_search  ← PaperSearchAgent: 无代码，无 worktree
        └─ 完成 → 经验写入 ExperienceStore
```

---

## 5. 文件变更清单

### 新增文件

```
src/routing/
  types.ts                          ← 扩展 SessionMode + MODE_WEIGHT（robotics=3）

src/robotics/
  git/
    GitWorkspaceManager.ts          ← Worktree 管理核心
    types.ts                        ← GitWorktreeRecord, GitSyncResult
  persistence/
    RoboticsProjectStore.ts         ← 项目状态持久化
    types.ts                        ← RoboticsProjectState, ActiveSubAgentRecord
  tools/
    git_sync_to_subagent/index.ts   ← 主→子同步工具
    git_merge_subagent/index.ts     ← 子→主合并工具
    git_diff_subagent/index.ts      ← diff 查看工具（isConcurrencySafe=true）
    git_discard_subagent/index.ts   ← 放弃分支工具
```

### 修改文件

```
src/routing/types.ts
  + 'robotics' 加入 SessionMode
  + MODE_WEIGHT['robotics'] = 3

src/routing/ModeDetector.ts
  + ROBOTICS_ALWAYS (Tier 0 规则集)
  + LLM prompt 追加 robotics 说明与示例
  + detectSync: Tier 0 最先匹配
  + _detectWithLLM: max_tokens 5→10，VALID_MODES 加 'robotics'

src/routing/SessionRouter.ts
  + _createImpl: 'robotics' case → new RoboticsSession(...)

src/robotics/RoboticsSession.ts
  + init(): 恢复逻辑（RoboticsProjectStore.findByProjectDir）
  + submit(): 每次调用后 RoboticsProjectStore.touch()
  + gitManager 成员

src/robotics/dynamicSections.ts
  + buildR3Section: 增加 git branch/commits 列

src/robotics/tools/experiment_dispatch/index.ts
  + createWorktreeForTask() 调用
  + git context 注入到 taskDescription
  + RoboticsProjectStore 注册 activeSubAgentTask

src/robotics/tools/index.ts
  + export 4个 git 工具的 createXxx 函数
  + createRoboticsTools 工厂函数中注册 git 工具

src/index.ts
  + export GitWorkspaceManager, RoboticsProjectStore 等新增类型
```

### 持久化布局补充

```
~/.claude/meta-agent/robotics/
  projects/
    <sha1(projectDir)[:16]>/
      state.json              ← RoboticsProjectState
      conversation.jsonl      ← 可选消息历史

~/.cache/meta-agent/worktrees/
  <taskId>/                   ← git worktree 目录
    ...                       ← 和 projectDir 相同的文件树结构，在独立分支上
```

---

## 关键设计决策汇总

| 决策点 | 选择 | 理由 |
|--------|------|------|
| robotics 在 MODE_WEIGHT 中的值 | 3（最高）| 机器人模式是多 Agent 超集，不应被 campaign 信号降级 |
| 会话 key 的选取 | `projectDir` (cwd) | 最自然的项目标识，无需用户手动管理 session ID |
| 恢复窗口 | 30天 | 覆盖正常的开发节奏；超时视为新项目 |
| git 工作树方案 | worktree（非 clone）| 同一 `.git` 历史，空间效率高，merge/rebase 原生支持 |
| 子→主合并策略默认值 | squash | main 保持线性历史；实验的调试 commits 不污染主线 |
| 实验失败时的代码处理 | discard（不 merge），经验保留 | 代码可抛弃，教训不可丢；符合"失败是知识"的设计哲学 |
| worktree 存储位置 | `~/.cache/meta-agent/worktrees/` | 与项目目录解耦；进程重启后 worktree 仍在磁盘 |
| 主→子同步触发时机 | 手动（git_sync_to_subagent 工具）| 自动 rebase 可能引发意外冲突；手动触发更安全 |
