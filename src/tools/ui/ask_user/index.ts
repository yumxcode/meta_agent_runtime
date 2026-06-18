import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

export async function createAskUserTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'ask_user',
    abortSupport: 'non_cooperative',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional list of choices' },
      },
      required: ['question'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const question = input['question'] as string
      const options = (input['options'] as string[] | undefined) ?? []
      if (!question) return { content: 'Error: question is required', isError: true }
      if (ctx.askUser) {
        try {
          const answer = await ctx.askUser(question, options)
          return { content: answer, isError: false }
        } catch (err) {
          return { content: `Error getting user input: ${err instanceof Error ? err.message : String(err)}`, isError: true }
        }
      }
      const optStr = options.length > 0 ? `\nOptions:\n${options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}` : ''
      return {
        content: `[Human input required]\nQuestion: ${question}${optStr}\n\nNote: Configure askUser callback in ToolCallContext to enable interactive input.`,
        isError: false,
      }
    },
  }
}
