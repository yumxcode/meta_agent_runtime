/**
 * LoopState — mutable state threaded through the KernelLoop's while(true).
 * Mirrors CC's State type in query.ts.
 */
import type { KernelMessage } from '../types/KernelMessage.js'
import type { AutoCompactTrackingState } from '../compact/AutoCompact.js'

export interface LoopState {
  /** Messages visible to the API (post-compact boundary slice) */
  messages: KernelMessage[]

  /** Auto-compact circuit breaker state */
  autoCompactTracking: AutoCompactTrackingState | undefined

  /** How many multi-turn max_output_tokens recoveries have been attempted */
  maxOutputTokensRecoveryCount: number

  /** If set, override max_tokens on the next API call (64k escalation) */
  maxOutputTokensOverride: number | undefined

  /** Whether a reactive compact has already been attempted (avoid loops) */
  hasAttemptedReactiveCompact: boolean

  /**
   * How many CONSECUTIVE model-call (stream) errors have been recovered from in
   * this turn. Reset to 0 after any fully successful streamed turn. Bounds the
   * surface-and-retry recovery so a persistent provider error can't loop.
   */
  streamErrorRecoveryCount: number

  /** Number of completed agentic turns */
  turnCount: number

  /** The current model (may change on fallback) */
  currentModel: string

  /**
   * Tombstone: set to true after the first fallback switch.
   * Prevents infinite retry loops if the fallback model also triggers a fallback.
   */
  fallbackTriggered: boolean
}

export function initialLoopState(
  messages: KernelMessage[],
  model: string,
  autoCompactTracking?: AutoCompactTrackingState,
): LoopState {
  return {
    messages,
    autoCompactTracking,
    maxOutputTokensRecoveryCount: 0,
    maxOutputTokensOverride: undefined,
    hasAttemptedReactiveCompact: false,
    streamErrorRecoveryCount: 0,
    turnCount: 0,
    currentModel: model,
    fallbackTriggered: false,
  }
}
