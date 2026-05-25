/**
 * Sub-Agent Task System — core types
 *
 * A sub-agent is an isolated MetaAgentSession spawned by the main agent to
 * handle a long-running or specialised sub-task.  The main agent communicates
 * with it only through this type-safe status/result layer — never through
 * shared conversation history.
 *
 * Design invariants (§9 of meta-agent-architecture.md):
 *   1. Sub-agent context is fully isolated (empty mutableMessages on start).
 *   2. Main agent only sees the terminal result by default.
 *   3. Circuit breakers (maxTurns, maxBudgetUsd) are enforced in code, not prompt.
 *   4. Human-approval gate is implemented at the tool-handler layer.
 */
export function makeSubAgentTaskId() {
    const uuid8 = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    return `subtask-${uuid8}`;
}
export const TERMINAL_STATUSES = new Set([
    'completed', 'failed', 'cancelled',
]);
/** Defaults applied by SubAgentBridge.spawnSubAgent() */
export const DEFAULT_SUB_AGENT_CONFIG = {
    systemPrompt: undefined,
    allowedTools: undefined,
    maxTurns: 10,
    maxBudgetUsd: 0.5,
    useEventDriven: true,
    pollIntervalMs: 1_800_000,
    requireHumanApproval: false,
    checkpointEveryNTurns: 3,
};
//# sourceMappingURL=types.js.map