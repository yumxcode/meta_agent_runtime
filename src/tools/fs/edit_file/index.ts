import { readFile, stat, writeFile } from 'fs/promises'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { assertInsideWorkspace } from '../workspaceGuard.js'

const MAX_EDIT_BYTES = 5 * 1024 * 1024

export async function createEditFileTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'edit_file',
    description,
    // sensitive: false — in-place edits INSIDE the workspace run without user
    // approval; paths outside the workspace are still denied by the policy.
    permission: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: false, planMode: 'ask' },
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
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const filePath = input['file_path'] as string
      const oldStr = input['old_string'] as string
      const newStr = input['new_string'] as string
      const replaceAll = input['replace_all'] === true
      if (!filePath) return { content: 'Error: file_path is required', isError: true }
      // H3: empty old_string would explode the file character-by-character
      // (split('').length === content.length+1) — reject up front.
      if (typeof oldStr !== 'string' || oldStr.length === 0) {
        return { content: 'Error: old_string must be a non-empty string', isError: true }
      }
      if (typeof newStr !== 'string') {
        return { content: 'Error: new_string must be a string', isError: true }
      }
      const workspaceError = assertInsideWorkspace(filePath, ctx.workspaceRoot)
      if (workspaceError) return { content: workspaceError, isError: true }
      try {
        const fileStat = await stat(filePath)
        if (fileStat.size > MAX_EDIT_BYTES) {
          return { content: `Error: file is too large to edit safely (${fileStat.size} bytes). Use a targeted patch workflow.`, isError: true }
        }
        // L4: TOCTOU defence — if read_file recorded a snapshot of this file,
        // refuse to edit when size or mtime has drifted since. Skip the check
        // when there's no recorded snapshot (first-time edit) so existing call
        // sites still work.
        const cacheEntry = ctx.readFileState?.get?.(filePath)
        if (cacheEntry) {
          const sizeChanged = cacheEntry.sizeBytes !== fileStat.size
          const mtimeChanged =
            cacheEntry.mtimeMs !== undefined &&
            Number.isFinite(fileStat.mtimeMs) &&
            Math.abs(fileStat.mtimeMs - cacheEntry.mtimeMs) > 1
          if (sizeChanged || mtimeChanged) {
            return {
              content: `Error: ${filePath} changed on disk since it was last read (size or mtime drifted). Re-read the file (read_file) before editing.`,
              isError: true,
            }
          }
        }

        const content = await readFile(filePath, 'utf-8')
        const pieces = content.split(oldStr)
        const occurrences = pieces.length - 1
        if (occurrences === 0) return { content: `Error: old_string not found in ${filePath}`, isError: true }
        if (!replaceAll && occurrences > 1) return { content: `Error: old_string appears ${occurrences} times. Use replace_all: true or add more context.`, isError: true }
        // H2: use split/join consistently so `$&` / `$1` / `$$` in new_string
        // are inserted verbatim (String.prototype.replace would interpret them).
        const updated = replaceAll
          ? pieces.join(newStr)
          : pieces[0] + newStr + pieces.slice(1).join(oldStr)
        await writeFile(filePath, updated, 'utf-8')
        // Refresh the FileStateCache so subsequent edits in the same turn don't
        // trip the TOCTOU guard on the bytes we just wrote ourselves.
        try {
          const after = await stat(filePath)
          ctx.readFileState?.record?.(filePath, after.size, after.mtimeMs)
        } catch { /* best-effort */ }
        return { content: `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${filePath}`, isError: false }
      } catch (err) {
        return { content: `Error editing file: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}
