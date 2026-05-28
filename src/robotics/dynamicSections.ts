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
import type { HardwareProfile } from './HardwareProfile.js'
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
      return `## Robotics Development Mode (Single-Agent)

You are operating in Robotics Mode — **single-agent variant** for direct implementation tasks.
Handle everything yourself without dispatching sub-agents.

### Direct Analysis First — Mandatory
Before forming any hypothesis about why something isn't working:
1. Use \`glob\`, \`read\`, \`bash\` to read logs, CSVs, and code directly yourself
2. Show actual numbers from the data in your analysis
3. Only after you have read and understood the data should you propose a fix

### Experience Store — Purpose and Limits
The experience store (\`experience_search\` / \`experience_write\`) is for:
✅ Proven, reusable algorithmic knowledge (what worked, why, under what conditions)
✅ Post-mortem of completed experiments (root cause, fix, outcome metrics)
❌ NOT a message bus between agents — do not write to it to pass data to yourself
❌ NOT a substitute for reading files — always read actual data first

Propose an experience entry **after you have solved the problem**, not before; it will wait for user review before becoming shared knowledge.
A blank experience store means this is unexplored territory — proceed with direct analysis.

### Task Completion
You are done only when you have delivered a complete answer to the user.
Searching tools and reading files is progress, not completion.
Never stop at "I searched the experience store and found nothing."
Always continue to direct file analysis, root-cause diagnosis, and concrete recommendations.

> If the task grows in scope and would benefit from parallel experiments or isolated
> code branches, let the user know so the session can be upgraded to multi-agent mode.`
    }

    // ── Multi-agent variant — full orchestration protocol ─────────────────────
    return `## Robotics Development Mode (Multi-Agent)

You are operating in Robotics Mode — a multi-agent orchestration environment for algorithm development.

### Tool Selection — Critical Rules

| Task type | Correct tool | Wrong tool |
|---|---|---|
| Read a log file, CSV, or source file | \`glob\` / \`read\` / \`bash\` directly | ~~\`experiment_dispatch\`~~ |
| Diagnose why real-robot data looks bad | \`read\` the file yourself | ~~\`experiment_dispatch\`~~ |
| Run a new sim experiment with code changes | \`experiment_dispatch\` | — |
| Run hardware-in-the-loop tests | \`experiment_dispatch\` | — |
| Survey recent papers | \`paper_search\` | — |

**Data that already exists on disk → read it yourself first, always.**
Only dispatch a sub-agent when the task requires new code execution or isolated experimentation.

### Experience Store — Purpose and Limits
The experience store (\`experience_search\` / \`experience_write\`) is for:
✅ Proven, reusable algorithmic knowledge (what worked, why, under what conditions)
✅ Post-mortem of completed experiments recorded **by the sub-agent that ran them**
❌ NOT a message bus — do not search it expecting to find sub-agent results
❌ NOT a substitute for \`get_sub_agent_status\` — always use that to read sub-agent output

To get results from a completed sub-agent: call **\`get_sub_agent_status task_id="<id>"\`**.
The ExperimentSummary in that call IS the result — do not wait for it to appear in the experience store.

### Agent Roles Available
- **PaperSearchAgent** (\`paper_search\`): Literature survey and synthesis
- **ExperimentAgent** (\`experiment_dispatch\`): Isolated simulation / hardware experiments
- **Main (you)**: Direct analysis, architecture decisions, integration, and coordination

### Git Coordination Protocol
When a sub-agent task completes:
1. Run \`get_sub_agent_status\` to read the ExperimentSummary — **this is the result**
2. If \`outcome=success\` AND code changes are valuable:
   - Run \`git_diff_subagent\` to review what changed
   - If acceptable: run \`git_merge_subagent\` (default: squash)
   - Record a progress note with \`progress_note\`
3. If \`outcome=partial\` or \`outcome=failure\`:
   - Run \`git_discard_subagent\` to clean up the branch
   - Do NOT merge failed experiment code into main
4. When main has significant updates that running sub-agents should use:
   - Run \`git_sync_to_subagent\` to rebase their branch onto main

### Experience-Driven Development
- Run \`experience_search\` at the START of any new algorithm task (unexplored territory is normal)
- Run \`experience_write\` at the END of each solved task to propose the proven solution for user review
- Failures are as valuable as successes — always document root cause and workarounds

### Task Completion
You are done only when you have synthesized all sub-agent results and delivered a complete answer.
Dispatching sub-agents is the start of work, not the end.
After dispatch → poll status → read summaries → synthesize → answer.`
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

// ── R4 — Hardware Profile ─────────────────────────────────────────────────────

