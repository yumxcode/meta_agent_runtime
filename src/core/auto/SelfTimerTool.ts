import type { MetaAgentTool, ToolResult } from '../types.js'

const DEFAULT_MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1_000
const MAX_REASON_CHARS = 1_000
const MAX_CHECKPOINT_BYTES = 16 * 1_024

export interface SelfTimerToolDeps {
  /** Running/queued child work must settle before the parent process may exit. */
  getOutstandingSubAgents: () => { runningIds: string[]; queued: number }
  maxDelayMs?: number
}

/**
 * Plain-auto durable suspension tool.
 *
 * The tool itself does not write a wake record. It emits a kernel control
 * request; the host must first persist conversation + checkpoint, then arm the
 * wake atomically. That ordering prevents a scheduler from resuming history
 * that has not reached disk yet.
 */
export function createSelfTimerTool(deps: SelfTimerToolDeps): MetaAgentTool {
  const maxDelayMs = deps.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  return {
    name: 'self_timer',
    abortSupport: 'bounded',
    isConcurrencySafe: false,
    description: `Durably park this plain Auto session and resume the same goal later.

Use this only when useful progress depends on time passing (for example waiting
for an external job, remote training run, deployment, review, or rate-limit
window). Remote training is a primary use case: when a remote training run is
expected to take longer than 1 hour, you should use self_timer instead of sleep
or repeated polling. Do not use it as ordinary retry backoff while work can
continue now. The host persists the full conversation and Auto checkpoint,
exits this execution segment, then the single auto-scheduler resumes the same
session after the delay.

You may not park while sub-agents are running or queued. checkpoint is a small
JSON object containing only facts needed on wake. A successful call mechanically
ends the current run; later tool calls in the same model batch are skipped.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['afterMs', 'reason'],
      properties: {
        afterMs: {
          type: 'integer',
          minimum: 1,
          maximum: maxDelayMs,
          description:
            'Delay before the scheduler may resume this session, in milliseconds. ' +
            'Use this for remote training expected to run longer than 1 hour.',
        },
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_REASON_CHARS,
          description: 'Why waiting is necessary and what should be checked after wake.',
        },
        checkpoint: {
          type: 'object',
          description: `Optional JSON continuation facts, at most ${MAX_CHECKPOINT_BYTES} bytes.`,
        },
      },
    },
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      const afterMs = Number(input['afterMs'])
      if (!Number.isSafeInteger(afterMs) || afterMs < 1 || afterMs > maxDelayMs) {
        return {
          content: `Error: self_timer.afterMs must be an integer in 1..${maxDelayMs}.`,
          isError: true,
        }
      }

      const reason = typeof input['reason'] === 'string' ? input['reason'].trim() : ''
      if (!reason || reason.length > MAX_REASON_CHARS) {
        return {
          content: `Error: self_timer.reason must contain 1..${MAX_REASON_CHARS} characters.`,
          isError: true,
        }
      }

      const checkpoint = input['checkpoint']
      if (
        checkpoint !== undefined &&
        (!isJsonObject(checkpoint) || jsonByteLength(checkpoint) > MAX_CHECKPOINT_BYTES)
      ) {
        return {
          content:
            `Error: self_timer.checkpoint must be a JSON object no larger than ` +
            `${MAX_CHECKPOINT_BYTES} bytes.`,
          isError: true,
        }
      }

      const outstanding = deps.getOutstandingSubAgents()
      if (outstanding.runningIds.length > 0 || outstanding.queued > 0) {
        const running = outstanding.runningIds.length > 0
          ? ` running=${outstanding.runningIds.join(',')}`
          : ''
        return {
          content:
            `Error: cannot park while sub-agents are outstanding ` +
            `(queued=${outstanding.queued}, running=${outstanding.runningIds.length}).${running} ` +
            `Wait for or cancel them first.`,
          isError: true,
        }
      }

      return {
        content:
          `Durable park requested for ${afterMs}ms. The host will persist this ` +
          `session before arming the wake.`,
        isError: false,
        control: {
          kind: 'park',
          afterMs,
          reason,
          ...(checkpoint !== undefined
            ? { checkpoint: checkpoint as Record<string, unknown> }
            : {}),
        },
      }
    },
  }
}

function isJsonObject(value: unknown, seen = new Set<object>()): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) return false
  seen.add(value)
  return Object.entries(value as Record<string, unknown>).every(([key, child]) =>
    key !== '__proto__' &&
    key !== 'constructor' &&
    key !== 'prototype' &&
    isJsonValue(child, seen),
  )
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
