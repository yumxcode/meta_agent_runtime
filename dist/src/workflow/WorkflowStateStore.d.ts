import type { WorkflowDefinition, WorkflowPhase, WorkflowState, GateCheckResult } from './types.js';
export declare class WorkflowStateStore {
    static stateFile(projectDir: string): string;
    static read(projectDir: string): Promise<WorkflowState | null>;
    static write(projectDir: string, state: WorkflowState): Promise<void>;
    static initialize(projectDir: string, definition: WorkflowDefinition): Promise<WorkflowState>;
    static completeGateItem(projectDir: string, gateItemId: string): Promise<WorkflowState>;
    static advancePhase(projectDir: string, definition: WorkflowDefinition, advancedBy: 'agent' | 'user'): Promise<{
        newPhase: WorkflowPhase;
        state: WorkflowState;
    }>;
    static checkGates(definition: WorkflowDefinition, state: WorkflowState): GateCheckResult;
}
//# sourceMappingURL=WorkflowStateStore.d.ts.map