import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import type { WorkflowDefinition, WorkflowState } from '../../types.js'
import { WorkflowStateStore } from '../../WorkflowStateStore.js'

export function createWorkflowAdvanceTool(
  projectDir: string,
  definition: WorkflowDefinition,
  onStateChange: (s: WorkflowState) => void,
): MetaAgentTool {
  return {
    name: 'workflow_advance',
    description: 'Advance to the next workflow phase. All REQUIRED gates must be met. APPROVAL gates trigger a user confirmation request.',
    inputSchema: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: 'Set true to skip approval prompt (only after explicit user confirmation in conversation)' },
      },
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const state = await WorkflowStateStore.read(projectDir)
      if (!state) return { content: 'No workflow state. Initialise workflow first.', isError: true }
      const check = WorkflowStateStore.checkGates(definition, state)
      if (!check.canAdvance) {
        const list = check.blockedBy.map(g => `  - [${g.id}] ${g.description}`).join('\n')
        return { content: `Cannot advance: ${check.blockedBy.length} REQUIRED gate(s) not met:\n${list}\n\nComplete these with workflow_complete_gate first.`, isError: true }
      }
      // Handle APPROVAL gates
      if (check.needsApproval.length > 0 && !input['confirmed']) {
        if (ctx.askUser) {
          const approvalList = check.needsApproval.map(g => `• ${g.description}`).join('\n')
          const answer = await ctx.askUser(
            `Advancing to next phase requires your approval:\n\n${approvalList}\n\nDo you confirm?`,
            ['Yes, advance to next phase', 'No, not yet'],
          )
          if (!answer.includes('Yes')) return { content: 'Advance cancelled by user.', isError: false }
          // Mark approval gates as completed
          for (const g of check.needsApproval) {
            await WorkflowStateStore.completeGateItem(projectDir, g.id)
          }
        }
      }
      const { newPhase, state: newState } = await WorkflowStateStore.advancePhase(projectDir, definition, 'agent')
      onStateChange(newState)
      return {
        content: `✅ Advanced to Phase ${newPhase.index + 1}/${definition.phases.length}: ${newPhase.chineseName} (${newPhase.englishName})\n\n${newPhase.content.split('\n').slice(0, 20).join('\n')}`,
        isError: false,
      }
    },
  }
}
