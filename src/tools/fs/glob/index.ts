import { readdir, stat } from 'fs/promises'
import { join, relative, basename } from 'path'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { dynamicDescription } from '../../util.js'
import { assertInsideWorkspace } from '../workspaceGuard.js'

function matchGlob(pattern: string, filePath: string): boolean {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    const next = pattern[i + 1]
    const afterNext = pattern[i + 2]
    if (ch === '*' && next === '*' && afterNext === '/') {
      out += '(?:.*\\/)?'
      i += 2
    } else if (ch === '*' && next === '*') {
      out += '.*'
      i += 1
    } else if (ch === '*') {
      out += '[^/]*'
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i + 1)
      if (end > i) {
        out += `(${pattern.slice(i + 1, end).split(',').map(s => s.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|')})`
        i = end
      } else {
        out += '\\{'
      }
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  try { return new RegExp(`^${out}$`).test(filePath) } catch { return false }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '__pycache__'])

async function walkDir(dir: string, results: Array<{ path: string; mtime: number }>, max: number, signal?: AbortSignal): Promise<void> {
  if (results.length >= max) return
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (results.length >= max || signal?.aborted) break
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walkDir(full, results, max, signal)
      } else {
        try { results.push({ path: full, mtime: (await stat(full)).mtimeMs }) } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
}

export async function createGlobTool(): Promise<MetaAgentTool> {
  const description = dynamicDescription(import.meta.url, (base, ctx) => {
    const note = ctx.toolNames.has('bash')
      ? '\n\nIMPORTANT: Use this `glob` tool to find files by name pattern. Do NOT use `find` or `ls` via bash.'
      : ''
    return base + note
  })
  return {
    name: 'glob',
    description,
    isConcurrencySafe: true,
    permission: { category: 'read', pathFields: ['path'], requiresWorkspace: true, planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts")' },
        path: { type: 'string', description: 'Directory to search in. Defaults to workspace root.' },
      },
      required: ['pattern'],
    },
    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const pattern = input['pattern'] as string
      const workspaceRoot = _ctx.workspaceRoot ?? process.cwd()
      const searchPath = (input['path'] as string | undefined) ?? workspaceRoot
      if (!pattern) return { content: 'Error: pattern is required', isError: true }
      const workspaceError = assertInsideWorkspace(searchPath, workspaceRoot)
      if (workspaceError) return { content: workspaceError, isError: true }
      try {
        const allFiles: Array<{ path: string; mtime: number }> = []
        await walkDir(searchPath, allFiles, 5000, _ctx.abortSignal)
        const matched = allFiles.filter(f => {
          const rel = relative(searchPath, f.path)
          return matchGlob(pattern, rel) || matchGlob(pattern, basename(f.path))
        })
        matched.sort((a, b) => b.mtime - a.mtime)
        const results = matched.slice(0, 100).map(f => f.path)
        if (results.length === 0) return { content: `No files found matching "${pattern}" in ${searchPath}`, isError: false }
        const truncated = matched.length > 100 ? `\n[${matched.length - 100} more results omitted]` : ''
        return { content: results.join('\n') + truncated, isError: false }
      } catch (err) {
        return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}
