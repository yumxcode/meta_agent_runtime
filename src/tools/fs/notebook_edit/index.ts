import { readFile, stat, writeFile } from 'fs/promises'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { assertInsideWorkspace } from '../workspaceGuard.js'

interface NbCell { cell_type: string; source: string[]; metadata?: Record<string,unknown>; outputs?: unknown[]; execution_count?: number | null }
interface Notebook { cells: NbCell[]; metadata?: Record<string,unknown>; nbformat?: number; nbformat_minor?: number }

const MAX_NOTEBOOK_BYTES = 5 * 1024 * 1024

export async function createNotebookEditTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'notebook_edit',
    description,
    permission: { category: 'write', pathFields: ['notebook_path'], requiresWorkspace: true, sensitive: true, planMode: 'ask' },
    inputSchema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string', description: 'Absolute path to the .ipynb file' },
        cell_number: { type: 'number', description: '0-indexed cell position' },
        new_source: { type: 'string', description: 'New cell content' },
        cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Default: code' },
        edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Default: replace' },
      },
      required: ['notebook_path', 'cell_number'],
    },
    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const p = input['notebook_path'] as string
      const n = input['cell_number'] as number
      const src = input['new_source'] as string | undefined
      const ct = (input['cell_type'] as string | undefined) ?? 'code'
      const mode = (input['edit_mode'] as string | undefined) ?? 'replace'
      if (!p) return { content: 'Error: notebook_path required', isError: true }
      const workspaceError = assertInsideWorkspace(p, _ctx.workspaceRoot)
      if (workspaceError) return { content: workspaceError, isError: true }
      if (mode !== 'delete' && src === undefined) return { content: 'Error: new_source required', isError: true }
      // Auto mode: hold the path lock across the read-modify-write (no-op otherwise).
      const release = _ctx.writeMutex ? await _ctx.writeMutex.acquire(p) : null
      try {
        const fileStat = await stat(p)
        if (fileStat.size > MAX_NOTEBOOK_BYTES) {
          return { content: `Error: notebook is too large to edit safely (${fileStat.size} bytes).`, isError: true }
        }
        const nb = JSON.parse(await readFile(p, 'utf-8')) as Notebook
        if (!Array.isArray(nb.cells)) return { content: 'Error: invalid notebook', isError: true }
        const toLines = (s: string) => s.split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l)
        if (mode === 'delete') {
          if (n < 0 || n >= nb.cells.length) return { content: `Error: cell ${n} out of range`, isError: true }
          nb.cells.splice(n, 1)
        } else if (mode === 'insert') {
          nb.cells.splice(n, 0, { cell_type: ct, source: toLines(src!), metadata: {}, ...(ct === 'code' ? { outputs: [], execution_count: null } : {}) })
        } else {
          if (n < 0 || n >= nb.cells.length) return { content: `Error: cell ${n} out of range`, isError: true }
          const cell = nb.cells[n]!
          cell.source = toLines(src!)
          cell.cell_type = ct
          if (ct === 'code') { cell.outputs = cell.outputs ?? []; cell.execution_count = null }
        }
        await writeFile(p, JSON.stringify(nb, null, 1), 'utf-8')
        return { content: `Cell ${n} ${mode}d in ${p}`, isError: false }
      } catch (err) { return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true } }
      finally { release?.() }
    },
  }
}
