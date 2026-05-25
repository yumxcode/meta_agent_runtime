import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

/**
 * EnterPlanMode — activate plan mode on the parent MetaAgentSession.
 *
 * The session exposes _planModeRef as a mutable { active: boolean } object.
 * We retrieve it via ctx.sessionId lookup from the global session registry,
 * or alternatively the tool is constructed with a direct ref injection.
 */
export async function createEnterPlanModeTool(
  planModeRef: { active: boolean },
): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'enter_plan_mode',
    description,
    isConcurrencySafe: true,   // toggling a flag has no filesystem side-effects
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    async call(_input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      if (planModeRef.active) {
        return { content: 'Already in plan mode. Use exit_plan_mode to leave.', isError: false }
      }
      planModeRef.active = true
      return {
        content: [
          '✅ Plan mode activated.',
          '',
          'All side-effecting tool calls (write_file, edit_file, bash, powershell, mcp_call…)',
          'will now pause and ask for your approval before executing.',
          'Read-only tools (read_file, glob, grep, web_fetch…) continue to run freely.',
          '',
          'Call exit_plan_mode to return to normal execution.',
        ].join('\n'),
        isError: false,
      }
    },
  }
}
