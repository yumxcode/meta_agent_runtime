import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import type { WorkflowDefinition, WorkflowState } from '../../types.js'
import { WorkflowStateStore } from '../../WorkflowStateStore.js'

export function createWorkflowCompleteGateTool(
  projectDir: string,
  definition: WorkflowDefinition,
  onStateChange: (s: WorkflowState) => void,
  sessionId?: string,
): MetaAgentTool {
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
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const gateId = String(input['gate_id'] ?? '').trim()
      if (!gateId) return { content: 'Error: gate_id is required', isError: true }
      const currentState = await WorkflowStateStore.readCompatible(projectDir, definition, sessionId)
      if (!currentState) return { content: 'Error: workflow state is not compatible with current definition.', isError: true }
      const currentPhase = definition.phases.find(p => p.id === currentState.currentPhaseId)
      if (!currentPhase) return { content: `Error: unknown workflow phase "${currentState.currentPhaseId}".`, isError: true }
      const gate = currentPhase.gateItems.find(g => g.id === gateId)
      if (!gate) {
        return {
          content: `Error: gate "${gateId}" is not part of the current phase "${currentPhase.id}". Run workflow_status to see valid IDs.`,
          isError: true,
        }
      }
      const state = await WorkflowStateStore.completeCurrentPhaseGateItem(projectDir, definition, gateId, sessionId)
      onStateChange(state)
      const evidence = input['evidence'] ? ` Evidence: ${input['evidence']}` : ''
      return {
        content: `✓ Gate "${gateId}" marked complete.${evidence}\nRun workflow_status to see updated gate status.`,
        isError: false,
        trajectoryItems: [{
          type: 'phase',
          domain: 'robotics',
          action: 'gate_completed',
          phaseId: currentPhase.id,
          details: {
            toolUseId: ctx.toolUseId,
            gateId,
            evidence: typeof input['evidence'] === 'string' ? input['evidence'] : undefined,
            workflowBlockHash: definition.workflowBlockHash,
            workflowDefinitionHash: definition.workflowDefinitionHash,
            workflowSourceFile: definition.sourceFile,
          },
        }],
      }
    },
  }
}
