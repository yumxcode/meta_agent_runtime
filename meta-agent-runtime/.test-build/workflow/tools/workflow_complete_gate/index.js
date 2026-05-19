import { WorkflowStateStore } from '../../WorkflowStateStore.js';
export function createWorkflowCompleteGateTool(projectDir, definition, onStateChange) {
    return {
        name: 'workflow_complete_gate',
        description: 'Mark a workflow gate criterion as completed. Use gate_id from workflow_status.',
        inputSchema: {
            type: 'object',
            properties: {
                gate_id: { type: 'string', description: 'Gate item ID (e.g. "development_gate_1")' },
                evidence: { type: 'string', description: 'Optional: brief evidence that this criterion is met' },
            },
            required: ['gate_id'],
        },
        async call(input, _ctx) {
            const gateId = String(input['gate_id'] ?? '').trim();
            if (!gateId)
                return { content: 'Error: gate_id is required', isError: true };
            // Verify gate belongs to current phase
            const allGates = definition.phases.flatMap(p => p.gateItems);
            const gate = allGates.find(g => g.id === gateId);
            if (!gate)
                return { content: `Error: gate "${gateId}" not found. Run workflow_status to see valid IDs.`, isError: true };
            const state = await WorkflowStateStore.completeGateItem(projectDir, gateId);
            onStateChange(state);
            const evidence = input['evidence'] ? ` Evidence: ${input['evidence']}` : '';
            return { content: `✓ Gate "${gateId}" marked complete.${evidence}\nRun workflow_status to see updated gate status.`, isError: false };
        },
    };
}
//# sourceMappingURL=index.js.map