export function buildR4Section(hwProfile: HardwareProfile, robot?: string): SystemPromptSection {
  return systemPromptSection('hardware_profile', async () => {
    try {
      const formatted = await hwProfile.formatForPrompt()
      if (!formatted) {
        if (robot) {
          return [
            `## Hardware Profile — Onboarding Required`,
            ``,
            `No hardware profile found for **${robot}**.`,
            ``,
            `⚠️ **Action required**: Before starting any algorithm work, you MUST collect hardware`,
            `information from the user and call \`hardware_profile_write\` to persist it.`,
            ``,
            `Ask the user for the following (one message, all fields):`,
            `- **platform**: hardware platform / robot model (e.g. "Unitree Go2", "Franka Panda FR3")`,
            `- **compute**: onboard compute (e.g. "NVIDIA Jetson Orin NX 16GB")`,
            `- **os** *(optional)*: operating system (e.g. "Ubuntu 22.04 + ROS 2 Humble")`,
            `- **actuators** *(optional)*: joint/motor description`,
            `- **sensors** *(optional)*: sensor suite (cameras, LiDAR, IMU, etc.)`,
            `- **safety_limits**: key safety parameters (e.g. max joint velocity, max payload, emergency stop)`,
            `- **known_issues** *(optional)*: any known hardware quirks or failure modes`,
            `- **notes** *(optional)*: anything else relevant`,
            ``,
            `Once the user replies, call \`hardware_profile_write\` immediately to save the profile.`,
            `The profile will be available in R4 from the next turn onwards.`,
          ].join('\n')
        }
        return [
          `## Hardware Profile`,
          ``,
          `No hardware profile is loaded. If you are working with a specific robot platform,`,
          `ask the user for its hardware specs and call \`hardware_profile_write\` to record them.`,
          `A profile ensures safe operation limits and platform-specific guidance are always visible.`,
        ].join('\n')
      }
      return formatted
    } catch {
      return null
    }
  })
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

export function buildR6Section(
  anchorStore: PhysicalAnchorStore,
  pager?: ContextPager,
  _currentQuery?: string,
  _robot?: string,
  anchorSource?: PhysicalAnchorSource,
  pendingCount = 0,
): SystemPromptSection {
  const effectiveSource = anchorSource ?? new PhysicalAnchorSource(anchorStore)

  return DANGEROUS_uncachedSystemPromptSection(
    'physical_anchors',
    async () => {
      try {
        const all = await anchorStore.search({ limit: 100 })

        // ── Empty state ────────────────────────────────────────────────────────
        if (all.length === 0) {
          const pendingNote = pendingCount > 0
            ? ` (${pendingCount} pending review — run \`/anchor review\` to commit)`
            : ''
          return [
            '## Physical Anchors',
            `No physical anchors recorded yet${pendingNote}. ` +
            'Use `physical_anchor_write` to propose hardware facts, measured physical behavior, ' +
            'datasheet constraints, or device quirks that should anchor future reasoning.',
          ].join('\n')
        }

        // ── Layer 1: Manifest line ────────────────────────────────────────────
        const manifestLine = await effectiveSource.getManifestLine()
        const pendingNote = pendingCount > 0
          ? `  *(${pendingCount} pending review — \`/anchor review\`)*`
          : ''

        // ── Layer 2: Priority slots (global + robot scope only) ──────────────
        const priorityAnchors = await effectiveSource.loadPriorityAnchors(3)

        if (pager) {
          // Manifest-style rendering for pager mode
          const manifest = pager.renderManifest([manifestLine + pendingNote])
          const checkedOut = pager.renderForTurn()
          const parts: string[] = [manifest]
          if (checkedOut) parts.push(checkedOut)
          return parts.join('\n\n')
        }

        // ── Non-pager fallback: inline manifest + priority slots ──────────────
        const lines: string[] = [
          '## Physical Anchors',
          `> ${manifestLine}${pendingNote}`,
        ]

        if (priorityAnchors.length > 0) {
          lines.push('', '### High-Priority Anchors (global / robot scope)')
          for (const anchor of priorityAnchors) {
            lines.push('', formatPhysicalAnchorSlot(anchor))
          }
        }

        const codeCount = all.filter(a => a.scope === 'code').length
        if (codeCount > 0) {
          lines.push(
            '',
            `*${codeCount} code-scoped anchor(s) available — use \`physical_anchor_search\` ` +
            `or \`physical_anchor_load\` to retrieve them when relevant.*`,
          )
        } else if (priorityAnchors.length === 0) {
          lines.push(
            '',
            'Use `physical_anchor_search` or `physical_anchor_load` when a physical/device fact may constrain this turn.',
          )
        }

        return lines.join('\n')
      } catch {
        return null
      }
    },
    'Physical anchors can be added during the session and scope / pending count change; must stay current.',
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

// ── R5 — Session Resume / Progress Notes ─────────────────────────────────────
//
// Guard: only injected when there is actually something to show.
//   - Resumed session (resumedAt !== null): always show — compaction may have
//     replaced conversation history, so structured project state is the only
//     anchor for what was done before.
//   - Fresh session: only show when progress notes have accumulated (i.e. the
//     model has called `progress_note` at least once).  Before that, R5 is null
//     and adds no prompt weight.

export function buildR5Section(
  getState: () => RoboticsProjectState | null,
  resumedAt: number | null,
): SystemPromptSection {
  return DANGEROUS_uncachedSystemPromptSection(
    'robotics_progress',
    () => {
      const state = getState()
      if (!state) return null

      const hasNotes = state.progressNotes.length > 0
      const isResumed = resumedAt !== null

      // Suppress entirely when there is nothing meaningful to surface
      if (!isResumed && !hasNotes) return null

      const lines: string[] = []

      // Session resume banner
      if (isResumed) {
        const ageMs = Date.now() - resumedAt
        const ageDays = Math.round(ageMs / 86_400_000)
        const ageHrs = Math.round(ageMs / 3_600_000)
        const ageStr = ageDays >= 1 ? `${ageDays} day(s) ago` : `${ageHrs} hour(s) ago`
        lines.push(`## Session Resumed`, `*Last active: ${ageStr}*`, '')
      }

      // Current phase (only meaningful alongside notes or resume)
      if (state.currentPhase) {
        lines.push(`**Current Phase**: ${state.currentPhase}`, '')
      }

      // Progress notes
      if (hasNotes) {
        lines.push('## Development Progress')
        state.progressNotes.forEach(note => lines.push(`- ${note}`))
        lines.push('')
      }

      return lines.join('\n').trimEnd() || null
    },
    'Progress notes append every turn; resumption context must stay current.',
  )
}
