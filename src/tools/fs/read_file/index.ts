import { readFile, stat } from 'fs/promises'
import { extname } from 'path'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { dynamicDescription } from '../../util.js'

const MAX_LINES = 2000
const MAX_READ_BYTES = 5 * 1024 * 1024

export async function createReadFileTool(): Promise<MetaAgentTool> {
  const description = dynamicDescription(import.meta.url, (base, ctx) => {
    const hints: string[] = []
    if (ctx.toolNames.has('bash')) hints.push('- Do NOT use `cat`, `head`, or `tail` via bash to read files.')
    if (ctx.toolNames.has('edit_file')) hints.push('- To modify a file, use `edit_file` (not read + write).')
    return hints.length ? `${base}\n\n${hints.join('\n')}` : base
  })
  return {
    name: 'read_file',
    description,
    isConcurrencySafe: true,
    permission: { category: 'read', pathFields: ['file_path'], requiresWorkspace: true, planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed). Default: 1' },
        limit: { type: 'number', description: 'Maximum number of lines to read. Default: 2000' },
      },
      required: ['file_path'],
    },
    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const filePath = input['file_path'] as string
      const offset = typeof input['offset'] === 'number' ? Math.max(1, input['offset']) : 1
      const limit = typeof input['limit'] === 'number' ? input['limit'] : MAX_LINES

      if (!filePath) return { content: 'Error: file_path is required', isError: true }

      try {
        const fileStat = await stat(filePath)
        if (fileStat.isDirectory()) return { content: `Error: ${filePath} is a directory. Use bash to list directories.`, isError: true }
        if (fileStat.size > MAX_READ_BYTES) {
          return {
            content: `Error: file is too large to read safely (${fileStat.size} bytes). Use a more targeted command or split the file first.`,
            isError: true,
          }
        }

        const ext = extname(filePath).toLowerCase()

        // Jupyter notebooks
        if (ext === '.ipynb') {
          const raw = await readFile(filePath, 'utf-8')
          _ctx.readFileState?.record(filePath, fileStat.size)
          const nb = JSON.parse(raw) as { cells?: Array<{ cell_type: string; source: string[] | string; outputs?: unknown[] }> }
          const cells = nb.cells ?? []
          const lines: string[] = []
          cells.forEach((cell, i) => {
            const src = Array.isArray(cell.source) ? cell.source.join('') : cell.source
            lines.push(`## Cell ${i + 1} [${cell.cell_type}]`, src, '')
          })
          return { content: lines.join('\n'), isError: false }
        }

        const raw = await readFile(filePath, 'utf-8')
        _ctx.readFileState?.record(filePath, fileStat.size)
        const allLines = raw.split('\n')
        const startIdx = offset - 1
        const sliced = allLines.slice(startIdx, startIdx + limit)
        const formatted = sliced.map((line, i) => `${String(startIdx + i + 1).padStart(4)}\t${line}`).join('\n')
        const truncated = allLines.length > startIdx + limit
        const footer = truncated ? `\n\n[Showing lines ${offset}–${offset + limit - 1} of ${allLines.length}]` : ''
        return { content: formatted + footer, isError: false }
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return { content: `File not found: ${filePath}`, isError: true }
        return { content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}
