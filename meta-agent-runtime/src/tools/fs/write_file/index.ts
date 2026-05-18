import { writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

export async function createWriteFileTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'write_file',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const filePath = input['file_path'] as string
      const content = input['content'] as string
      if (!filePath) return { content: 'Error: file_path is required', isError: true }
      if (content === undefined || content === null) return { content: 'Error: content is required', isError: true }
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, content, 'utf-8')
        const lines = content.split('\n').length
        return { content: `Successfully wrote ${lines} lines to ${filePath}`, isError: false }
      } catch (err) {
        return { content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}
