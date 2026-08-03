import { readdir, stat } from 'fs/promises'
import { isAbsolute, join, resolve } from 'path'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { dynamicDescription } from '../../util.js'
import { assertInsideWorkspace } from '../workspaceGuard.js'

/**
 * "Does this directory exist, and what is directly in it?"
 *
 * That question kept being asked with `glob`, which answers it by walking the
 * entire tree — and in a repository carrying a 32,307-file vendored dependency
 * directory the walk exhausted its budget elsewhere and reported "No files
 * found". A compiler stage then recorded, as a confirmed fact, that a source
 * directory holding 45 Python files did not exist.
 *
 * A directory question deserves a directory primitive: one `readdir`, an exact
 * answer, and — critically — an unambiguous distinction between "this path is
 * absent" and "this path exists and is empty", which no pattern search can
 * express.
 */
const MAX_ENTRIES = 200

/** Counting a huge child costs a full walk, so report a floor instead. */
const CHILD_COUNT_CEILING = 1000

async function countEntries(dir: string): Promise<{ count: number; atLeast: boolean }> {
  try {
    const entries = await readdir(dir)
    return { count: Math.min(entries.length, CHILD_COUNT_CEILING), atLeast: entries.length > CHILD_COUNT_CEILING }
  } catch {
    return { count: 0, atLeast: false }
  }
}

export async function createListDirTool(): Promise<MetaAgentTool> {
  return {
    name: 'list_dir',
    description: dynamicDescription(import.meta.url, base => base),
    isConcurrencySafe: true,
    permission: { category: 'read', pathFields: ['path'], requiresWorkspace: true, planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list. Relative paths resolve against the workspace root.' },
      },
      required: ['path'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const workspaceRoot = ctx.workspaceRoot ?? process.cwd()
      const raw = (input['path'] as string | undefined) ?? '.'
      const target = isAbsolute(raw) ? resolve(raw) : resolve(workspaceRoot, raw)
      const workspaceError = assertInsideWorkspace(target, workspaceRoot)
      if (workspaceError) return { content: workspaceError, isError: true }

      let info
      try {
        info = await stat(target)
      } catch {
        // A definite, quotable negative. This is the sentence a caller may act
        // on; `glob` must never produce it from an early exit.
        return { content: `Directory does not exist: ${target}`, isError: false }
      }
      if (!info.isDirectory()) return { content: `Not a directory (it is a file): ${target}`, isError: false }

      let entries
      try {
        entries = await readdir(target, { withFileTypes: true })
      } catch (err) {
        return { content: `Error reading ${target}: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
      if (!entries.length) return { content: `Directory exists but is EMPTY: ${target}`, isError: false }

      const shown = [...entries]
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .slice(0, MAX_ENTRIES)
      const lines: string[] = []
      for (const entry of shown) {
        if (entry.isDirectory()) {
          const { count, atLeast } = await countEntries(join(target, entry.name))
          lines.push(`${entry.name}/  (${atLeast ? `${count}+` : count} entries)`)
          continue
        }
        let size = ''
        try { size = ` (${(await stat(join(target, entry.name))).size} bytes)` } catch { /* vanished */ }
        lines.push(`${entry.name}${size}`)
      }
      const omitted = entries.length > MAX_ENTRIES ? `\n[${entries.length - MAX_ENTRIES} more entries omitted]` : ''
      return { content: `${target} (${entries.length} entries)\n${lines.join('\n')}${omitted}`, isError: false }
    },
  }
}
