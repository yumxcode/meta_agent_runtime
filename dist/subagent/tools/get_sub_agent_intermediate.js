/**
 * get_sub_agent_intermediate — retrieve the latest checkpoint of a running sub-agent
 *
 * By default the main agent only sees the final result.  This tool provides
 * explicit access to the most-recent checkpoint (saved every N turns by the
 * SubAgentRunner).
 *
 * Use sparingly — the sub-agent's intermediate reasoning is intentionally
 * opaque to keep the main agent's context clean.  Reach for this tool only
 * when you need to diagnose a stalled sub-task or make a mid-flight decision.
 */
export function makeGetSubAgentIntermediateTool(bridge) {
    return {
        name: 'get_sub_agent_intermediate',
        description: `Retrieve the latest saved checkpoint of a running (or recently completed) sub-agent.

The checkpoint contains the last accumulated text output from the sub-agent, saved every
checkpointEveryNTurns turns (default: every 3 turns).

WHEN TO USE:
- The sub-agent has been running for a long time and you want to check progress
- You need to make a mid-flight decision (e.g., cancel and redirect)
- Debugging a stalled sub-task

WHEN NOT TO USE:
- For the final result — use get_sub_agent_status instead
- Routinely checking on every turn — this adds noise to your context`,
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
            const result = await bridge.getIntermediate(taskId);
            if (!result) {
                return {
                    content: `Error: No task found with ID "${taskId}".`,
                    isError: true,
                };
            }
            if (!result.latestCheckpoint) {
                return {
                    content: JSON.stringify({
                        task_id: result.taskId,
                        status: result.status,
                        message: result.status === 'pending'
                            ? 'Sub-agent has not started yet — no checkpoint available.'
                            : 'No checkpoint saved yet.  The sub-agent may not have completed a full turn, ' +
                                'or checkpointing may be disabled (checkpointEveryNTurns=0).',
                    }, null, 2),
                    isError: false,
                };
            }
            return {
                content: JSON.stringify({
                    task_id: result.taskId,
                    status: result.status,
                    latest_checkpoint: result.latestCheckpoint,
                    latest_checkpoint_at: result.latestCheckpointAt
                        ? new Date(result.latestCheckpointAt).toISOString()
                        : undefined,
                }, null, 2),
                isError: false,
            };
        },
    };
}
//# sourceMappingURL=get_sub_agent_intermediate.js.map