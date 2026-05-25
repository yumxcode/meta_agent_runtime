import { execFileSync } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { dynamicDescription } from '../../util.js';
let _rgAvailable = null;
function isRgAvailable() {
    if (_rgAvailable !== null)
        return _rgAvailable;
    try {
        execFileSync('rg', ['--version'], { timeout: 2000 });
        _rgAvailable = true;
    }
    catch {
        _rgAvailable = false;
    }
    return _rgAvailable;
}
export async function createGrepTool() {
    // When bash is present, remind the model not to use grep/rg shell commands.
    const description = dynamicDescription(import.meta.url, (base, ctx) => {
        const note = ctx.toolNames.has('bash')
            ? '\n\nIMPORTANT: ALWAYS use this `grep` tool for search tasks. NEVER invoke `grep` or `rg` as a `bash` command — this tool has optimised output, permissions, and result formatting.'
            : '';
        return base + note;
    });
    return {
        name: 'grep',
        description,
        isConcurrencySafe: true,
        permission: { category: 'read', pathFields: ['path'], requiresWorkspace: true, planMode: 'allow' },
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Regular expression pattern' },
                path: { type: 'string', description: 'File or directory to search. Default: cwd' },
                glob: { type: 'string', description: 'Glob filter (e.g. "*.ts")' },
                output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Default: files_with_matches' },
                context: { type: 'number', description: 'Lines of context around matches' },
                case_insensitive: { type: 'boolean', description: 'Case-insensitive. Default: false' },
                multiline: { type: 'boolean', description: 'Multiline mode. Default: false' },
                head_limit: { type: 'number', description: 'Max lines to return. Default: 250' },
            },
            required: ['pattern'],
        },
        async call(input, _ctx) {
            const pattern = input['pattern'];
            const searchPath = input['path'] ?? process.cwd();
            const outputMode = input['output_mode'] ?? 'files_with_matches';
            const headLimit = typeof input['head_limit'] === 'number' ? input['head_limit'] : 250;
            if (!pattern)
                return { content: 'Error: pattern is required', isError: true };
            if (isRgAvailable()) {
                try {
                    const args = ['--no-heading'];
                    if (input['case_insensitive'])
                        args.push('-i');
                    if (input['multiline'])
                        args.push('-U', '--multiline-dotall');
                    if (input['glob'])
                        args.push('--glob', input['glob']);
                    if (typeof input['context'] === 'number')
                        args.push('-C', String(input['context']));
                    if (outputMode === 'files_with_matches')
                        args.push('-l');
                    else if (outputMode === 'count')
                        args.push('--count');
                    else
                        args.push('-n');
                    args.push('--', pattern, searchPath);
                    const raw = execFileSync('rg', args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
                    let out = raw.toString('utf-8').trim();
                    const lines = out.split('\n');
                    if (lines.length > headLimit)
                        out = lines.slice(0, headLimit).join('\n') + `\n[Truncated to ${headLimit} lines]`;
                    return { content: out || 'No matches found', isError: false };
                }
                catch (err) {
                    const e = err;
                    if (e.status === 1)
                        return { content: 'No matches found', isError: false };
                    throw err;
                }
            }
            // Fallback: Node.js
            const regex = new RegExp(pattern, (input['case_insensitive'] ? 'i' : '') + (input['multiline'] ? 'm' : ''));
            const matchedFiles = [];
            function scanDir(dir) {
                try {
                    for (const entry of readdirSync(dir, { withFileTypes: true })) {
                        const full = join(dir, entry.name);
                        if (entry.isDirectory()) {
                            if (!['node_modules', '.git', 'dist'].includes(entry.name))
                                scanDir(full);
                        }
                        else {
                            try {
                                if (regex.test(readFileSync(full, 'utf-8')))
                                    matchedFiles.push(full);
                            }
                            catch { /* skip */ }
                        }
                    }
                }
                catch { /* skip */ }
            }
            try {
                if (statSync(searchPath).isFile()) {
                    if (regex.test(readFileSync(searchPath, 'utf-8')))
                        matchedFiles.push(searchPath);
                }
                else
                    scanDir(searchPath);
            }
            catch (e) {
                return { content: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
            }
            if (matchedFiles.length === 0)
                return { content: 'No matches found', isError: false };
            return { content: matchedFiles.slice(0, headLimit).join('\n'), isError: false };
        },
    };
}
//# sourceMappingURL=index.js.map