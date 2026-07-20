import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { resolveInsideWorkspace } from '../workspaceGuard.js'

const MAX_APPEND_BYTES = 1024 * 1024

/** Append one text record under the same workspace and mutex policy as write_file. */
export async function createAppendFileTool(): Promise<MetaAgentTool> {
  return {
    name: 'append_file',
    description: 'Append text to a workspace file without replacing existing content. Use this for append-only logs and JSONL records.',
    permission: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: false, planMode: 'ask' },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: 'Absolute or workspace-relative file path' },
        content: { type: 'string', description: 'Text to append exactly as provided' },
      },
      required: ['file_path', 'content'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const rawPath = input.file_path
      const content = input.content
      if (typeof rawPath !== 'string' || !rawPath) return { content: 'Error: file_path is required', isError: true }
      if (typeof content !== 'string') return { content: 'Error: content is required', isError: true }
      if (Buffer.byteLength(content, 'utf8') > MAX_APPEND_BYTES) return { content: 'Error: appended content is too large', isError: true }
      const resolved = resolveInsideWorkspace(rawPath, ctx.workspaceRoot)
      if (!resolved.ok) return { content: resolved.error, isError: true }
      const release = ctx.writeMutex ? await ctx.writeMutex.acquire(resolved.path) : null
      try {
        await mkdir(dirname(resolved.path), { recursive: true })
        await appendFile(resolved.path, content, 'utf8')
        return { content: `Successfully appended ${Buffer.byteLength(content, 'utf8')} bytes to ${resolved.path}`, isError: false }
      } catch (error) {
        return { content: `Error appending file: ${error instanceof Error ? error.message : String(error)}`, isError: true }
      } finally {
        release?.()
      }
    },
  }
}
