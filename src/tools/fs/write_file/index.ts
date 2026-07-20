import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { resolveInsideWorkspace } from '../workspaceGuard.js'

const MAX_WRITE_BYTES = 5 * 1024 * 1024

export async function createWriteFileTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'write_file',
    description,
    // NOT sensitive: writes inside the workspace auto-allow without approval in
    // every mode. Workspace boundary stays hard-enforced; plan mode still gates.
    permission: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: false, planMode: 'ask' },
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const rawPath = input['file_path'] as string
      const content = input['content'] as string
      if (!rawPath) return { content: 'Error: file_path is required', isError: true }
      const resolved = resolveInsideWorkspace(rawPath, _ctx.workspaceRoot)
      if (!resolved.ok) return { content: resolved.error, isError: true }
      // Execute on the canonical absolute path the guard approved — never the
      // raw input — so the byte we validated is the byte we write.
      const filePath = resolved.path
      if (content === undefined || content === null) return { content: 'Error: content is required', isError: true }
      if (Buffer.byteLength(content, 'utf-8') > MAX_WRITE_BYTES) {
        return { content: `Error: content is too large to write safely (${Buffer.byteLength(content, 'utf-8')} bytes).`, isError: true }
      }
      // Auto mode: serialise concurrent writers to the same path (no-op when the
      // mutex is absent, i.e. non-auto sessions).
      const release = _ctx.writeMutex ? await _ctx.writeMutex.acquire(filePath) : null
      let temporary: string | undefined
      try {
        await mkdir(dirname(filePath), { recursive: true })
        temporary = join(dirname(filePath), `.${randomUUID()}.write`)
        await writeFile(temporary, content, 'utf-8')
        await rename(temporary, filePath)
        temporary = undefined
        const lines = content.split('\n').length
        return { content: `Successfully wrote ${lines} lines to ${filePath}`, isError: false }
      } catch (err) {
        return { content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      } finally {
        if (temporary) await rm(temporary, { force: true }).catch(() => undefined)
        release?.()
      }
    },
  }
}
