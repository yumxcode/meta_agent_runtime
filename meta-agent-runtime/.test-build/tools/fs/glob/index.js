import { readdirSync, statSync } from 'fs';
import { join, relative, basename } from 'path';
import { dynamicDescription } from '../../util.js';
function matchGlob(pattern, filePath) {
    const seg = pattern
        .replace(/[.+^${}()|[\]\\]/g, (c) => ['*', '?'].includes(c) ? c : `\\${c}`)
        .replace(/\\\./g, '\\.')
        .replace(/\*\*\//g, '(?:.+/)?')
        .replace(/\*\*/g, '.*')
        .replace(/(?<!\.\*)\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\{([^}]+)\}/g, (_, g) => `(${g.split(',').map((s) => s.trim()).join('|')})`);
    try {
        return new RegExp(`^${seg}$`).test(filePath);
    }
    catch {
        return false;
    }
}
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '__pycache__']);
function walkDir(dir, results, max) {
    if (results.length >= max)
        return;
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (results.length >= max)
                break;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name))
                    walkDir(full, results, max);
            }
            else {
                try {
                    results.push({ path: full, mtime: statSync(full).mtimeMs });
                }
                catch { /* skip */ }
            }
        }
    }
    catch { /* skip */ }
}
export async function createGlobTool() {
    const description = dynamicDescription(import.meta.url, (base, ctx) => {
        const note = ctx.toolNames.has('bash')
            ? '\n\nIMPORTANT: Use this `glob` tool to find files by name pattern. Do NOT use `find` or `ls` via bash.'
            : '';
        return base + note;
    });
    return {
        name: 'glob',
        description,
        isConcurrencySafe: true,
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts")' },
                path: { type: 'string', description: 'Directory to search in. Defaults to cwd.' },
            },
            required: ['pattern'],
        },
        async call(input, _ctx) {
            const pattern = input['pattern'];
            const searchPath = input['path'] ?? process.cwd();
            if (!pattern)
                return { content: 'Error: pattern is required', isError: true };
            try {
                const allFiles = [];
                walkDir(searchPath, allFiles, 5000);
                const matched = allFiles.filter(f => {
                    const rel = relative(searchPath, f.path);
                    return matchGlob(pattern, rel) || matchGlob(pattern, basename(f.path));
                });
                matched.sort((a, b) => b.mtime - a.mtime);
                const results = matched.slice(0, 100).map(f => f.path);
                if (results.length === 0)
                    return { content: `No files found matching "${pattern}" in ${searchPath}`, isError: false };
                const truncated = matched.length > 100 ? `\n[${matched.length - 100} more results omitted]` : '';
                return { content: results.join('\n') + truncated, isError: false };
            }
            catch (err) {
                return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map