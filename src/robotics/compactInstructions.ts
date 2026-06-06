/**
 * buildRoboticsCompactInstructions
 *
 * Generates a ## Compact Instructions block for Robotics mode that tells the
 * auto-compact agent what to preserve when the context window fills.
 *
 * Campaign mode has an analogous block (buildCompactInstructions in compactPrompt.ts)
 * that preserves provenance IDs and campaign state.  Robotics needs its own variant
 * because the critical state is different:
 *
 *   • Active sub-agent task IDs — required for get_sub_agent_status calls
 *   • Hardware safety limits — must not be silently lost after compaction
 *   • Current development phase — orientation anchor for long sessions
 *   • Current experience working set — preserve why selected experience applies
 *
 * Resolved lazily through config.compact.customInstructions when KernelSession
 * starts the compact side-call, so these instructions reflect the live robotics
 * state at the exact compaction moment.
 *
 * Returns null when there is no state that warrants special preservation guidance
 * (e.g. a brand-new session with no tasks and no phase set).
 */

import type { RoboticsProjectState } from './types.js'

export interface RoboticsCompactContext {
  /** Current project state — used for active tasks and phase. */
  state: RoboticsProjectState | null
  /**
   * Hardware profile summary string (the first ~400 chars of formatForPrompt()).
   * Optional — omitted for sessions without a hardware profile.
   */
  hardwareSummary?: string | null
  /** Current injected/selected experience working set. */
  experienceWorkingSet?: Array<{
    id: string
    title: string
    appliesBecause: string
    principle: string
  }>
}

/** Cap on how many completed sub-agent task IDs we enumerate, newest first. */
const COMPLETED_TASK_ID_LIMIT = 12

/**
 * Build the robotics compact instructions block.
 *
 * @returns Markdown string to inject into the user-message prefix, or null if
 *          there is nothing worth preserving (empty session, no tasks, no phase).
 */
export function buildRoboticsCompactInstructions(ctx: RoboticsCompactContext): string | null {
  const { state, hardwareSummary } = ctx

  // Collect the sections that need to survive compaction
  const sections: string[] = []

  // ── Active sub-agent tasks ────────────────────────────────────────────────
  const activeTasks = state?.activeSubAgentTasks ?? []
  if (activeTasks.length > 0) {
    const taskLines = activeTasks.map(t => {
      const parts = [`  - task_id: ${t.taskId}`, `    title: ${t.title}`]
      if (t.branchName) parts.push(`    branch: ${t.branchName}`)
      if (t.on_complete) parts.push(`    on_complete: ${t.on_complete.slice(0, 120)}`)
      return parts.join('\n')
    })
    sections.push(
      '**Active Sub-Agent Tasks** — preserve these task IDs verbatim; they are required for `get_sub_agent_status` calls:',
      taskLines.join('\n'),
    )
  }

  // ── Completed sub-agent tasks ─────────────────────────────────────────────
  // Only the IDs are persisted in project state; the conclusion / merge-discard
  // decision lives in the conversation, so we list the IDs (so the resumed agent
  // knows which experiments ran) and instruct the model to preserve each one's
  // final status below.
  const completedTaskIds = (state?.completedSubAgentTaskIds ?? []).slice(-COMPLETED_TASK_ID_LIMIT)
  if (completedTaskIds.length > 0) {
    sections.push(
      '**Completed Sub-Agent Tasks** — preserve each task\'s final status / conclusion / merge-or-discard decision from the conversation:',
      completedTaskIds.map(id => `  - task_id: ${id}`).join('\n'),
    )
  }

  // ── Current phase ─────────────────────────────────────────────────────────
  if (state?.currentPhase) {
    sections.push(`**Current Development Phase**: ${state.currentPhase}`)
  }

  // ── Hardware safety constraints ───────────────────────────────────────────
  if (hardwareSummary) {
    // Trim to avoid bloating compact; the full profile lives in R4 anyway.
    const trimmed = hardwareSummary.slice(0, 400).trimEnd()
    sections.push(
      '**Hardware Safety Constraints** — must not be dropped after compaction:',
      trimmed,
    )
  }

  // ── Current experience working set ───────────────────────────────────────
  const experienceWorkingSet = ctx.experienceWorkingSet ?? []
  if (experienceWorkingSet.length > 0) {
    const expLines = experienceWorkingSet.slice(0, 4).map(e => [
      `  - exp_id: ${e.id}`,
      `    title: ${e.title}`,
      `    applies_because: ${e.appliesBecause}`,
      `    principle: ${e.principle.slice(0, 220)}`,
    ].join('\n'))
    sections.push(
      '**Current Experience Working Set** — preserve these IDs and applicability reasons so the resumed agent knows why they mattered:',
      expLines.join('\n'),
    )
  }

  // Nothing worth injecting — skip
  if (sections.length === 0) return null

  return [
    '## Compact Instructions (Robotics Mode)',
    '',
    'When compacting this conversation, you MUST preserve the following in your summary:',
    '',
    sections.join('\n\n'),
    '',
    'Additionally:',
    '- Preserve any experience IDs (exp_xxx) that were looked up or written.',
    '- Preserve the exact text of any hardware safety limits mentioned in the conversation.',
    '- Preserve the final status of every completed sub-agent task.',
  ].join('\n')
}

