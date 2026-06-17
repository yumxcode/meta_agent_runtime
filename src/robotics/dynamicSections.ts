/**
 * Robotics dynamic system prompt sections — R1 through R5.
 *
 * R1 — Robotics Domain Context + Git Coordination Protocol (memoized)
 * R2 — Experience Index (memoized; rebuilt when experience_write is called)
 * R3 — Active Sub-Agent Tasks + Git Branch Status (volatile — changes each turn)
 * R4 — Hardware Profile (memoized)
 * R5 — Session Resume / Progress Notes (volatile — notes append during session)
 * R6 — Physical Anchors (volatile — device/physics facts)
 *
 * Sections are registered into the SectionRegistry in RoboticsSession.
 */

import {
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  type SystemPromptSection,
} from '../core/systemPromptSections.js'
import type { ExperienceStore } from './ExperienceStore.js'
import type { PhysicalAnchorStore } from './PhysicalAnchorStore.js'
import type { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import type { GitWorkspaceManager } from './git/GitWorkspaceManager.js'
import type { RoboticsAgentMode, RoboticsProjectState } from './types.js'
import type { ContextPager } from '../context/ContextPager.js'
import { ExperienceSource } from '../context/sources/ExperienceSource.js'
import { PhysicalAnchorSource } from '../context/sources/PhysicalAnchorSource.js'

// ── R1 — Robotics Domain Context ─────────────────────────────────────────────

/**
 * Build R1 section.
 *
 * Contains only agent-mode identity and coordination rules.
 * Platform name and hardware specs live in R4 (HardwareProfile) to avoid duplication.
 *
 * @param robot     Unused — kept for call-site compatibility during migration.
 *                  Platform info is now exclusively in R4.
 * @param getMode   Getter returning the current agent mode. Called at section
 *                  evaluation time so that an invalidate() + re-resolve cycle
 *                  picks up the mode determined on the first submit().
 *                  Defaults to 'multi' when absent.
 */
export function buildR1Section(
  robot?: string,
  getMode?: () => RoboticsAgentMode,
): SystemPromptSection {
  return systemPromptSection('robotics_domain', () => {
    const mode = getMode?.() ?? 'multi'

    // ── Single-agent variant — lightweight, no orchestration overhead ─────────
    if (mode === 'single') {
      return `## Robotics 开发模式（单 Agent）

当前为 Robotics 模式 **单 Agent 变体**，面向直接实现类任务。
所有工作由你亲自完成，不派发子 Agent。

### 直接分析优先 — 强制要求
在对"为什么不工作"形成任何假设之前：
1. 用 \`glob\`、\`read_file\`、\`bash\` 亲自读取日志、CSV 和代码
2. 分析中必须给出数据里的真实数字
3. 只有在读懂数据之后，才能提出修复方案

### 经验库 — 用途与边界
经验库（\`experience_search\` / \`experience_write\`）用于：
✅ 经过验证、可复用的算法知识（什么有效、为什么、在什么条件下）
✅ 已完成实验的复盘（根因、修复、结果指标）
❌ 不是草稿本——不要写入临时状态或刚算出的数据；那些用文件存
❌ 不能替代读文件——永远先读真实数据

**何时先搜索：** 新任务开始时，凡是遇到似曾相识的失败模式、调参问题、或可能解决过的同类 bug，先跑 \`experience_search\`。命中结果只是待验证的起始假设，必须对照真实数据核实——不是现成答案。

经验条目在**问题解决之后**再提议写入，而不是之前；它会等待用户审核后才成为共享知识。
经验库为空说明这是未探索领域——直接进入数据分析即可。

### 原理层（Principle Layer）
- 任务需要可迁移机制、第一性原理约束或明确适用边界时，用 \`principle_search\`
- 仅当用户明确要求从已批准经验中提炼/泛化原理时，才用 \`principle_promote\`
- 原理是经过审核的抽象；经验是具体案例；物理锚是客观世界事实
- 不得绕过审核直接写原理——晋升必须经过对源经验的人工批准

### 文献/网络调研 — 使用 research_dispatch
- 所有论文/文献调研一律走 \`research_dispatch\`——它在**隔离上下文**中搜索、读全文、
  按要求抽取，然后把报告**存盘**，只返回一行结论 + 报告路径。
- 不要自己用 \`web_fetch\` 拉论文全文——你的上下文是长生命周期的，大体积抓取会
  污染它（你的 web_fetch 已做单条预算限制，原因即在此）。
- 之后（包括上下文压缩之后）需要细节时：\`read_file\` 读已存盘的报告。
  磁盘上已有报告的调研**绝不重跑**。

### 任务完成标准
只有向用户交付了完整答案才算完成。
搜索工具、读文件只是进展，不是完成。
绝不停在"我搜了经验库但没找到"。
必须继续推进到文件级分析、根因诊断和具体建议。

> 若任务范围扩大、需要并行实验或隔离代码分支，请告知用户，
> 以便将会话升级为多 Agent 模式。`
    }

    // ── Multi-agent variant — full orchestration protocol ─────────────────────
    return `## Robotics 开发模式（多 Agent）

当前为 Robotics 模式——面向算法开发的多 Agent 编排环境。

### 工具选择 — 关键规则

| 任务类型 | 正确工具 | 错误工具 |
|---|---|---|
| 读日志、CSV、源码文件 | 直接用 \`glob\` / \`read_file\` / \`bash\` | ~~\`experiment_dispatch\`~~ |
| 诊断实机数据为何异常 | 自己 \`read_file\` 读文件 | ~~\`experiment_dispatch\`~~ |
| 跑带代码改动的新仿真实验 | \`experiment_dispatch\` | — |
| 跑硬件在环测试 | \`experiment_dispatch\` | — |
| 快速论文概览（标题+贡献） | \`paper_search\` | — |
| 深度文献调研（全文、公式、表格） | \`research_dispatch\` | ~~自己 \`web_fetch\` 拉全文~~ |

**磁盘上已有的数据 → 永远先自己读。**
只有任务需要执行新代码或隔离实验时才派发子 Agent。

### 文献调研纪律
- \`research_dispatch\` 在**隔离上下文**中读源文献并把报告**存盘**（你拿到结论 + 报告路径）。
  凡需要读全文的调研都用它——绝不把论文全文 \`web_fetch\` 进自己的上下文（你的 fetch 有单条预算上限）。
- 上下文压缩之后：已存盘的调研报告会列在摘要锚里——\`read_file\` 报告即可恢复细节。
  磁盘上已有报告的调研**绝不重新派发**。

### 经验库 — 用途与边界
经验库（\`experience_search\` / \`experience_write\`）用于：
✅ 经过验证、可复用的算法知识（什么有效、为什么、在什么条件下）
✅ 由**执行实验的子 Agent** 记录的实验复盘
❌ 不是消息总线——不要指望在里面搜到子 Agent 的结果
❌ 不能替代 \`get_sub_agent_status\`——读子 Agent 输出永远用后者

获取已完成子 Agent 的结果：调用 **\`get_sub_agent_status task_id="<id>"\`**。
该调用返回的 ExperimentSummary **就是结果**——不要等它出现在经验库里。

### 原理层（Principle Layer）
- \`principle_search\` 检索经过审核、带第一性原理支撑和适用/不适用边界的可迁移原理
- 仅当用户明确要求把已批准经验抽象为原理时，\`principle_promote\` 才入队新候选
- 置信度晋升在经验获人工批准后处理；不得绕过审核直接写原理

### 可用 Agent 角色
- **PaperSearchAgent**（\`paper_search\`）：文献概览与综述
- **ExperimentAgent**（\`experiment_dispatch\`）：隔离的仿真/硬件实验
- **主 Agent（你）**：直接分析、架构决策、集成与协调

### Git 协同协议
子 Agent 任务完成时：
1. 跑 \`get_sub_agent_status\` 读 ExperimentSummary——**这就是结果**
2. 若 \`outcome=success\` 且代码改动有价值：
   - 跑 \`git_diff_subagent\` 审查改动
   - 可接受则跑 \`git_merge_subagent\`（默认 squash）
   - 用 \`progress_note\` 记一条进度笔记
3. 若 \`outcome=partial\` 或 \`outcome=failure\`：
   - 跑 \`git_discard_subagent\` 清理分支
   - 失败实验的代码**不得**合入 main
4. main 有子 Agent 应使用的重要更新时：
   - 跑 \`git_sync_to_subagent\` 把其分支 rebase 到 main

### 经验驱动开发
- 新算法任务**开始**时跑 \`experience_search\`（空结果属正常，说明是未探索领域）
- 任务解决**之后**跑 \`experience_write\` 提议已验证的方案，等待用户审核
- 失败与成功同样有价值——务必记录根因和绕行方案

### 任务完成标准
只有综合全部子 Agent 结果并交付完整答案才算完成。
派发子 Agent 是工作的开始，不是结束。
派发 → 轮询状态 → 读摘要 → 综合 → 作答。`
  })
}

// ── R2 — Experience Index (demand-paged, committed entries only) ─────────────
//
// Two-layer rendering:
//   Layer 1 — Manifest: ultra-compact always-visible index (~100 tokens)
//             Shows total count, domain breakdown, active checked-out slots.
//   Layer 2 — Checked-out slots: full content paged in by VV hooks / QueryAnalyzer
//             Budget-limited (default 1500 tokens), rendered by ContextPager.
//
// When pager is not provided the section falls back to the full index dump
// (backward-compatible for callers that have not yet wired up ContextPager).
//
// The optional `source` parameter accepts a pre-built ExperienceSource so
// callers (RoboticsSession) can share one instance rather than constructing a
// new one inside the async callback on every turn.

export function buildR2Section(
  store: ExperienceStore,
  pager?: ContextPager,
  source?: ExperienceSource,
): SystemPromptSection {
  return DANGEROUS_uncachedSystemPromptSection(
    'experience_index',
    async () => {
      // ── No pager: legacy full-dump mode ───────────────────────────────────
      if (!pager) {
        try {
          const index = await store.loadIndexMarkdown()
          if (!index || index.trim().length === 0) {
            return `## Experience Index\n*No experiences recorded yet. Use \`experience_write\` after completing tasks.*`
          }
          return index
        } catch {
          return `## Experience Index\n*Could not load experience index.*`
        }
      }

      // ── Pager mode: manifest + checked-out slots ───────────────────────────
      try {
        // Reuse the caller-provided source; only create a new instance as a
        // fallback for backward-compatible callers that omit the parameter.
        const effectiveSource = source ?? new ExperienceSource(store)
        const manifestLine = await effectiveSource.getManifestLine()

        // Manifest layer — always rendered
        const manifest = pager.renderManifest([manifestLine])

        // Checked-out layer — budget-limited, populated by VV hooks / QueryAnalyzer
        const checkedOut = pager.renderForTurn()

        const parts = [manifest]
        if (checkedOut) parts.push(checkedOut)

        return parts.join('\n\n')
      } catch {
        return `## Experience Index\n*Could not load experience context.*`
      }
    },
    'Experience entries and paged-in failure details change each turn; must stay current.',
  )
}

// ── R3 — Active Sub-Agent Tasks + Git Status ─────────────────────────────────

export function buildR3Section(
  bridge: SubAgentBridge,
  gitMgr: GitWorkspaceManager,
  getState: () => RoboticsProjectState | null,
): SystemPromptSection {
  return DANGEROUS_uncachedSystemPromptSection(
    'robotics_subagents',
    async () => {
      const state = getState()
      const activeTasks = state?.activeSubAgentTasks ?? []
      if (activeTasks.length === 0) return null

      const rows = await Promise.all(
        activeTasks.map(async task => {
          const record = await bridge.getStatus(task.taskId as import('../subagent/types.js').SubAgentTaskId)
          const status = record?.status ?? 'unknown'
          const statusIcon = status === 'completed' ? '✅'
            : status === 'failed' ? '❌'
            : status === 'running' ? '⏳'
            : '❓'

          let gitInfo = '—'
          if (task.branchName && gitMgr.enabled) {
            try {
              const bs = await gitMgr.getTaskBranchStatus(
                task.taskId as import('../subagent/types.js').SubAgentTaskId,
                task.branchName,
              )
              gitInfo = `\`${task.branchName}\` +${bs.commitsAhead}/-${bs.commitsBehind}`
            } catch {
              gitInfo = `\`${task.branchName}\``
            }
          }

          const age = Math.round((Date.now() - task.spawnedAt) / 60_000)
          const ageStr = age < 60 ? `${age}m` : `${Math.round(age / 60)}h`
          const onComplete = task.on_complete ? task.on_complete.slice(0, 60) + (task.on_complete.length > 60 ? '…' : '') : '*(not set)*'

          return `| ${task.taskId.slice(-8)} | ${statusIcon} ${status} | ${task.title.slice(0, 30)} | ${gitInfo} | ${ageStr} | ${onComplete} |`
        }),
      )

      return [
        '## Active Sub-Agent Tasks',
        '',
        '> ⚠️ For each completed task below, execute your committed `YOUR NEXT ACTION` before moving on.',
        '',
        '| Task (last 8) | Status | Title | Branch (±commits) | Age | YOUR NEXT ACTION |',
        '|---|---|---|---|---|---|',
        ...rows,
        '',
        '> `get_sub_agent_status task_id="<id>"` — read ExperimentSummary (the actual result).',
        '> `git_diff_subagent task_id="<id>"` — review code changes before merging.',
      ].join('\n')
    },
    'Sub-agent status changes every turn; staleness causes incorrect merge decisions.',
  )
}

// ── R4 — Hardware Profile (snapshot, session-start injection) ────────────────
//
// Like R5, R4 is now rendered into a frozen SNAPSHOT string that is refreshed
// only at session-start moments (create / resume / compact).  This keeps R4 in
// the STABLE system prompt (cache-friendly) and minimizes system-prompt churn.
//
// Source of the underlying profile (two write paths, both persisted to the same
// HardwareProfile JSON store):
//   1. LLM tool call  — `hardware_profile_write` (the agent collects specs and
//      persists them mid-session).
//   2. User command   — `/hardware select` wizard (rebuilds the session, so the
//      snapshot refreshes on the new session's init).
//
// Because a mid-session `hardware_profile_write` does NOT refresh the snapshot,
// the rendered section carries a staleness disclaimer (see renderR4Snapshot).

export function buildR4Section(getSnapshot: () => string | null): SystemPromptSection {
  return systemPromptSection('hardware_profile', () => getSnapshot())
}

/**
 * Render the R4 hardware-profile snapshot body.
 *
 * Called by RoboticsSession at session-start moments (create / resume / compact)
 * with the already-fetched `formatted` profile text (from
 * HardwareProfile.formatForPrompt()); pass null/empty when no profile exists.
 *
 * When a profile is present the snapshot is prefixed with a disclaimer: it was
 * captured at a session-start moment and may have been updated later this
 * session via `hardware_profile_write` or `/hardware`.
 */
export function renderR4Snapshot(formatted: string | null, robot?: string): string | null {
  // ── Profile present → disclaimer + profile content ────────────────────────
  if (formatted && formatted.trim().length > 0) {
    return [
      '> 注：该硬件画像为快照（在会话启动 / resume / 压缩时刻记录），本会话过程中可能已通过 `hardware_profile_write` 或 `/hardware` 更新。',
      '',
      formatted,
    ].join('\n')
  }

  // ── No profile, robot bound → onboarding ──────────────────────────────────
  if (robot) {
    return [
      `## 硬件画像 — 需要初始化`,
      ``,
      `会话启动时未找到 **${robot}** 的硬件画像。`,
      ``,
      `⚠️ **必须执行**：开始任何算法工作之前，先向用户收集硬件信息，`,
      `并调用 \`hardware_profile_write\` 持久化。`,
      ``,
      `一次性向用户询问以下全部字段：`,
      `- **platform**：硬件平台/机器人型号（如 "Unitree Go2"、"Franka Panda FR3"）`,
      `- **compute**：板载算力（如 "NVIDIA Jetson Orin NX 16GB"）`,
      `- **os** *(可选)*：操作系统（如 "Ubuntu 22.04 + ROS 2 Humble"）`,
      `- **actuators** *(可选)*：关节/电机描述`,
      `- **sensors** *(可选)*：传感器配置（相机、LiDAR、IMU 等）`,
      `- **safety_limits**：关键安全参数（如最大关节速度、最大负载、急停）`,
      `- **known_issues** *(可选)*：已知硬件怪癖或故障模式`,
      `- **notes** *(可选)*：其他相关信息`,
      ``,
      `用户回复后，立即调用 \`hardware_profile_write\` 保存画像。`,
      `> 注：该提示为快照时刻状态；若你已在本会话中写入画像，它将在下一个会话启动 / resume / 压缩时刻加载到 R4。`,
    ].join('\n')
  }

  // ── No profile, no robot → hint ───────────────────────────────────────────
  return [
    `## 硬件画像`,
    ``,
    `当前未加载硬件画像。如果你在为特定机器人平台工作，`,
    `请向用户询问硬件规格并调用 \`hardware_profile_write\` 记录。`,
    `画像可确保安全运行限值和平台特定指引始终可见。`,
  ].join('\n')
}

// ── R6 — Physical Anchors (progressive disclosure) ───────────────────────────
//
// Three layers:
//   Layer 1 — Manifest: one-line count with scope breakdown (always visible).
//             "Physical anchors: 7 total | global:2 robot:3 code:2 | motion_planning:4"
//   Layer 2 — Priority slots: top global + robot anchors auto-expanded (≤3 entries).
//             These are cross-session safety facts that should never be missed.
//   Layer 3 — On-demand: code-scoped anchors loaded via physical_anchor_search /
//             physical_anchor_load when the agent determines they're relevant.
//
// When no pager is provided, falls back to layer 2 inline (backward-compatible).
// pendingCount is shown so the user knows anchors await review after the session.

/**
 * R6 — Physical Anchors (v1: full session-scoped load, memoized).
 *
 * Anchors are few, stable physical facts. We load the whole session-scoped set
 * (global + this robot + this project's code scope) ONCE and memoize it, so the
 * block stays byte-stable across turns and keeps the prompt cache warm. It is
 * invalidated only when /anchor review commits new anchors (RoboticsSession
 * .invalidateAnchors), which incrementally folds them in on the next turn.
 *
 * Per-turn relevance recall is intentionally NOT used for anchors — they are
 * low-volume and stable, so full memoized injection is both complete and
 * cache-friendly. (Principle recall is deferred entirely in v1.)
 */
export function buildR6Section(
  anchorStore: PhysicalAnchorStore,
  robot?: string,
  anchorSource?: PhysicalAnchorSource,
): SystemPromptSection {
  const effectiveSource = anchorSource ?? new PhysicalAnchorSource(anchorStore)
  const PER_SCOPE = 20  // PhysicalAnchorStore.search caps at 20; ample for low-volume anchors

  return systemPromptSection(
    'physical_anchors',
    async () => {
      try {
        // Session-scoped full load: global facts + this robot + this project's code scope.
        const [globalAnchors, robotAnchors, codeAnchors] = await Promise.all([
          anchorStore.search({ scope: 'global', limit: PER_SCOPE }),
          robot ? anchorStore.search({ scope: 'robot', robot, limit: PER_SCOPE }) : Promise.resolve([]),
          anchorStore.search({ scope: 'code', limit: PER_SCOPE }),
        ])
        const seen = new Set<string>()
        const all: typeof globalAnchors = []
        for (const a of [...globalAnchors, ...robotAnchors, ...codeAnchors]) {
          if (!seen.has(a.id)) { seen.add(a.id); all.push(a) }
        }

        if (all.length === 0) {
          return [
            '## Physical Anchors',
            'No physical anchors recorded yet. ' +
            'Use `physical_anchor_write` to propose hardware facts, measured physical behavior, ' +
            'datasheet constraints, or device quirks that should anchor future reasoning.',
          ].join('\n')
        }

        const manifestLine = await effectiveSource.getManifestLine()
        const lines: string[] = ['## Physical Anchors', `> ${manifestLine}`]
        for (const anchor of all) {
          lines.push('', formatPhysicalAnchorSlot(anchor))
        }
        return lines.join('\n')
      } catch {
        return null
      }
    },
  )
}

export function formatPhysicalAnchorSlot(anchor: Awaited<ReturnType<PhysicalAnchorStore['search']>>[number]): string {
  const lines = [
    `**[${anchor.id}] ${anchor.title}**`,
    `Scope: ${anchor.scope}  Domain: ${anchor.domain}  Confidence: ${anchor.confidenceTier}`,
    `Fact: ${anchor.fact}`,
  ]
  if (anchor.mechanism) lines.push(`Mechanism: ${anchor.mechanism}`)
  lines.push(`Implication: ${anchor.implication}`)
  if (anchor.robot) lines.push(`Robot: ${anchor.robot}`)
  if (anchor.evidenceRefs.length) lines.push(`Evidence: ${anchor.evidenceRefs.slice(0, 3).join(' / ')}`)
  return lines.join('\n')
}

// ── R5 — Session Milestone Progress (snapshot, session-level) ────────────────
//
// R5 is now a SESSION-LEVEL milestone record, not a project-level one. It is
// bound to a specific session (via findBySession in RoboticsSession) and is
// rendered into a frozen SNAPSHOT string only at session-start moments:
//   1. session just created,
//   2. resuming into an old session,
//   3. when compaction executes.
//
// This keeps R5 in the STABLE system prompt (cache-friendly) and minimizes how
// often the system prompt changes — the snapshot is recomputed only at those
// moments, never every turn.  Milestone *generation* is still LLM-driven via
// the `progress_note` tool; only the INJECTION TIMING is fixed here.
//
// buildR5Section reads the pre-rendered snapshot via getSnapshot(); rendering
// (including the staleness disclaimer) lives in renderR5Snapshot below.

export function buildR5Section(
  getSnapshot: () => string | null,
): SystemPromptSection {
  return systemPromptSection('robotics_progress', () => getSnapshot())
}

/**
 * Render the R5 milestone snapshot body for the current session state.
 *
 * Called by RoboticsSession at session-start moments (create / resume / compact)
 * to refresh the frozen snapshot string. Returns null when there is nothing
 * meaningful to surface (fresh session, no notes, not resumed).
 *
 * The snapshot always carries a disclaimer: these milestones are PAST progress
 * captured at the snapshot moment; actual progress during the current session
 * may have advanced since.
 */
export function renderR5Snapshot(
  state: RoboticsProjectState | null,
  resumedAt: number | null,
): string | null {
  if (!state) return null

  const hasNotes = state.progressNotes.length > 0
  const isResumed = resumedAt !== null

  // Suppress entirely when there is nothing meaningful to surface
  if (!isResumed && !hasNotes) return null

  const lines: string[] = []

  lines.push('## 会话里程碑进度（快照）')
  lines.push(
    '> 注：以下里程碑为快照时刻记录的过去进度，本会话过程中进度可能已推进。',
  )
  lines.push('')

  // Session resume banner
  if (isResumed) {
    const ageMs = Date.now() - resumedAt
    const ageDays = Math.round(ageMs / 86_400_000)
    const ageHrs = Math.round(ageMs / 3_600_000)
    const ageStr = ageDays >= 1 ? `${ageDays} 天前` : `${ageHrs} 小时前`
    lines.push(`**会话已恢复** — 上次活跃：${ageStr}`, '')
  }

  // Current phase
  if (state.currentPhase) {
    lines.push(`**当前阶段**：${state.currentPhase}`, '')
  }

  // Progress notes
  if (hasNotes) {
    lines.push('## 开发进度')
    state.progressNotes.forEach(note => lines.push(`- ${note}`))
    lines.push('')
  }

  return lines.join('\n').trimEnd() || null
}
