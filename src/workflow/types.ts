import type { ToolCallContext } from '../core/types.js'

export type GateType = 'REQUIRED' | 'APPROVAL' | 'SUGGESTED'

export interface GateItem {
  id: string          // '<phaseId>_gate_<index>'
  type: GateType
  description: string
  completed: boolean
}

export interface WorkflowPhase {
  id: string
  chineseName: string
  englishName: string
  index: number       // 0-based
  content: string     // full markdown body of this phase section
  gateItems: GateItem[]
  outputs: string[]
}

export interface WorkflowDefinition {
  mode: string
  version: string
  title: string
  globalContext: string   // text before first Phase header
  phases: WorkflowPhase[]
  sourceFile: string
}

export interface PhaseHistory {
  phaseId: string
  enteredAt: number
  completedAt?: number
  advancedBy: 'agent' | 'user'
}

export interface WorkflowState {
  schemaVersion: '1.0'
  projectDir: string
  mode: string
  workflowSourceFile: string
  currentPhaseId: string
  currentPhaseEnteredAt: number
  completedGateItems: string[]   // array of gateItem IDs (serialized Set)
  phaseHistory: PhaseHistory[]
}

export interface GateCheckResult {
  canAdvance: boolean
  blockedBy: GateItem[]     // REQUIRED not completed
  needsApproval: GateItem[] // APPROVAL not completed
  suggested: GateItem[]     // SUGGESTED not completed
}

// Re-export ToolCallContext so workflow tools can import it from here
export type { ToolCallContext }
