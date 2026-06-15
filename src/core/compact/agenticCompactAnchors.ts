/**
 * agenticCompactAnchors — compact-time goal/state preservation for AGENTIC mode.
 *
 * Robotics mode already routes mode-specific compact guidance + deterministic
 * anchors into the kernel compact pipeline (robotics/compactInstructions.ts).
 * Agentic mode previously had NEITHER: an agentic session with in-flight
 * sub-agents relied entirely on the flash summariser to remember task IDs and
 * terminal outcomes — exactly the state that must survive compaction verbatim
 * (task IDs are required for `get_sub_agent_status`; terminal outcomes guard
 * against re-running non-idempotent work).
 *
 * Two layers, mirroring robotics:
 *  - buildAgenticCompactInstructions → steers the summarisation model
 *    (## Additional Instructions in the compact side-call prompt).
 *  - buildAgenticDeterministicAnchors → factual block appended verbatim to the
 *    compact OUTPUT in every path (rich/terse/empty-fallback summaries), so
 *    the state survives even when the model under-summarises.
 *
 * Both are wired through MetaAgentSession as lazy thunks reading a sub-agent
 * task snapshot refreshed on `compact_start` (the kernel loop is suspended
 * while the event propagates, so the async refresh completes before the
 * compact side-call resolves the thunks).
 *
 * The TaskContract (when attached) lives in the STABLE system prompt and is
 * therefore already compaction-proof; only its identity is repeated here so a
 * resumed/forked context can re-associate evidence with the right contract.
 */

import type { SubAgentRecord } from '../../subagent/types.js'
import { TERMINAL_STATUSES } from '../../subagent/types.js'
import type { TaskContract } from '../contract/types.js'

export interface AgenticCompactContext {
  /** Snapshot of sub-agent task records (refreshed on compact_start). */
  subAgentTasks?: readonly SubAgentRecord[] | null
  /** Attached task contract, if any. */
  taskContract?: TaskContract | null
}

const ACTIVE_TASK_LIMIT = 8
const TERMINAL_TASK_LIMIT = 12
const TASK_DESCRIPTION_CLIP = 140
const RESULT_SUMMARY_CLIP = 200

function clipLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  return `${collapsed.slice(0, maxChars - 1)}…`
}

function splitTasks(records: readonly SubAgentRecord[]): {
  active: SubAgentRecord[]
  terminal: SubAgentRecord[]
} {
  const active: SubAgentRecord[] = []
  const terminal: SubAgentRecord[] = []
  for (const record of records) {
    if (TERMINAL_STATUSES.has(record.status)) terminal.push(record)
    else active.push(record)
  }
  // Newest first so the limits keep the most recent work.
  active.sort((a, b) => b.createdAt - a.createdAt)
  terminal.sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))
  return { active: active.slice(0, ACTIVE_TASK_LIMIT), terminal: terminal.slice(0, TERMINAL_TASK_LIMIT) }
}

/**
 * Build the ## Additional Instructions block for the compact side-call.
 * Returns null when there is no agentic state worth special guidance.
 */
export function buildAgenticCompactInstructions(ctx: AgenticCompactContext): string | null {
  const records = ctx.subAgentTasks ?? []
  const { active, terminal } = splitTasks(records)
  const sections: string[] = []

  if (active.length > 0) {
    sections.push(
      '**Active Sub-Agent Tasks** — preserve these task IDs verbatim; they are required for `get_sub_agent_status` / `cancel_sub_agent` calls:',
      active
        .map(r => `  - task_id: ${r.taskId} (${r.status}) — ${clipLine(r.config.taskDescription, TASK_DESCRIPTION_CLIP)}`)
        .join('\n'),
    )
  }

  if (terminal.length > 0) {
    sections.push(
      '**Terminal Sub-Agent Tasks** — preserve each task\'s final status and conclusion; this work MUST NOT be re-run after compaction:',
      terminal
        .map(r => `  - task_id: ${r.taskId} — ${r.status}`)
        .join('\n'),
    )
  }

  if (ctx.taskContract) {
    sections.push(
      `**Task Contract** — ${ctx.taskContract.contractId} is the immutable goal anchor; do not paraphrase its primary goal:`,
      `  - primary goal: ${clipLine(ctx.taskContract.primaryGoal, 400)}`,
    )
  }

  if (sections.length === 0) return null

  return [
    '## Compact Instructions (Agentic Mode)',
    '',
    'When compacting this conversation, you MUST preserve the following in your summary:',
    '',
    sections.join('\n\n'),
    '',
    'Additionally:',
    '- Preserve the exact IDs of any sub-agent tasks spawned, queried, or cancelled in the conversation.',
    '- Preserve the final status of every completed/failed/cancelled sub-agent task so finished work is never repeated.',
  ].join('\n')
}

/**
 * Build the FACTUAL deterministic anchor block appended to the compact output
 * in every path. Unlike the instructions above — which only steer the
 * summariser and are lost when it returns a terse or empty summary — this
 * block survives verbatim regardless of summary quality.
 *
 * Returns null when there is nothing worth anchoring.
 */
export function buildAgenticDeterministicAnchors(ctx: AgenticCompactContext): string | null {
  const records = ctx.subAgentTasks ?? []
  const { active, terminal } = splitTasks(records)
  const sections: string[] = []

  if (ctx.taskContract) {
    sections.push(
      '### Task Contract',
      `- ${ctx.taskContract.contractId} — primary goal: ${clipLine(ctx.taskContract.primaryGoal, 400)}`,
    )
  }

  if (active.length > 0) {
    sections.push(
      '### Active Sub-Agent Tasks (required for `get_sub_agent_status`)',
      active
        .map(r => `- task_id: ${r.taskId} (${r.status}) — ${clipLine(r.config.taskDescription, TASK_DESCRIPTION_CLIP)}`)
        .join('\n'),
    )
  }

  if (terminal.length > 0) {
    sections.push(
      '### Terminal Sub-Agent Tasks (do NOT re-run)',
      terminal
        .map(r => {
          const outcome = r.result
            ? ` — ${r.result.success ? 'success' : 'failed'}: ${clipLine(r.result.summary || r.result.error || '', RESULT_SUMMARY_CLIP)}`
            : ''
          return `- task_id: ${r.taskId} — ${r.status}${outcome}`
        })
        .join('\n'),
    )
  }

  if (sections.length === 0) return null

  return [
    '## Agentic State Anchors (deterministic)',
    '- Generated from live session state at compaction time; preserved verbatim regardless of summary quality.',
    '- These reflect the state AT COMPACTION TIME. If the system prompt or a later message carries newer state, the newer source wins.',
    '',
    sections.join('\n\n'),
  ].join('\n')
}
