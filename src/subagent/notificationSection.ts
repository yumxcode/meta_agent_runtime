/**
 * Sub-agent notification prompt section.
 *
 * Builds the D-SubAgent dynamic system-prompt block from a SubAgentBridge's
 * public state. This is a PROMPT concern, deliberately kept out of the
 * SubAgentBridge scheduler class (which owns lifecycle/scheduling/budget), so
 * the scheduler file stays focused. See architecture-review-2026-06-18.md §3.2.
 */
import type { SubAgentBridge } from './SubAgentBridge.js'

/**
 * Minimum queue age (ms) before a "tasks are waiting" warning is injected
 * into the system prompt.  Prevents noise on fast-start queues while ensuring
 * the AI knows about long-running backlogs.
 */
const STALE_QUEUE_WARN_MS = 30_000

/**
 * Build the D-SubAgent dynamic system prompt section.
 *
 * Called by MetaAgentSession / dynamicPrompt.ts before each submit() turn.
 * Returns empty string when there are no pending notifications and no notable
 * queue conditions.
 *
 * The section is injected as a volatile section (rebuilt every turn) because
 * notifications arrive asynchronously and must not be cached.
 *
 * Content:
 *   1. Queue status warning — emitted when tasks have been queued > 30 s, so
 *      the AI never mistakes "not yet started" for "already running".
 *   2. Terminal notifications — tasks that just completed or failed.
 */
export function buildSubAgentNotificationSection(bridge: SubAgentBridge): string {
  const notifications = bridge.drainNotifications()
  const stats = bridge.getSchedulerStats()

  const lines: string[] = []

  // ── #12 Queue status warning ──────────────────────────────────────────────
  // Show whenever there are queued or running tasks, but upgrade the warning
  // to a prominent caution block when queued tasks have been waiting a while.
  if (stats.queued > 0 || stats.running > 0) {
    const oldestSec = Math.round(stats.oldestQueuedMs / 1_000)
    if (stats.queued > 0 && stats.oldestQueuedMs >= STALE_QUEUE_WARN_MS) {
      lines.push('## Sub-Agent Queue Status ⚠')
      lines.push(
        `- Running: ${stats.running}/${stats.maxConcurrent} | ` +
        `Queued: ${stats.queued} (oldest: ${oldestSec}s)`,
      )
      lines.push(
        '> Queued sub-agents have NOT started yet. ' +
        'Do NOT treat them as running or assume any work has been done. ' +
        'Wait or cancel before dispatching duplicates.',
      )
    } else {
      lines.push(
        `## Sub-Agent Status: ${stats.running} running, ${stats.queued} queued` +
        (stats.queued > 0 && stats.oldestQueuedMs > 0 ? ` (oldest: ${oldestSec}s)` : ''),
      )
    }
    lines.push('')
  }

  // ── Terminal notifications ─────────────────────────────────────────────────
  if (notifications.length > 0) {
    lines.push('## Sub-Agent Notifications (pending)')
    lines.push(...notifications.map(n => `- ${n}`))
    lines.push('')
    lines.push(
      '> These sub-tasks just reached terminal state. ' +
      'Use `get_sub_agent_status` to retrieve full results. ' +
      'If `pending_human_approval` is true, you MUST present the result to the user before proceeding.',
    )
  }

  return lines.join('\n')
}
