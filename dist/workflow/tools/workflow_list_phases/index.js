export function createWorkflowListPhasesTool(definition, getState) {
    return {
        name: 'workflow_list_phases',
        description: 'List all workflow phases with their status (completed/active/pending).',
        isConcurrencySafe: true,
        inputSchema: { type: 'object', properties: {} },
        async call(_input, _ctx) {
            const state = getState();
            const currentId = state?.currentPhaseId;
            const completedIds = new Set(state?.phaseHistory.filter(h => h.completedAt).map(h => h.phaseId) ?? []);
            const phases = definition.phases.map(p => ({
                id: p.id,
                chineseName: p.chineseName,
                englishName: p.englishName,
                index: p.index + 1,
                status: completedIds.has(p.id) ? 'completed' : p.id === currentId ? 'active' : 'pending',
                requiredGates: p.gateItems.filter(g => g.type === 'REQUIRED').length,
                approvalGates: p.gateItems.filter(g => g.type === 'APPROVAL').length,
                outputs: p.outputs,
            }));
            return { content: JSON.stringify(phases, null, 2), isError: false };
        },
    };
}
//# sourceMappingURL=index.js.map