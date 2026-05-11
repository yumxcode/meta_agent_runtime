/**
 * cancel_sub_agent — abort a running sub-agent task
 *
 * Immediately marks the task as cancelled and signals the runner's
 * AbortController.  The runner's MetaAgentSession will stop at the next
 * API response boundary.
 */

import type { MetaAgentTool, ToolResult } from '../../core/types.js'
import type { SubAgentBridge } from '../SubAgentBridge.js'

export function makeCancelSubAgentTool(bridge: SubAgentBridge): MetaAgentTool {
  return {
    name: 'cancel_sub_agent',
    description: `Cancel a running sub-agent task.

The task is immediately marked as cancelled.  The sub-agent session will stop
at the next API response boundary (it may complete its current streaming turn
before fully stopping).

WHEN TO USE:
- You need to redirect the sub-task based on new information
- The sub-task is taking too long and you want to restart with different parameters
- The user asks you to stop a background task`,

    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID returned by spawn_sub_agent.',
        },
        reason: {
          type: 'string',
          description: '(Optional) Human-readable reason for cancellation — logged in the task record.',
        },
      },
      required: ['task_id'],
    },

    async call(
      input: Record<string, unknown>,
    ): Promise<ToolResult> {
      const taskId = String(input['task_id'] ?? '').trim()
      if (!taskId) {
        return { content: 'Error: task_id is required', isError: true }
      }

      const reason = input['reason'] ? String(input['reason']) : undefined

      const cancelled = await bridge.cancelTask(taskId, reason)

      if (!cancelled) {
        // Check if the task exists but is already terminal
        const record = await bridge.getStatus(taskId)
        if (!record) {
          return {
            content: `Error: No task found with ID "${taskId}".`,
            isError: true,
          }
        }
        return {
          content: JSON.stringify({
            task_id:   taskId,
            cancelled: false,
            message:   `Task is already in terminal state: ${record.status}`,
          }, null, 2),
          isError: false,
        }
      }

      return {
        content: JSON.stringify({
          task_id:   taskId,
          cancelled: true,
          message:   reason
            ? `Task ${taskId} cancelled. Reason: ${reason}`
            : `Task ${taskId} cancelled.`,
        }, null, 2),
        isError: false,
      }
    },
  }
}
