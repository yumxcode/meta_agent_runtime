import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

/**
 * Longest a single `sleep` call may park the turn.
 *
 * 30 minutes, matching `timeouts.jobMs` — the number this codebase already uses
 * for "long asynchronous work we are willing to wait on".
 *
 * The old cap was 60s, and the tool's own prompt pointed anyone needing longer
 * at `self_timer`. That escape hatch only exists in auto mode
 * (`AgenticBackendFactory` registers it behind `wantsGates`), and robotics —
 * an interactive mode, deliberately not scheduler-backed — never sees it. So a
 * robotics agent waiting on a CI run or a training job had no sanctioned way to
 * wait past two minutes and resorted to `bash("sleep 180 && …")`, which the
 * bash tool clamps to 120s and therefore kills every single time.
 *
 * Blocking this long is acceptable ONLY because the wait is cooperatively
 * abortable: `abortSupport: 'cooperative'` plus the abort listener below means
 * Ctrl+C (and any mid-turn interrupt) unblocks it immediately, unlike a sleep
 * running inside a spawned shell.
 */
const MAX_SLEEP_MS = 30 * 60_000

/**
 * Slack between the sleep's own limit and the kernel's abort.
 *
 * The tool declares `timeoutMs` so it opts OUT of the global `timeouts.toolMs`
 * (3 min by default) — otherwise the kernel would abort any sleep past that,
 * exactly the bound this tool exists to escape. The declared value stays just
 * above MAX_SLEEP_MS so the kernel is still a backstop if this timer ever fails
 * to fire, rather than no bound at all.
 */
const KERNEL_SLACK_MS = 30_000

export async function createSleepTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'sleep',
    abortSupport: 'cooperative',
    // Opt out of the kernel's per-tool timeout; see KERNEL_SLACK_MS.
    timeoutMs: MAX_SLEEP_MS + KERNEL_SLACK_MS,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        duration_ms: {
          type: 'number',
          description: `Milliseconds to sleep (max: ${MAX_SLEEP_MS} = 30 minutes)`,
        },
      },
      required: ['duration_ms'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const requested = typeof input['duration_ms'] === 'number' ? input['duration_ms'] : 1000
      if (!Number.isFinite(requested) || requested <= 0) {
        return { content: 'Error: duration_ms must be a positive number', isError: true }
      }
      const ms = Math.min(requested, MAX_SLEEP_MS)
      // Say so when the request was trimmed — a silent clamp is how an agent
      // ends up believing it waited 45 minutes when it waited 30.
      const clampNote = requested > MAX_SLEEP_MS
        ? ` (requested ${requested}ms, clamped to the ${MAX_SLEEP_MS}ms maximum)`
        : ''

      const startedAt = Date.now()
      // An abort REJECTS, it does not resolve. That distinction is the whole
      // `abortSupport: 'cooperative'` contract: a resolved result reads to the
      // kernel as "the tool completed", and the loop would carry on after a
      // Ctrl+C. Returning a friendly "interrupted" ToolResult here looked
      // tidier and quietly turned interrupt into a no-op.
      //
      // The elapsed time rides along in the message instead, so an agent
      // polling remote work still learns how far the wait got.
      await new Promise<void>((resolve, reject) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout>
        const onAbort = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new Error(`Sleep aborted after ${Date.now() - startedAt}ms of ${ms}ms`))
        }
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          ctx.abortSignal.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
        if (ctx.abortSignal.aborted) {
          onAbort()
          return
        }
        ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
      })
      return { content: `Slept for ${ms}ms${clampNote}`, isError: false }
    },
  }
}
