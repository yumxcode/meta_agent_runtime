/**
 * timer / timer_cancel — a loop worker's self-park channel.
 *
 * When a worker kicks off something slow it can decide FOR ITSELF to check back
 * later (judgment-poll, vs the kernel's code probe): it calls `timer` with a
 * delay + reason, then returns. The kernel schedules a timer wake and RESUMES the
 * same (lineage) worker after the delay with a "continue" message, so the worker
 * can look at the result itself and decide to keep waiting (call `timer` again)
 * or finish the round. `timer_cancel` clears a pending park so the worker never
 * loops forever — if on reflection it wants to conclude now, it cancels first.
 *
 * Like return_result, both tools are injected per-run by the loop seat; the
 * `sink` closes over the seat's captured park-intent slot.
 */
import type { MetaAgentTool, ToolResult } from '../../core/types.js'

export interface TimerIntent {
  afterMs: number
  reason: string
}

const MIN_MINUTES = 1
const MAX_MINUTES = 24 * 60 // 24h cap — a longer wait is a design smell

export function makeTimerTool(sink: (intent: TimerIntent) => void): MetaAgentTool {
  return {
    name: 'timer',
    isConcurrencySafe: false,
    description: `Park yourself and be woken later to continue THIS round.

Use when you've started something slow (e.g. a remote training run) and want to
check back after a delay instead of finishing now. After calling timer you should
return_result with {"label":"wait"}; the kernel resumes you (same session) after
the delay with a message telling you to continue, where you re-check status and
decide to wait again (call timer again) or harvest (write findings + return_result
{"label":"ok"}). Call timer_cancel if you change your mind and want to conclude now.

- minutes: how long to wait before being woken (1..1440).
- reason:  short reason shown to you on resume (e.g. "check gradmotion progress").`,
    inputSchema: {
      type: 'object',
      required: ['minutes', 'reason'],
      properties: {
        minutes: { type: 'number', description: 'Delay before resume, in minutes (1..1440).' },
        reason:  { type: 'string', description: 'Short reason, echoed back on resume.' },
      },
    },
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      const raw = Number(input['minutes'])
      if (!Number.isFinite(raw) || raw < MIN_MINUTES || raw > MAX_MINUTES) {
        return { content: `Error: timer "minutes" must be ${MIN_MINUTES}..${MAX_MINUTES}.`, isError: true }
      }
      const reason = String(input['reason'] ?? '').trim()
      if (!reason) return { content: 'Error: timer requires a non-empty "reason".', isError: true }
      sink({ afterMs: Math.round(raw) * 60_000, reason })
      return {
        content: `Parked for ${Math.round(raw)} min ("${reason}"). Now return_result {"label":"wait"}; ` +
          `you will be resumed to continue.`,
        isError: false,
      }
    },
  }
}

export function makeTimerCancelTool(sink: () => void): MetaAgentTool {
  return {
    name: 'timer_cancel',
    isConcurrencySafe: false,
    description: `Cancel a pending timer park set earlier this turn. Use if you decide to ` +
      `conclude the round now instead of waiting — then return_result normally ({"label":"ok"}).`,
    inputSchema: { type: 'object', properties: {} },
    async call(): Promise<ToolResult> {
      sink()
      return { content: 'Timer park cancelled. Conclude the round with return_result.', isError: false }
    },
  }
}
