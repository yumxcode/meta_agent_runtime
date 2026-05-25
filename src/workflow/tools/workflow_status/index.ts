import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import type { WorkflowDefinition, WorkflowState } from '../../types.js'
import { WorkflowStateStore } from '../../WorkflowStateStore.js'

export function createWorkflowStatusTool(
  definition: WorkflowDefinition,
  getState: () => WorkflowState | null,
): MetaAgentTool {
  return {
    name: 'workflow_status',
    description: 'Show current workflow phase, gate criteria status, and next phase preview.',
    isConcurrencySafe: true,
    inputSchema: { type: 'object', properties: {} },
    async call(_input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const state = getState()
      if (!state) return { content: 'No workflow state found. Workflow may not be initialised.', isError: true }
      const phase = definition.phases.find(p => p.id === state.currentPhaseId)
      if (!phase) return { content: `Unknown phase: ${state.currentPhaseId}`, isError: true }
      const check = WorkflowStateStore.checkGates(definition, state)
      const completed = new Set(state.completedGateItems)
      const gates = phase.gateItems.map(g => ({ ...g, completed: completed.has(g.id) }))
      const nextPhase = definition.phases[phase.index + 1]
      const result = {
        currentPhase: { id: phase.id, chineseName: phase.chineseName, englishName: phase.englishName, index: phase.index, enteredAt: state.currentPhaseEnteredAt },
        gates,
        allRequiredMet: check.canAdvance,
        blockedBy: check.blockedBy.map(g => g.id),
        needsApproval: check.needsApproval.map(g => g.id),
        nextPhase: nextPhase ? { id: nextPhase.id, name: nextPhase.chineseName } : null,
        totalPhases: definition.phases.length,
      }
      return { content: JSON.stringify(result, null, 2), isError: false }
    },
  }
}
