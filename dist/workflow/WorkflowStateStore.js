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
    static isCompatible(definition, state) {
        if (state.schemaVersion !== '1.0')
            return false;
        if (state.mode !== definition.mode)
            return false;
        if (state.workflowSourceFile !== definition.sourceFile)
            return false;
        if (definition.workflowBlockHash && state.workflowBlockHash !== definition.workflowBlockHash)
            return false;
        if (definition.workflowDefinitionHash && state.workflowDefinitionHash !== definition.workflowDefinitionHash)
            return false;
        return definition.phases.some(p => p.id === state.currentPhaseId);
    }
    static async readCompatible(projectDir, definition) {
        const state = await WorkflowStateStore.read(projectDir);
        return state && WorkflowStateStore.isCompatible(definition, state) ? state : null;
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
            workflowBlockHash: definition.workflowBlockHash,
            workflowDefinitionHash: definition.workflowDefinitionHash,
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
    static async completeCurrentPhaseGateItem(projectDir, definition, gateItemId) {
        const state = await WorkflowStateStore.readCompatible(projectDir, definition);
        if (!state)
            throw new Error('Workflow state is not compatible with current definition');
        const phase = definition.phases.find(p => p.id === state.currentPhaseId);
        if (!phase)
            throw new Error(`Unknown workflow phase: ${state.currentPhaseId}`);
        if (!phase.gateItems.some(g => g.id === gateItemId)) {
            throw new Error(`Gate "${gateItemId}" is not part of the current workflow phase`);
        }
        if (!state.completedGateItems.includes(gateItemId)) {
            state.completedGateItems.push(gateItemId);
            await WorkflowStateStore.write(projectDir, state);
        }
        return state;
    }
    static async advancePhase(projectDir, definition, advancedBy) {
        const state = await WorkflowStateStore.readCompatible(projectDir, definition);
        if (!state)
            throw new Error('Workflow state is not compatible with current definition');
        const currentIdx = definition.phases.findIndex(p => p.id === state.currentPhaseId);
        if (currentIdx < 0)
            throw new Error(`Unknown workflow phase: ${state.currentPhaseId}`);
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
        if (!phase) {
            return {
                canAdvance: false,
                blockedBy: [],
                needsApproval: [],
                suggested: [],
            };
        }
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