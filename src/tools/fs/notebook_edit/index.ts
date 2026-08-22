import { readFile, stat, writeFile } from 'fs/promises'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { resolveInsideWorkspace } from '../workspaceGuard.js'

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
      // resolveInsideWorkspace, not assertInsideWorkspace: this tool used to
      // VALIDATE `p` against workspaceRoot and then stat/read/write the raw `p`.
      // Node resolves a relative path against process.cwd(), so whenever cwd
      // differs from the workspace root — which is the normal case for a
      // `-w <dir>` run — the path that was checked and the path that was
      // written were different files. Every other fs tool was moved onto
      // resolveInsideWorkspace for exactly this reason; this one was missed.
      // It also means writeMutex keys on the canonical path, so two spellings
      // of the same notebook can no longer take two different locks.
      const resolved = resolveInsideWorkspace(p, _ctx.workspaceRoot)
      if (!resolved.ok) return { content: resolved.error, isError: true }
      const notebookPath = resolved.path
      if (mode !== 'delete' && src === undefined) return { content: 'Error: new_source required', isError: true }
      // Auto mode: hold the path lock across the read-modify-write (no-op otherwise).
      const release = _ctx.writeMutex ? await _ctx.writeMutex.acquire(notebookPath) : null
      try {
        const fileStat = await stat(notebookPath)
        if (fileStat.size > MAX_NOTEBOOK_BYTES) {
          return { content: `Error: notebook is too large to edit safely (${fileStat.size} bytes).`, isError: true }
        }
        const nb = JSON.parse(await readFile(notebookPath, 'utf-8')) as Notebook
        if (!Array.isArray(nb.cells)) return { content: 'Error: invalid notebook', isError: true }
        const toLines = (s: string) => s.split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l)
        if (mode === 'delete') {
          if (n < 0 || n >= nb.cells.length) return { content: `Error: cell ${n} out of range`, isError: true }
          nb.cells.splice(n, 1)
        } else if (mode === 'insert') {
          // Bound the index explicitly. splice() silently clamps a too-large n
          // to "append" and treats a NEGATIVE n as an offset from the END, so
          // `cell_number: -1` quietly inserted before the last cell instead of
          // reporting a bad index. Inserting AT length is legitimate (append).
          if (n < 0 || n > nb.cells.length) {
            return { content: `Error: cell ${n} out of range (0..${nb.cells.length} for insert)`, isError: true }
          }
          nb.cells.splice(n, 0, { cell_type: ct, source: toLines(src!), metadata: {}, ...(ct === 'code' ? { outputs: [], execution_count: null } : {}) })
        } else {
          if (n < 0 || n >= nb.cells.length) return { content: `Error: cell ${n} out of range`, isError: true }
          const cell = nb.cells[n]!
          cell.source = toLines(src!)
          cell.cell_type = ct
          if (ct === 'code') {
            // Clear outputs, don't preserve them. This used to be
            // `cell.outputs = cell.outputs ?? []`, which kept the OLD source's
            // outputs while simultaneously setting execution_count = null —
            // a cell that claims "never executed" and still displays results.
            // Anyone reading the notebook (including the agent on a later
            // read_file) sees output that does not belong to the code above it.
            cell.outputs = []
            cell.execution_count = null
          } else {
            // nbformat forbids `outputs` / `execution_count` on a markdown
            // cell; leaving them behind produces a notebook that fails
            // validation and that some readers refuse to open.
            delete cell.outputs
            delete cell.execution_count
          }
        }
        await _ctx.turnDiff?.capture(notebookPath)
        await writeFile(notebookPath, JSON.stringify(nb, null, 1), 'utf-8')
        return { content: `Cell ${n} ${mode}d in ${notebookPath}`, isError: false }
      } catch (err) { return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true } }
      finally { release?.() }
    },
  }
}
