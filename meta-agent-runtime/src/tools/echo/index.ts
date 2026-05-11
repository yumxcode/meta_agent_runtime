/**
 * Echo tool — reference implementation of the tool-folder convention.
 *
 * File layout (required for every tool):
 *
 *   src/tools/echo/
 *   ├── prompt.md   ← authoritative description, read at startup
 *   └── index.ts    ← this file: schema + call() implementation
 *
 * Do NOT inline the description as a string literal here.
 * Edit prompt.md instead — it stays readable and diffable.
 */

import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../core/types.js'
import { loadToolPrompt } from '../util.js'

export async function createEchoTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)

  return {
    name: 'echo',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to echo back.',
        },
      },
      required: ['text'],
    },

    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const text = typeof input.text === 'string' ? input.text : JSON.stringify(input.text ?? '')
      return { content: text, isError: false }
    },
  }
}
