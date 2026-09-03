/**
 * get_sub_agent_status — query the terminal (or current) status of a sub-agent task
 *
 * Returns only the final result by default.  Intermediate state is available
 * via get_sub_agent_intermediate.
 *
 * Human-approval gate:
 *   When pending_human_approval=true the main agent MUST present the result
 *   to the user before taking any further action.  This is enforced by the
 *   tool description and by a warning injected into the response.
 */

import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../core/types.js'
import type { SubAgentBridge } from '../SubAgentBridge.js'
import { exportSubAgentResultArtifact } from '../resultArtifact.js'
import { isValidSubAgentTaskId } from '../types.js'

export function makeGetSubAgentStatusTool(bridge: SubAgentBridge): MetaAgentTool {
  return {
    name: 'get_sub_agent_status',
    permission: { category: 'state' },
    description: `Get the current status (and final result, if complete) of a sub-agent task.

Returns: task_id, status, pending_human_approval, result (when terminal), timestamps.
When structured output exists it is exported as a sanitized output-only artifact
inside the caller workspace; result includes output_path, length, and sha256.
Repeated polls reuse identical content. The path lives only as long as that
workspace; use get_sub_agent_result for durable paged access.

IMPORTANT — Human approval gate:
If pending_human_approval=true in the response, you MUST:
1. Present the sub-task result to the user in full
2. Ask: "The sub-task is complete. Do you want me to proceed?"
3. Wait for explicit user confirmation before any further action
You may NOT autonomously continue when pending_human_approval=true.

Status values:
  pending    — created, not yet started
  queued     — waiting for a scheduler slot
  running    — actively executing
  completed  — finished successfully
  failed     — stopped by circuit-breaker or error
  cancelled  — aborted`,

    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID returned by spawn_sub_agent.',
        },
      },
      required: ['task_id'],
    },

    async call(
      input: Record<string, unknown>,
      ctx: ToolCallContext,
    ): Promise<ToolResult> {
      const taskId = String(input['task_id'] ?? '').trim()
      if (!taskId) {
        return { content: 'Error: task_id is required', isError: true }
      }
      if (!isValidSubAgentTaskId(taskId)) {
        return { content: 'Error: task_id has an invalid format', isError: true }
      }

      const lookup = await bridge.lookupStatus(taskId)
      if (lookup.kind === 'foreign') {
        return {
          content:
            `Error: Task "${taskId}" exists but belongs to a different parent session. ` +
            'Resume that session, or use recover_sub_agent_result with explicit user approval. ' +
            'Owner identity and the raw task-record path are intentionally not exposed.',
          isError: true,
        }
      }
      if (lookup.kind === 'not_found') {
        return {
          content: `Error: No task found with ID "${taskId}". Use list_sub_agents to see all active tasks.`,
          isError: true,
        }
      }
      const record = lookup.record

      const out: Record<string, unknown> = {
        task_id:                record.taskId,
        status:                 record.status,
        pending_human_approval: record.pendingHumanApproval,
        created_at:             new Date(record.createdAt).toISOString(),
      }

      if (record.startedAt)   out['started_at']   = new Date(record.startedAt).toISOString()
      if (record.completedAt) out['completed_at']  = new Date(record.completedAt).toISOString()
      if (record.lastHeartbeatAt) {
        out['last_heartbeat_at'] = new Date(record.lastHeartbeatAt).toISOString()
      }

      if (record.result) {
        const exported = await exportSubAgentResultArtifact(
          record.taskId,
          record.result.output,
          ctx.workspaceRoot ?? process.cwd(),
        ).then(
          artifact => ({ artifact }),
          error => ({ error: error instanceof Error ? error.message : String(error) }),
        )
        const artifact = 'artifact' in exported ? exported.artifact : undefined
        out['result'] = {
          success:      record.result.success,
          summary:      record.result.summary,
          turns_used:   record.result.turnsUsed,
          cost_usd:     record.result.costUsd,
          duration_ms:  record.result.durationMs,
          input_tokens: record.result.inputTokens,
          output_tokens: record.result.outputTokens,
          ...(record.result.error ? { error: record.result.error } : {}),
          ...(record.result.integration ? {
            merge_required: record.result.integration.mergeRequired,
            worktree_status: record.result.integration.status,
            commit_hash: record.result.integration.commitHash,
            changed_files: record.result.integration.changedFiles,
          } : {}),
          ...(artifact ? {
            output_path: artifact.outputPath,
            output_length: artifact.outputLength,
            output_bytes: artifact.outputBytes,
            output_sha256: artifact.outputSha256,
            output_path_scope: artifact.outputPathScope,
            output_path_lifetime: artifact.outputPathLifetime,
          } : {}),
          ...('error' in exported ? { output_export_error: exported.error } : {}),
        }
      }

      if (record.pendingHumanApproval) {
        out['_human_approval_required'] =
          'STOP: present the result above to the user and ask for confirmation before proceeding.'
      }

      return { content: JSON.stringify(out, null, 2), isError: false }
    },
  }
}
