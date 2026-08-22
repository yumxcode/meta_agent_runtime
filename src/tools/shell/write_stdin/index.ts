import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { SHELL_SESSION_DEFAULTS } from '../../../infra/exec/ShellSessionStore.js'
import {
  ownerOf,
  renderReadResult,
  shellSessionStore,
  toToolError,
} from '../sessionSupport.js'

const DEFAULT_WRITE_YIELD_MS = 5_000

function resolveYieldMs(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.min(SHELL_SESSION_DEFAULTS.MAX_YIELD_MS, Math.max(0, raw))
}

export async function createWriteStdinTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'write_stdin',
    abortSupport: 'cooperative',
    description,
    permission: {
      category: 'execute',
      // No commandField: the kernel's command guards inspect a shell command
      // string, and this input is arbitrary stdin bytes — a REPL expression, a
      // password, a single keypress. Scanning it as if it were a command
      // produces false positives without adding protection, because the
      // SESSION was already approved (and sandboxed) when it was opened.
      requiresWorkspace: true,
      sensitive: true,
      planMode: 'ask',
    },
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id returned by exec_session' },
        input: {
          type: 'string',
          description: 'Text to write. Empty string reads more output without sending anything.',
        },
        yield_time_ms: {
          type: 'number',
          description: `Max ms to wait for output; returns early when the program goes quiet. Default: ${DEFAULT_WRITE_YIELD_MS}, max: ${SHELL_SESSION_DEFAULTS.MAX_YIELD_MS}`,
        },
        raw: {
          type: 'boolean',
          description: 'Write verbatim with no trailing newline. Default: false',
        },
        close_stdin: {
          type: 'boolean',
          description: 'Close stdin after writing (sends EOF). Default: false',
        },
      },
      required: ['session_id'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const sessionId = input['session_id']
      if (typeof sessionId !== 'string' || !sessionId) {
        return { content: 'Error: session_id is required', isError: true }
      }
      const raw = input['input']
      if (raw !== undefined && typeof raw !== 'string') {
        return { content: 'Error: input must be a string', isError: true }
      }
      const text = (raw as string | undefined) ?? ''
      const isRaw = input['raw'] === true
      const closeStdin = input['close_stdin'] === true
      const yieldTimeMs = resolveYieldMs(input['yield_time_ms'], DEFAULT_WRITE_YIELD_MS)

      // A shell reading a command WITHOUT a trailing newline just waits, which
      // is indistinguishable from a hung session. Appending one is what the
      // caller means in every case except a deliberate raw keypress.
      const payload = !text ? '' : isRaw || text.endsWith('\n') ? text : `${text}\n`

      const store = shellSessionStore()
      const owner = ownerOf(ctx)
      try {
        const result =
          payload || closeStdin
            ? await store.write(owner, sessionId, payload, {
                yieldTimeMs,
                closeStdin,
                ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
              })
            : // Empty input with no EOF is a pure read — do NOT go through
              // write(), which rejects on an exited session. Reading the final
              // output of a process that just exited is legitimate and common.
              await store.read(owner, sessionId, {
                yieldTimeMs,
                ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
              })
        return { content: renderReadResult(sessionId, result), isError: false }
      } catch (err) {
        return toToolError(err)
      }
    },
  }
}
