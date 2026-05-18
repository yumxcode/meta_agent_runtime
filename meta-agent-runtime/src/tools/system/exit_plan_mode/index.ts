import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

export async function createExitPlanModeTool(
  planModeRef: { active: boolean },
): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'exit_plan_mode',
    description,
    isConcurrencySafe: true,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    async call(_input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      if (!planModeRef.active) {
        return { content: 'Not in plan mode. Call enter_plan_mode first.', isError: true }
      }
      planModeRef.active = false
      return {
        content: '✅ Plan mode deactivated. Tools will now execute without approval.',
        isError: false,
      }
    },
  }
}
