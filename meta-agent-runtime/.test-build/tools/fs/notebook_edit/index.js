import { readFileSync, writeFileSync } from 'fs';
import { loadToolPrompt } from '../../util.js';
export async function createNotebookEditTool() {
    const description = await loadToolPrompt(import.meta.url);
    return {
        name: 'notebook_edit',
        description,
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
        async call(input, _ctx) {
            const p = input['notebook_path'];
            const n = input['cell_number'];
            const src = input['new_source'];
            const ct = input['cell_type'] ?? 'code';
            const mode = input['edit_mode'] ?? 'replace';
            if (!p)
                return { content: 'Error: notebook_path required', isError: true };
            if (mode !== 'delete' && src === undefined)
                return { content: 'Error: new_source required', isError: true };
            try {
                const nb = JSON.parse(readFileSync(p, 'utf-8'));
                if (!Array.isArray(nb.cells))
                    return { content: 'Error: invalid notebook', isError: true };
                const toLines = (s) => s.split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l);
                if (mode === 'delete') {
                    if (n < 0 || n >= nb.cells.length)
                        return { content: `Error: cell ${n} out of range`, isError: true };
                    nb.cells.splice(n, 1);
                }
                else if (mode === 'insert') {
                    nb.cells.splice(n, 0, { cell_type: ct, source: toLines(src), metadata: {}, ...(ct === 'code' ? { outputs: [], execution_count: null } : {}) });
                }
                else {
                    if (n < 0 || n >= nb.cells.length)
                        return { content: `Error: cell ${n} out of range`, isError: true };
                    const cell = nb.cells[n];
                    cell.source = toLines(src);
                    cell.cell_type = ct;
                    if (ct === 'code') {
                        cell.outputs = cell.outputs ?? [];
                        cell.execution_count = null;
                    }
                }
                writeFileSync(p, JSON.stringify(nb, null, 1), 'utf-8');
                return { content: `Cell ${n} ${mode}d in ${p}`, isError: false };
            }
            catch (err) {
                return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map