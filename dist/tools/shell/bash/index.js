import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, realpathSync } from 'fs';
import { resolve, sep } from 'path';
import { dynamicDescription } from '../../util.js';
const execFileAsync = promisify(execFile);
const DEFAULT_MAX_OUT = 100 * 1024;
/**
 * Lazy getter so tests can set META_AGENT_MAX_TOOL_OUTPUT_CHARS after importing
 * and immediately see the new value (no module-load-time snapshot).
 */
function getMaxOut() {
    const raw = process.env['META_AGENT_MAX_TOOL_OUTPUT_CHARS'];
    if (raw === undefined)
        return DEFAULT_MAX_OUT;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed))
        return DEFAULT_MAX_OUT;
    return Math.min(1024 * 1024, Math.max(1024, parsed));
}
function isInsideWorkspace(path, workspaceRoot = process.cwd()) {
    const workspace = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot);
    const target = existsSync(path) ? realpathSync(path) : resolve(workspace, path);
    return target === workspace || target.startsWith(workspace.endsWith(sep) ? workspace : workspace + sep);
}
export async function createBashTool(opts = {}) {
    const { sandboxHandle } = opts;
    // Dynamic description: tells the model to prefer sibling tools over shell
    // equivalents — but only lists the ones actually registered in the session.
    // Mirrors CC's BashTool.prompt() which injects tool names at resolution time.
    const description = dynamicDescription(import.meta.url, (base, ctx) => {
        const hints = [];
        if (ctx.toolNames.has('grep'))
            hints.push('- Search file contents: use `grep` tool (NOT rg/grep commands)');
        if (ctx.toolNames.has('glob'))
            hints.push('- Find files by pattern: use `glob` tool (NOT find/ls)');
        if (ctx.toolNames.has('read_file'))
            hints.push('- Read files: use `read_file` tool (NOT cat/head/tail)');
        if (ctx.toolNames.has('edit_file'))
            hints.push('- Edit files: use `edit_file` tool (NOT sed/awk)');
        if (ctx.toolNames.has('write_file'))
            hints.push('- Write files: use `write_file` tool (NOT echo >/tee)');
        if (ctx.toolNames.has('notebook_edit'))
            hints.push('- Edit Jupyter cells: use `notebook_edit` tool');
        return hints.length
            ? `${base}\n\nPrefer these tools over shell equivalents when available:\n${hints.join('\n')}`
            : base;
    });
    return {
        name: 'bash',
        description,
        permission: {
            category: 'execute',
            cwdField: 'cwd',
            requiresWorkspace: true,
            sensitive: true,
            planMode: 'ask',
            // sandbox: undefined — main agent bash runs unsandboxed for now.
            // Set sandbox: true (or a SandboxConfig) here when ready to enforce
            // OS-level isolation for main-agent shell commands.
        },
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Bash command to execute' },
                timeout_ms: { type: 'number', description: 'Timeout ms. Default: 30000, max: 120000' },
                cwd: { type: 'string', description: 'Working directory. Default: process.cwd()' },
            },
            required: ['command'],
        },
        async call(input, ctx) {
            const command = input['command'];
            const timeoutMs = Math.min(typeof input['timeout_ms'] === 'number' ? input['timeout_ms'] : 30000, 120000);
            const cwd = input['cwd'] ?? process.cwd();
            if (!command)
                return { content: 'Error: command is required', isError: true };
            if (!isInsideWorkspace(cwd, ctx.workspaceRoot))
                return { content: `Error: cwd is outside workspace: ${cwd}`, isError: true };
            const limit = getMaxOut();
            const trunc = (s) => s.length > limit ? s.slice(0, limit) + `\n[Truncated — ${s.length} bytes]` : s;
            // Resolve exec spec — priority order:
            //   1. ctx.sandboxHandle  injected by MetaAgentSession._wrapTool() for main-agent calls
            //   2. sandboxHandle      closure-captured for sub-agent calls (SubAgentRunner path)
            //   3. plain bash         no sandboxing configured
            const activeHandle = ctx.sandboxHandle ?? sandboxHandle;
            const execSpec = activeHandle
                ? activeHandle.wrapExec(command, cwd)
                : { file: 'bash', args: ['-c', command] };
            try {
                const { stdout, stderr } = await execFileAsync(execSpec.file, execSpec.args, {
                    timeout: timeoutMs, cwd, maxBuffer: limit * 2,
                    signal: ctx.abortSignal, env: process.env,
                });
                const parts = [];
                if (stdout)
                    parts.push(trunc(stdout));
                if (stderr)
                    parts.push(`STDERR:\n${trunc(stderr)}`);
                return { content: parts.join('\n') || '(no output)', isError: false };
            }
            catch (err) {
                const e = err;
                if (e.killed)
                    return { content: `Command timed out after ${timeoutMs}ms`, isError: true };
                const parts = [];
                if (e.stdout)
                    parts.push(e.stdout);
                if (e.stderr)
                    parts.push(`STDERR:\n${e.stderr}`);
                if (e.code !== undefined)
                    parts.push(`Exit code: ${e.code}`);
                return { content: parts.join('\n') || e.message || String(err), isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map