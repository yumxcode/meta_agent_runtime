/**
 * TaskContract — immutable goal anchor for long-running tasks.
 *
 * Created when a task becomes long-running (campaign launch, sub-agent spawn,
 * or explicit user request spanning multiple sessions).  Injected into every
 * subsequent prompt turn above volatile context so the model always has access
 * to the original user intent, non-goals, acceptance criteria, and the
 * user-approved decision log.
 *
 * The contract is updated ONLY through explicit transitions:
 *   - User changes the primary goal
 *   - User approves an escalation or a key decision
 *   - A blocker is discovered
 *   - An acceptance criterion is satisfied or failed
 *
 * It is deliberately NOT updated by LLM-generated summaries — compaction cannot
 * rewrite the task contract.
 */
// ─────────────────────────────────────────────────────────────────────────────
// Factory helpers
// ─────────────────────────────────────────────────────────────────────────────
export function makeContractId() {
    const uuid8 = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    return `contract-${uuid8}`;
}
export function createTaskContract(sessionId, primaryGoal, opts = {}) {
    const now = new Date().toISOString();
    return {
        schemaVersion: '1.0',
        contractId: makeContractId(),
        sessionId,
        createdAt: now,
        updatedAt: now,
        primaryGoal,
        nonGoals: opts.nonGoals ?? [],
        constraints: opts.constraints ?? [],
        acceptanceCriteria: (opts.acceptanceCriteria ?? []).map(c => ({
            ...c,
            status: 'unknown',
        })),
        userApprovedDecisions: [],
        currentPlan: opts.currentPlan ?? [],
        openQuestions: opts.openQuestions ?? [],
        campaignId: opts.campaignId,
        subAgentTaskIds: [],
    };
}
//# sourceMappingURL=types.js.map