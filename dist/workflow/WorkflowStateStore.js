import { join } from 'path';
import { atomicWriteJson, readJsonFile } from '../core/persist/index.js';
export class WorkflowStateStore {
    static stateFile(projectDir) {
        return join(projectDir, '.meta-agent', 'workflow-state.json');
    }
    static async read(projectDir) {
        const s = await readJsonFile(WorkflowStateStore.stateFile(projectDir));
        return s?.schemaVersion === '1.0' ? s : null;
    }
    static async write(projectDir, state) {
        await atomicWriteJson(WorkflowStateStore.stateFile(projectDir), state);
    }
    static async initialize(projectDir, definition) {
        const firstPhase = definition.phases[0];
        if (!firstPhase)
            throw new Error('Workflow has no phases');
        const state = {
            schemaVersion: '1.0',
            projectDir,
            mode: definition.mode,
            workflowSourceFile: definition.sourceFile,
            currentPhaseId: firstPhase.id,
            currentPhaseEnteredAt: Date.now(),
            completedGateItems: [],
            phaseHistory: [{ phaseId: firstPhase.id, enteredAt: Date.now(), advancedBy: 'agent' }],
        };
        await WorkflowStateStore.write(projectDir, state);
        return state;
    }
    static async completeGateItem(projectDir, gateItemId) {
        const state = await WorkflowStateStore.read(projectDir);
        if (!state)
            throw new Error('Workflow state not initialised');
        if (!state.completedGateItems.includes(gateItemId)) {
            state.completedGateItems.push(gateItemId);
            await WorkflowStateStore.write(projectDir, state);
        }
        return state;
    }
    static async advancePhase(projectDir, definition, advancedBy) {
        const state = await WorkflowStateStore.read(projectDir);
        if (!state)
            throw new Error('Workflow state not initialised');
        const currentIdx = definition.phases.findIndex(p => p.id === state.currentPhaseId);
        const nextPhase = definition.phases[currentIdx + 1];
        if (!nextPhase)
            throw new Error('Already at the final phase');
        const now = Date.now();
        const hist = state.phaseHistory.find(h => h.phaseId === state.currentPhaseId && !h.completedAt);
        if (hist)
            hist.completedAt = now;
        state.currentPhaseId = nextPhase.id;
        state.currentPhaseEnteredAt = now;
        state.phaseHistory.push({ phaseId: nextPhase.id, enteredAt: now, advancedBy });
        await WorkflowStateStore.write(projectDir, state);
        return { newPhase: nextPhase, state };
    }
    static checkGates(definition, state) {
        const phase = definition.phases.find(p => p.id === state.currentPhaseId);
        if (!phase)
            return { canAdvance: true, blockedBy: [], needsApproval: [], suggested: [] };
        const completed = new Set(state.completedGateItems);
        const gates = phase.gateItems.map(g => ({ ...g, completed: completed.has(g.id) }));
        return {
            canAdvance: gates.filter(g => g.type === 'REQUIRED').every(g => g.completed),
            blockedBy: gates.filter(g => g.type === 'REQUIRED' && !g.completed),
            needsApproval: gates.filter(g => g.type === 'APPROVAL' && !g.completed),
            suggested: gates.filter(g => g.type === 'SUGGESTED' && !g.completed),
        };
    }
}
//# sourceMappingURL=WorkflowStateStore.js.map