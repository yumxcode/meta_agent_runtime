import type { ToolCallContext } from '../core/types.js';
export type GateType = 'REQUIRED' | 'APPROVAL' | 'SUGGESTED';
export interface GateItem {
    id: string;
    type: GateType;
    description: string;
    completed: boolean;
}
export interface WorkflowPhase {
    id: string;
    chineseName: string;
    englishName: string;
    index: number;
    content: string;
    gateItems: GateItem[];
    outputs: string[];
}
export interface WorkflowDefinition {
    mode: string;
    version: string;
    title: string;
    globalContext: string;
    phases: WorkflowPhase[];
    sourceFile: string;
    sourceKind?: 'workflow_file' | 'agent_tag';
    workflowBlockHash?: string;
    workflowDefinitionHash?: string;
}
export interface PhaseHistory {
    phaseId: string;
    enteredAt: number;
    completedAt?: number;
    advancedBy: 'agent' | 'user';
}
export interface WorkflowState {
    schemaVersion: '1.0';
    projectDir: string;
    mode: string;
    workflowSourceFile: string;
    workflowBlockHash?: string;
    workflowDefinitionHash?: string;
    currentPhaseId: string;
    currentPhaseEnteredAt: number;
    completedGateItems: string[];
    phaseHistory: PhaseHistory[];
}
export interface WorkflowRepairInput {
    mode: string;
    sourceFile: string;
    sourceKind: 'workflow_file' | 'agent_tag';
    content: string;
}
export type WorkflowRepairer = (input: WorkflowRepairInput) => Promise<string | null>;
export interface GateCheckResult {
    canAdvance: boolean;
    blockedBy: GateItem[];
    needsApproval: GateItem[];
    suggested: GateItem[];
}
export type { ToolCallContext };
//# sourceMappingURL=types.d.ts.map