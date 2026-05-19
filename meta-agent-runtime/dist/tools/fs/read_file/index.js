import { readFileSync, existsSync, statSync } from 'fs';
import { extname } from 'path';
import { dynamicDescription } from '../../util.js';
const MAX_LINES = 2000;
export async function createReadFileTool() {
    const description = dynamicDescription(import.meta.url, (base, ctx) => {
        const hints = [];
        if (ctx.toolNames.has('bash'))
            hints.push('- Do NOT use `cat`, `head`, or `tail` via bash to read files.');
        if (ctx.toolNames.has('edit_file'))
            hints.push('- To modify a file, use `edit_file` (not read + write).');
        return hints.length ? `${base}\n\n${hints.join('\n')}` : base;
    });
    return {
        name: 'read_file',
        description,
        isConcurrencySafe: true,
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute path to the file to read' },
                offset: { type: 'number', description: 'Line number to start reading from (1-indexed). Default: 1' },
                limit: { type: 'number', description: 'Maximum number of lines to read. Default: 2000' },
            },
            required: ['file_path'],
        },
        async call(input, _ctx) {
            const filePath = input['file_path'];
            const offset = typeof input['offset'] === 'number' ? Math.max(1, input['offset']) : 1;
            const limit = typeof input['limit'] === 'number' ? input['limit'] : MAX_LINES;
            if (!filePath)
                return { content: 'Error: file_path is required', isError: true };
            if (!existsSync(filePath))
                return { content: `File not found: ${filePath}`, isError: true };
            try {
                const stat = statSync(filePath);
                if (stat.isDirectory())
                    return { content: `Error: ${filePath} is a directory. Use bash to list directories.`, isError: true };
                const ext = extname(filePath).toLowerCase();
                // Jupyter notebooks
                if (ext === '.ipynb') {
                    const raw = readFileSync(filePath, 'utf-8');
                    const nb = JSON.parse(raw);
                    const cells = nb.cells ?? [];
                    const lines = [];
                    cells.forEach((cell, i) => {
                        const src = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
                        lines.push(`## Cell ${i + 1} [${cell.cell_type}]`, src, '');
                    });
                    return { content: lines.join('\n'), isError: false };
                }
                const raw = readFileSync(filePath, 'utf-8');
                const allLines = raw.split('\n');
                const startIdx = offset - 1;
                const sliced = allLines.slice(startIdx, startIdx + limit);
                const formatted = sliced.map((line, i) => `${String(startIdx + i + 1).padStart(4)}\t${line}`).join('\n');
                const truncated = allLines.length > startIdx + limit;
                const footer = truncated ? `\n\n[Showing lines ${offset}–${offset + limit - 1} of ${allLines.length}]` : '';
                return { content: formatted + footer, isError: false };
            }
            catch (err) {
                return { content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map