import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

export async function createSendMessageTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'send_message',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message content (supports markdown)' },
        status: { type: 'string', enum: ['normal', 'proactive'], description: 'Default: normal' },
      },
      required: ['message'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const message = input['message'] as string
      const status = ((input['status'] as string | undefined) ?? 'normal') as 'normal' | 'proactive'
      if (!message) return { content: 'Error: message is required', isError: true }
      if (ctx.onMessage) ctx.onMessage(message, status)
      return { content: `Message sent (${status}): ${message.slice(0, 100)}${message.length > 100 ? '…' : ''}`, isError: false }
    },
  }
}