/**
 * Build a FACTUAL deterministic anchor block from live robotics state.
 *
 * Unlike buildRoboticsCompactInstructions — which only *steers* the summarisation
 * model and is therefore lost when the model returns a terse or empty summary —
 * this block is appended verbatim to the compact OUTPUT in every path (rich
 * summary, terse summary, empty-response fallback). It closes the narrow but real
 * gap where, immediately after an auto-compact mid-run, the volatile R2/R3/R6
 * sections are not regenerated until the next submit: the active sub-agent
 * task_ids, phase, hardware safety limits, and experience working set would
 * otherwise be available only if the model happened to preserve them.
 *
 * Returns null when there is nothing worth anchoring.
 */
export function buildRoboticsDeterministicAnchors(ctx: RoboticsCompactContext): string | null {
  const { state, hardwareSummary } = ctx
  const sections: string[] = []

  const activeTasks = state?.activeSubAgentTasks ?? []
  if (activeTasks.length > 0) {
    sections.push(
      '### Active Sub-Agent Tasks (required for `get_sub_agent_status`)',
      activeTasks
        .map(t => {
          const parts = [`- task_id: ${t.taskId} — ${t.title}`]
          if (t.branchName) parts.push(`  branch: ${t.branchName}`)
          if (t.on_complete) parts.push(`  on_complete: ${t.on_complete.slice(0, 120)}`)
          return parts.join('\n')
        })
        .join('\n'),
    )
  }

  const completedTaskIds = (state?.completedSubAgentTaskIds ?? []).slice(-COMPLETED_TASK_ID_LIMIT)
  if (completedTaskIds.length > 0) {
    sections.push(
      '### Completed Sub-Agent Task IDs',
      completedTaskIds.map(id => `- ${id}`).join('\n'),
    )
  }

  if (state?.currentPhase) {
    sections.push(`### Current Development Phase\n- ${state.currentPhase}`)
  }

  if (hardwareSummary) {
    sections.push('### Hardware Safety Constraints', hardwareSummary.slice(0, 400).trimEnd())
  }

  const experienceWorkingSet = ctx.experienceWorkingSet ?? []
  if (experienceWorkingSet.length > 0) {
    sections.push(
      '### Experience Working Set',
      experienceWorkingSet
        .slice(0, 4)
        .map(e => `- ${e.id} (${e.title}) — applies because: ${e.appliesBecause}`)
        .join('\n'),
    )
  }

  if (sections.length === 0) return null

  return [
    '## Robotics State Anchors (deterministic)',
    '- Generated from live session state at compaction time; preserved verbatim regardless of summary quality.',
    '',
    sections.join('\n\n'),
  ].join('\n')
}
