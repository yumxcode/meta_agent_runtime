/**
 * list_sub_agents — list all sub-agent tasks for the current session
 *
 * Useful for getting an overview of running / completed / failed sub-tasks
 * without reading each record individually.
 */

import type { MetaAgentTool, ToolResult } from '../../core/types.js'
import type { SubAgentBridge } from '../SubAgentBridge.js'

export function makeListSubAgentsTool(bridge: SubAgentBridge): MetaAgentTool {
  return {
    name: 'list_sub_agents',
    description: `List all sub-agent tasks spawned in this session.

Returns a summary of each task: task_id, status, cost, duration, and a
short summary of the result (if complete).

Use this to get an overview of all sub-tasks before deciding next steps.`,

    inputSchema: {
      type: 'object' as const,
      properties: {
        status_filter: {
          type: 'string',
          enum: ['all', 'active', 'completed', 'failed', 'cancelled'],
          description: 'Filter by status. Default: "all".',
        },
      },
    },

    async call(
      input: Record<string, unknown>,
    ): Promise<ToolResult> {
      const filter = String(input['status_filter'] ?? 'all')
      const records = await bridge.listTasks()

      const filtered = records.filter(r => {
        if (filter === 'all')       return true
        if (filter === 'active')    return r.status === 'pending' || r.status === 'queued' || r.status === 'running'
        return r.status === filter
      })

      if (filtered.length === 0) {
        return {
          content: JSON.stringify({
            count: 0,
            tasks: [],
            message: filter === 'all'
              ? 'No sub-agent tasks in this session.'
              : `No tasks with status "${filter}".`,
          }, null, 2),
          isError: false,
        }
      }

      const summaries = filtered.map(r => ({
        task_id:                r.taskId,
        status:                 r.status,
        pending_human_approval: r.pendingHumanApproval,
        created_at:             new Date(r.createdAt).toISOString(),
        completed_at:           r.completedAt ? new Date(r.completedAt).toISOString() : undefined,
        result_summary:         r.result?.summary?.slice(0, 200) ?? undefined,
        turns_used:             r.result?.turnsUsed ?? undefined,
        cost_usd:               r.result?.costUsd ?? undefined,
        error:                  r.result?.error ?? undefined,
      }))

      return {
        content: JSON.stringify({
          count: summaries.length,
          tasks: summaries,
        }, null, 2),
        isError: false,
      }
    },
  }
}
