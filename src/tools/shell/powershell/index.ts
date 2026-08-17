import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { runShellCommand, ShellCommandRefused } from '../../../infra/exec/runShellCommand.js'
import { resolveSandboxPolicy } from '../../../sandbox/sandboxPolicyConfig.js'
import { RuntimeEnv } from '../../../infra/env/RuntimeEnv.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUT = 100 * 1024

/**
 * PowerShell tool (Windows only).
 *
 * Previously this file carried a PRIVATE copy of `isInsideWorkspace` that used
 * a bare `target.startsWith(workspace + sep)` prefix test — the exact drift
 * `tools/fs/workspaceGuard.ts` was created to eliminate, and which treats
 * `C:\proj-backup` as inside `C:\proj`. It also inherited the full process
 * environment (no credential filter), never consulted `ctx.sandboxHandle`, and
 * never redacted its output.
 *
 * It now shares the one hardened execution path with `bash`, so all four of
 * those are handled in a single place.
 */
export async function createPowerShellTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'powershell',
    abortSupport: 'cooperative',
    description,
    permission: {
      category: 'execute',
      cwdField: 'cwd',
      // Subscribes to the kernel's command-level guards. Note the guards' regexes
      // are POSIX-shell-shaped; they are a best-effort prompt trigger here, not a
      // boundary. The boundary is the cwd jail plus the OS sandbox.
      commandField: 'command',
      requiresWorkspace: true,
      sensitive: true,
      planMode: 'ask',
    },
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command' },
        timeout_ms: { type: 'number', description: `Timeout ms. Default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS}` },
        cwd: { type: 'string', description: 'Working directory. Default: workspace root' },
      },
      required: ['command'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      if (process.platform !== 'win32') {
        return { content: 'Error: PowerShell is only available on Windows', isError: true }
      }
      const command = input['command'] as string
      if (!command) return { content: 'Error: command is required', isError: true }
      const raw = input['timeout_ms']
      const timeoutMs = typeof raw === 'number' && Number.isFinite(raw)
        ? Math.min(MAX_TIMEOUT_MS, Math.max(1_000, raw))
        : DEFAULT_TIMEOUT_MS
      const workspaceRoot = ctx.workspaceRoot ?? process.cwd()
      const limit = RuntimeEnv.maxToolOutputChars(DEFAULT_MAX_OUT)
      const trunc = (s: string) =>
        s.length > limit ? s.slice(0, limit) + `\n[Truncated — ${s.length} bytes]` : s

      try {
        const res = await runShellCommand({
          command,
          cwd: (input['cwd'] as string | undefined) ?? workspaceRoot,
          workspaceRoot,
          allowedRoots: resolveSandboxPolicy(workspaceRoot).allowedRoots,
          timeoutMs,
          signal: ctx.abortSignal,
          envPolicy: 'filtered',
          ...(ctx.sandboxHandle ? { sandboxHandle: ctx.sandboxHandle } : {}),
          captureLimit: limit * 2,
          shell: { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'] },
        })

        const parts: string[] = []
        if (res.stdout) parts.push(trunc(res.stdout))
        if (res.stderr) parts.push(`STDERR:\n${trunc(res.stderr)}`)

        if (res.timedOut || res.aborted) {
          return {
            content: [res.timedOut ? `Command timed out after ${timeoutMs}ms` : 'Command aborted', ...parts].join('\n'),
            isError: true,
          }
        }
        if (res.code === 0) return { content: parts.join('\n') || '(no output)', isError: false }
        parts.push(`Exit code: ${res.code ?? 'unknown'}`)
        return { content: parts.join('\n'), isError: true }
      } catch (err: unknown) {
        if (err instanceof ShellCommandRefused) {
          return { content: `Error: ${err.message}`, isError: true }
        }
        return { content: err instanceof Error ? err.message : String(err), isError: true }
      }
    },
  }
}
