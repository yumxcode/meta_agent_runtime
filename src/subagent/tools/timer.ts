/** Generic hard-park tool for a durable Agent execution segment. */
import type { MetaAgentTool, ToolResult } from '../../core/types.js'

export interface TimerIntent {
  afterMs: number
  reason: string
  checkpoint?: Record<string, unknown>
}

const MAX_CHECKPOINT_BYTES = 16 * 1024

export function makeTimerTool(
  sink: (intent: TimerIntent) => void,
  options: { maxDelayMs?: number } = {},
): MetaAgentTool {
  const maxDelayMs = options.maxDelayMs ?? Number.MAX_SAFE_INTEGER
  return {
    name: 'timer',
    isConcurrencySafe: false,
    // Auto mode gates out tools with no abortSupport contract (ToolExecution.ts).
    // The loop worker seat runs in auto mode; without this, `timer` is DISABLED
    // and the whole self-park mechanism silently never fires — the worker is
    // forced to inline-poll instead. timer returns instantly (records intent, the
    // runner then parks), so it is trivially abort-safe.
    abortSupport: 'cooperative',
    description: `Durably park this Agent Activation and resume it later.

Calling timer immediately ends the current execution segment. Do not call more
tools or submit node output afterwards. At the requested time, the Kernel resumes
the same logical Activation on its persistent Lane. Use checkpoint for small JSON
facts needed on resume, such as an external operation id or last observed state.`,
    inputSchema: {
      type: 'object',
      required: ['afterMs', 'reason'],
      properties: {
        afterMs: {
          type: 'integer',
          minimum: 1,
          maximum: maxDelayMs,
          description: 'Positive delay before resume, in milliseconds.',
        },
        reason: { type: 'string', description: 'Short domain-neutral reason, echoed on resume.' },
        checkpoint: {
          type: 'object',
          description: 'Optional bounded JSON continuation data.',
        },
      },
    },
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      const afterMs = Number(input['afterMs'])
      if (!Number.isSafeInteger(afterMs) || afterMs < 1 || afterMs > maxDelayMs) {
        return { content: `Error: timer "afterMs" must be an integer in 1..${maxDelayMs}.`, isError: true }
      }
      const reason = String(input['reason'] ?? '').trim()
      if (!reason) return { content: 'Error: timer requires a non-empty "reason".', isError: true }
      const checkpoint = input['checkpoint']
      if (checkpoint !== undefined && (!isJsonObject(checkpoint) || jsonByteLength(checkpoint) > MAX_CHECKPOINT_BYTES)) {
        return { content: `Error: timer checkpoint must be a JSON object no larger than ${MAX_CHECKPOINT_BYTES} bytes.`, isError: true }
      }
      sink({
        afterMs,
        reason,
        ...(checkpoint !== undefined ? { checkpoint } : {}),
      })
      return {
        content: `Parked for ${afterMs} ms ("${reason}"). This segment ends now; ` +
          `you will be resumed after the delay to continue.`,
        isError: false,
      }
    },
  }
}

function isJsonObject(value: unknown, seen = new Set<object>()): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (seen.has(value)) return false
  seen.add(value)
  return Object.entries(value as Record<string, unknown>).every(([key, child]) =>
    key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && isJsonValue(child, seen))
}

function isJsonValue(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (seen.has(value)) return false
    seen.add(value)
    return value.every(child => isJsonValue(child, seen))
  }
  return isJsonObject(value, seen)
}

function jsonByteLength(value: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}
