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
export function makeGetSubAgentStatusTool(bridge) {
    return {
        name: 'get_sub_agent_status',
        description: `Get the current status (and final result, if complete) of a sub-agent task.

Returns: task_id, status, pending_human_approval, result (when terminal), timestamps.

IMPORTANT — Human approval gate:
If pending_human_approval=true in the response, you MUST:
1. Present the sub-task result to the user in full
2. Ask: "The sub-task is complete. Do you want me to proceed?"
3. Wait for explicit user confirmation before any further action
You may NOT autonomously continue when pending_human_approval=true.

Status values:
  pending    — created, not yet started
  running    — actively executing
  completed  — finished successfully
  failed     — stopped by circuit-breaker or error
  cancelled  — aborted`,
        inputSchema: {
            type: 'object',
            properties: {
                task_id: {
                    type: 'string',
                    description: 'The task ID returned by spawn_sub_agent.',
                },
            },
            required: ['task_id'],
        },
        async call(input) {
            const taskId = String(input['task_id'] ?? '').trim();
            if (!taskId) {
                return { content: 'Error: task_id is required', isError: true };
            }
            const record = await bridge.getStatus(taskId);
            if (!record) {
                return {
                    content: `Error: No task found with ID "${taskId}". Use list_sub_agents to see all active tasks.`,
                    isError: true,
                };
            }
            const out = {
                task_id: record.taskId,
                status: record.status,
                pending_human_approval: record.pendingHumanApproval,
                created_at: new Date(record.createdAt).toISOString(),
            };
            if (record.startedAt)
                out['started_at'] = new Date(record.startedAt).toISOString();
            if (record.completedAt)
                out['completed_at'] = new Date(record.completedAt).toISOString();
            if (record.result) {
                out['result'] = {
                    success: record.result.success,
                    summary: record.result.summary,
                    turns_used: record.result.turnsUsed,
                    cost_usd: record.result.costUsd,
                    duration_ms: record.result.durationMs,
                    input_tokens: record.result.inputTokens,
                    output_tokens: record.result.outputTokens,
                    ...(record.result.error ? { error: record.result.error } : {}),
                };
            }
            if (record.pendingHumanApproval) {
                out['_human_approval_required'] =
                    'STOP: present the result above to the user and ask for confirmation before proceeding.';
            }
            return { content: JSON.stringify(out, null, 2), isError: false };
        },
    };
}
//# sourceMappingURL=get_sub_agent_status.js.map