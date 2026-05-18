import { readFileSync, writeFileSync } from 'fs'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

export async function createEditFileTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'edit_file',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_string: { type: 'string', description: 'The exact string to replace' },
        new_string: { type: 'string', description: 'The replacement string' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences. Default: false' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const filePath = input['file_path'] as string
      const oldStr = input['old_string'] as string
      const newStr = input['new_string'] as string
      const replaceAll = input['replace_all'] === true
      if (!filePath) return { content: 'Error: file_path is required', isError: true }
      try {
        const content = readFileSync(filePath, 'utf-8')
        const occurrences = content.split(oldStr).length - 1
        if (occurrences === 0) return { content: `Error: old_string not found in ${filePath}`, isError: true }
        if (!replaceAll && occurrences > 1) return { content: `Error: old_string appears ${occurrences} times. Use replace_all: true or add more context.`, isError: true }
        const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr)
        writeFileSync(filePath, updated, 'utf-8')
        return { content: `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${filePath}`, isError: false }
      } catch (err) {
        return { content: `Error editing file: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}
