export { createWorkflowStatusTool } from './workflow_status/index.js'
export { createWorkflowCompleteGateTool } from './workflow_complete_gate/index.js'
export { createWorkflowAdvanceTool } from './workflow_advance/index.js'
export { createWorkflowListPhasesTool } from './workflow_list_phases/index.js'

import type { MetaAgentTool } from '../../core/types.js'
import type { WorkflowDefinition, WorkflowState } from '../types.js'
import { createWorkflowStatusTool } from './workflow_status/index.js'
import { createWorkflowCompleteGateTool } from './workflow_complete_gate/index.js'
import { createWorkflowAdvanceTool } from './workflow_advance/index.js'
import { createWorkflowListPhasesTool } from './workflow_list_phases/index.js'

export function createWorkflowTools(
  projectDir: string,
  definition: WorkflowDefinition,
  getState: () => WorkflowState | null,
  onStateChange: (s: WorkflowState) => void,
): MetaAgentTool[] {
  return [
    createWorkflowStatusTool(definition, getState),
    createWorkflowCompleteGateTool(projectDir, definition, onStateChange),
    createWorkflowAdvanceTool(projectDir, definition, onStateChange),
    createWorkflowListPhasesTool(definition, getState),
  ]
}
