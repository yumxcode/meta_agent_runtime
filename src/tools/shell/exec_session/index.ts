import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { dynamicDescription } from '../../util.js'
import type { ShellEnvPolicy } from '../../../infra/env/childProcessEnv.js'
import { SHELL_SESSION_DEFAULTS } from '../../../infra/exec/ShellSessionStore.js'
import {
  activeSandboxHandle,
  ownerOf,
  renderReadResult,
  resolveSessionSandboxPolicy,
  sessionExternalRoots,
  shellSessionStore,
  toToolError,
  type ShellSessionToolOptions,
} from '../sessionSupport.js'

/**
 * Default read window for the FIRST read of a new session.
 *
 * Longer than a mid-session read: opening a session usually means starting a
 * program (a REPL booting, a shell sourcing an rc file) and the first output
 * is the slowest. The idle-based early return means a fast start still comes
 * back in milliseconds, so this ceiling costs nothing when it is not needed.
 */
const DEFAULT_OPEN_YIELD_MS = 10_000

function resolveYieldMs(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.min(SHELL_SESSION_DEFAULTS.MAX_YIELD_MS, Math.max(0, raw))
}

function stringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.filter((v): v is string => typeof v === 'string')
  return out.length === raw.length ? out : undefined
}

export async function createExecSessionTool(
  opts: ShellSessionToolOptions = {},
): Promise<MetaAgentTool> {
  const envPolicy: ShellEnvPolicy = opts.envPolicy ?? 'filtered'
  const sandboxPolicy = resolveSessionSandboxPolicy(opts)

  // Dynamic description: point the model back at the cheaper one-shot tool when
  // it exists, so "persistent" does not become the default for work that has no
  // state to keep. Mirrors the bash tool's cross-reference hints.
  const description = dynamicDescription(import.meta.url, (base, ctx) =>
    ctx.toolNames.has('bash')
      ? `${base}\n\nFor a single self-contained command with no state to keep, use \`bash\` — it is cheaper and leaves no process running.`
      : base,
  )

  return {
    name: 'exec_session',
    abortSupport: 'cooperative',
    description,
    permission: {
      category: 'execute',
      cwdField: 'cwd',
      // Same kernel command-level guards the one-shot path subscribes to:
      // absolute-path workspace scan, escape scan, sensitive-command detection.
      // Without this, `exec_session` would be a way to run a command the `bash`
      // tool would have stopped.
      commandField: 'command',
      requiresWorkspace: true,
      sensitive: true,
      planMode: 'ask',
      sandbox: sandboxPolicy,
    },
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Optional first input, sent as if typed at the prompt.',
        },
        cwd: { type: 'string', description: 'Starting directory. Default: workspace root.' },
        shell: { type: 'string', description: 'Program to run. Default: bash' },
        shell_args: {
          type: 'array',
          items: { type: 'string' },
          description: 'argv for `shell`, e.g. ["-u","-i"] for a Python REPL.',
        },
        yield_time_ms: {
          type: 'number',
          description: `Max ms to wait for output; returns early when the program goes quiet. Default: ${DEFAULT_OPEN_YIELD_MS}, max: ${SHELL_SESSION_DEFAULTS.MAX_YIELD_MS}`,
        },
        label: { type: 'string', description: 'Short name shown in session listings.' },
      },
      required: [],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const command = typeof input['command'] === 'string' ? input['command'] : ''
      const shell = typeof input['shell'] === 'string' && input['shell'] ? input['shell'] : 'bash'
      const shellArgs = stringArray(input['shell_args'])
      if (input['shell_args'] !== undefined && shellArgs === undefined) {
        return { content: 'Error: shell_args must be an array of strings', isError: true }
      }
      const yieldTimeMs = resolveYieldMs(input['yield_time_ms'], DEFAULT_OPEN_YIELD_MS)
      // Default cwd to the session's workspace root, NOT process.cwd(): a
      // sub-agent runs inside the parent's Node process, so process.cwd() can
      // sit outside its own workspace and every cwd-less call would fail the
      // jail check. Same reasoning as the bash tool.
      const rawCwd = (input['cwd'] as string | undefined) ?? ctx.workspaceRoot ?? process.cwd()

      const store = shellSessionStore()
      const owner = ownerOf(ctx)
      let sessionId: string | undefined

      try {
        const info = store.open({
          owner,
          cwd: rawCwd,
          ...(ctx.workspaceRoot ? { workspaceRoot: ctx.workspaceRoot } : {}),
          allowedRoots: sessionExternalRoots(ctx.workspaceRoot),
          envPolicy,
          ...(() => {
            const handle = activeSandboxHandle(ctx, opts.sandboxHandle)
            return handle ? { sandboxHandle: handle } : {}
          })(),
          shell,
          ...(shellArgs ? { shellArgs } : {}),
          ...(typeof input['label'] === 'string' ? { label: input['label'] } : {}),
        })
        sessionId = info.id

        const read = command
          ? await store.write(owner, info.id, `${command}\n`, {
              yieldTimeMs,
              ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
            })
          : await store.read(owner, info.id, {
              yieldTimeMs,
              ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
            })

        return {
          content: renderReadResult(info.id, read, { includeHeader: true }),
          isError: false,
        }
      } catch (err) {
        // A session that was opened but then failed mid-read must not be left
        // running: the caller never learned its id, so nothing could ever close
        // it, and it would sit there holding a process until the idle reaper.
        if (sessionId) {
          try {
            store.close(owner, sessionId)
          } catch {
            /* already gone */
          }
        }
        return toToolError(err)
      }
    },
  }
}
