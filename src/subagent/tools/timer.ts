/**
 * timer — a loop worker's self-park channel.
 *
 * When a worker kicks off something slow (e.g. a remote training run) it decides
 * FOR ITSELF to check back later: it calls `timer` with a delay + reason. Calling
 * timer IMMEDIATELY ENDS this segment — the seat's runner parks the worker the
 * instant the tool returns (no separate return_result needed). The kernel
 * schedules a timer wake and RESUMES the same (lineage) worker after the delay
 * with a "continue" message, so the worker can look at the result itself and
 * decide to keep waiting (call `timer` again) or finish the round (write
 * findings/direction and return_result {"label":"ok"}).
 *
 * The park is enforced by the seat runner via a shared parkSignal (see Seats.ts /
 * SubAgentRunner): the sink flips it, the runner interrupts the session on the
 * timer tool_result. The worker therefore cannot "keep working after parking".
 *
 * Injected per-run by the loop seat; the `sink` closes over the seat's captured
 * park-intent slot (and, in Seats, also flips the parkSignal).
 */
import type { MetaAgentTool, ToolResult } from '../../core/types.js'

export interface TimerIntent {
  afterMs: number
  reason: string
}

const MIN_MINUTES = 5        // shorter is churn — a remote task needs time to move
const MAX_MINUTES = 3 * 60   // 3h cap — a longer single wait is a design smell

export function makeTimerTool(sink: (intent: TimerIntent) => void): MetaAgentTool {
  return {
    name: 'timer',
    isConcurrencySafe: false,
    // Auto mode gates out tools with no abortSupport contract (ToolExecution.ts).
    // The loop worker seat runs in auto mode; without this, `timer` is DISABLED
    // and the whole self-park mechanism silently never fires — the worker is
    // forced to inline-poll instead. timer returns instantly (records intent, the
    // runner then parks), so it is trivially abort-safe.
    abortSupport: 'cooperative',
    description: `Park yourself and be woken later to continue THIS round.

Use when you've started something slow (e.g. a remote training run) and want to
check back after a delay instead of finishing now. Calling timer ENDS this segment
immediately — you do NOT need to return_result afterwards; the kernel resumes you
(same session) after the delay with a message telling you to continue, where you
re-check status and decide to wait again (call timer again) or harvest (write
findings + return_result {"label":"ok"}).

Choosing the delay — don't set it too short or too long:
- minutes: 5..180 (i.e. 5 min .. 3 h). Below 5 min just churns; a single wait
  longer than 3 h is a design smell — split it into repeated shorter waits.
- Pick a delay proportional to how long the slow task actually needs to make
  visible progress (e.g. ~30 min for a training run to move its reward curve).
- reason:  short reason shown to you on resume (e.g. "check remote job progress").`,
    inputSchema: {
      type: 'object',
      required: ['minutes', 'reason'],
      properties: {
        minutes: { type: 'number', description: 'Delay before resume, in minutes (5..180).' },
        reason:  { type: 'string', description: 'Short reason, echoed back on resume.' },
      },
    },
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      const raw = Number(input['minutes'])
      if (!Number.isFinite(raw) || raw < MIN_MINUTES || raw > MAX_MINUTES) {
        return { content: `Error: timer "minutes" must be ${MIN_MINUTES}..${MAX_MINUTES} (5 min .. 3 h).`, isError: true }
      }
      const reason = String(input['reason'] ?? '').trim()
      if (!reason) return { content: 'Error: timer requires a non-empty "reason".', isError: true }
      sink({ afterMs: Math.round(raw) * 60_000, reason })
      return {
        content: `Parked for ${Math.round(raw)} min ("${reason}"). This segment ends now; ` +
          `you will be resumed after the delay to continue.`,
        isError: false,
      }
    },
  }
}
