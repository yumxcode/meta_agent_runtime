import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, realpathSync } from 'fs';
import { resolve, sep } from 'path';
import { loadToolPrompt } from '../../util.js';
const execFileAsync = promisify(execFile);
function isInsideWorkspace(path, workspaceRoot = process.cwd()) {
    const workspace = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot);
    const target = existsSync(path) ? realpathSync(path) : resolve(workspace, path);
    return target === workspace || target.startsWith(workspace.endsWith(sep) ? workspace : workspace + sep);
}
export async function createPowerShellTool() {
    const description = await loadToolPrompt(import.meta.url);
    return {
        name: 'powershell',
        description,
        permission: {
            category: 'execute',
            cwdField: 'cwd',
            requiresWorkspace: true,
            sensitive: true,
            planMode: 'ask',
        },
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'PowerShell command' },
                timeout_ms: { type: 'number', description: 'Timeout ms. Default: 30000' },
                cwd: { type: 'string', description: 'Working directory. Default: workspace root' },
            },
            required: ['command'],
        },
        async call(input, ctx) {
            if (process.platform !== 'win32')
                return { content: 'Error: PowerShell is only available on Windows', isError: true };
            const command = input['command'];
            const timeoutMs = Math.min(typeof input['timeout_ms'] === 'number' ? input['timeout_ms'] : 30000, 120000);
            const workspaceRoot = ctx.workspaceRoot ?? process.cwd();
            const cwd = input['cwd'] ?? workspaceRoot;
            if (!command)
                return { content: 'Error: command is required', isError: true };
            if (!isInsideWorkspace(cwd, workspaceRoot))
                return { content: `Error: cwd is outside workspace: ${cwd}`, isError: true };
            try {
                const { stdout, stderr } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: timeoutMs, cwd, maxBuffer: 10 * 1024 * 1024, signal: ctx.abortSignal });
                const parts = [];
                if (stdout)
                    parts.push(stdout);
                if (stderr)
                    parts.push(`STDERR:\n${stderr}`);
                return { content: parts.join('\n') || '(no output)', isError: false };
            }
            catch (err) {
                const e = err;
                return { content: [e.stdout, e.stderr && `STDERR:\n${e.stderr}`, `Exit: ${e.code}`].filter(Boolean).join('\n') || String(err), isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map