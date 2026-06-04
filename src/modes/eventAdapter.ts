/**
 * eventAdapter — KernelEvent → MetaAgentEvent translation.
 *
 * KernelEvent uses snake_case event types that mirror CC's internal SDKMessage.
 * MetaAgentEvent uses the same structure but with slightly different names.
 * This module provides a pure translator with no side effects.
 */
import type { KernelEvent } from '../kernel/index.js'
import type { MetaAgentEvent, TokenUsage } from '../core/types.js'

export interface TranslationState {
  sessionId: string
  startMs: number
  turnCount: number
  totalCostUsd: number
  usage: TokenUsage
}

/**
 * Translate a single KernelEvent to zero or more MetaAgentEvents.
 * Returns a (possibly empty) array — not a generator — to keep callers simple.
 */
export function translateKernelEvent(
  event: KernelEvent,
  state: TranslationState,
): MetaAgentEvent[] {
  switch (event.type) {
    case 'text_delta':
      return [{
        type: 'text',
        text: event.delta,
        sessionId: state.sessionId,
      }]

    case 'thinking_delta':
      return [{
        type: 'thinking_delta',
        delta: event.delta,
        sessionId: state.sessionId,
      }]

    case 'tool_use':
      return [{
        type: 'tool_use',
        toolUseId: event.id,
        toolName: event.name,
        toolInput: event.input as Record<string, unknown>,
        sessionId: state.sessionId,
      }]

    case 'tool_result':
      return [{
        type: 'tool_result',
        toolUseId: event.id,
        content: event.content,
        isError: event.isError,
        sessionId: state.sessionId,
      }]

    case 'api_retry':
      return [{
        type: 'api_retry',
        attempt: event.attempt,
        maxRetries: event.maxRetries,
        retryDelayMs: event.retryDelayMs,
        sessionId: state.sessionId,
      }]

    case 'result': {
      const durationMs = Date.now() - state.startMs
      const subtype = mapResultSubtype(event.subtype)
      return [{
        type: 'result',
        subtype,
        sessionId: state.sessionId,
        result: event.resultText,
        isError: subtype !== 'success',
        durationMs,
        numTurns: state.turnCount,
        stopReason: event.stopReason,
        totalCostUsd: event.costUsd,
        usage: kernelUsageToMetaAgentUsage(event.usage),
        ...(event.errors?.length ? { errors: event.errors } : {}),
      }]
    }

    case 'compact_start':
      return [{
        type: 'compact_start',
        sessionId: state.sessionId,
      }]

    case 'compact_failed':
      return [{
        type: 'compact_failed',
        attempt: event.attempt,
        querySource: event.querySource,
        error: event.error,
        consecutiveFailures: event.consecutiveFailures,
        sessionId: state.sessionId,
      }]

    // compact_boundary, system_message, tool_use_summary — not surfaced upstream
    default:
      return []
  }
}

type MetaResultSubtype = 'success' | 'error_max_turns' | 'error_max_budget' | 'error_during_execution'

function mapResultSubtype(subtype: string): MetaResultSubtype {
  if (subtype === 'success')           return 'success'
  if (subtype === 'error_max_turns')   return 'error_max_turns'
  if (subtype === 'error_max_budget_usd') return 'error_max_budget'
  return 'error_during_execution'
}

function kernelUsageToMetaAgentUsage(
  u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
): TokenUsage {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadInputTokens: u.cacheReadTokens,
    cacheCreationInputTokens: u.cacheWriteTokens,
  }
}
