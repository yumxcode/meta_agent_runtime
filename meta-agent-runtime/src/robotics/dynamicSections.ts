/**
 * Robotics dynamic system prompt sections — R1 through R5.
 *
 * R1 — Robotics Domain Context + Git Coordination Protocol (memoized)
 * R2 — Experience Index (memoized; rebuilt when experience_write is called)
 * R3 — Active Sub-Agent Tasks + Git Branch Status (volatile — changes each turn)
 * R4 — Hardware Profile (memoized)
 * R5 — Session Resume / Progress Notes (volatile — notes append during session)
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
import type { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import type { GitWorkspaceManager } from './git/GitWorkspaceManager.js'
import type { RoboticsAgentMode, RoboticsProjectState } from './types.js'

// ── R1 — Robotics Domain Context ─────────────────────────────────────────────

/**
 * Build R1 section.
 *
 * @param robot     Optional robot/platform name injected into the header.
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
    const robotLine = robot ? `**Robot/Platform**: ${robot}\n\n` : ''

    // ── Single-agent variant — lightweight, no orchestration overhead ─────────
    if (mode === 'single') {
      return `## Robotics Development Mode (Single-Agent)

${robotLine}You are operating in Robotics Mode — **single-agent variant** for direct implementation tasks.
Handle everything yourself without dispatching sub-agents.

### Experience-Driven Development
- Run \`experience_search\` at the START of any new algorithm task
- Run \`experience_write\` at the END of each task (success or failure)
- Failures are as valuable as successes — always document root cause and workarounds

> If the task grows in scope and would benefit from parallel experiments or isolated
> code branches, let the user know so the session can be upgraded to multi-agent mode.`
    }

    // ── Multi-agent variant — full orchestration protocol ─────────────────────
    return `## Robotics Development Mode (Multi-Agent)

${robotLine}You are operating in Robotics Mode — a multi-agent orchestration environment for algorithm development.

### Agent Roles Available
- **PaperSearchAgent** (\`paper_search\`): Literature survey and synthesis
- **ExperimentAgent** (\`experiment_dispatch\`): Isolated simulation / hardware experiments
- **Main (you)**: Architecture decisions, integration, and sub-agent coordination

### Noise Isolation Protocol
> ⚠ ExperimentAgent sub-agents return only **structured ExperimentSummary JSON** — never raw logs.
> Do NOT request or read raw worktree log files.
> Trust the structured summary. If uncertain, dispatch an AnalysisAgent to verify.

### Git Coordination Protocol
When a sub-agent task completes:
1. Run \`get_sub_agent_status\` to read the ExperimentSummary
2. If \`outcome=success\` AND code changes are valuable:
   - Run \`git_diff_subagent\` to review what changed
   - If acceptable: run \`git_merge_subagent\` (default: squash)
   - Record a progress note with \`progress_note\`
3. If \`outcome=partial\` or \`outcome=failure\`:
   - The experience is already in ExperienceStore (written by the sub-agent)
   - Run \`git_discard_subagent\` to clean up the branch
   - Do NOT merge failed experiment code into main
4. When main has significant code updates that running sub-agents should use:
   - Run \`git_sync_to_subagent\` to rebase their branch onto main

### Experience-Driven Development
- Run \`experience_search\` at the START of any new algorithm task
- Run \`experience_write\` at the END of each task (success or failure)
- Failures are as valuable as successes — always document root cause and workarounds`
  })
}

// ── R2 — Experience Index ─────────────────────────────────────────────────────

export function buildR2Section(store: ExperienceStore): SystemPromptSection {
  return systemPromptSection('experience_index', async () => {
    try {
      const index = await store.loadIndexMarkdown()
      if (!index || index.trim().length === 0) {
        return `## Experience Index\n*No experiences recorded yet. Use \`experience_write\` after completing tasks.*`
      }
      return index
    } catch {
      return `## Experience Index\n*Could not load experience index.*`
    }
  })
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

          return `| ${task.taskId.slice(-8)} | ${statusIcon} ${status} | ${task.role} | ${task.title.slice(0, 35)} | ${gitInfo} | ${ageStr} ago |`
        }),
      )

      return [
        '## Active Sub-Agent Tasks',
        '',
        '| Task (last 8) | Status | Role | Title | Branch (±commits) | Age |',
        '|---|---|---|---|---|---|',
        ...rows,
        '',
        '> Use `get_sub_agent_status task_id="<taskId>"` for full details.',
        '> Use `git_diff_subagent task_id="<taskId>"` before merging.',
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

// ── R5 — Session Resume / Progress Notes ─────────────────────────────────────

export function buildR5Section(
  getState: () => RoboticsProjectState | null,
  resumedAt: number | null,
): SystemPromptSection {
  return DANGEROUS_uncachedSystemPromptSection(
    'robotics_progress',
    () => {
      const state = getState()
      if (!state) return null

      const lines: string[] = []

      // Session resume banner
      if (resumedAt !== null) {
        const ageMs = Date.now() - resumedAt
        const ageHrs = Math.round(ageMs / 3_600_000)
        const ageDays = Math.round(ageMs / 86_400_000)
        const ageStr = ageDays >= 1 ? `${ageDays} day(s) ago` : `${ageHrs} hour(s) ago`
        lines.push(`## Session Resumed`, `*Last active: ${ageStr}*`, '')
      }

      // Current phase
      if (state.currentPhase) {
        lines.push(`**Current Phase**: ${state.currentPhase}`, '')
      }

      // Progress notes
      if (state.progressNotes.length > 0) {
        lines.push('## Development Progress')
        state.progressNotes.forEach(note => lines.push(`- ${note}`))
        lines.push('')
      }

      return lines.length > 0 ? lines.join('\n') : null
    },
    'Progress notes append every turn; resumption context must stay current.',
  )
}
