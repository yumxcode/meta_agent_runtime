/**
 * AutoCompact — check if auto-compact should trigger and run it.
 * Mirrors CC's autoCompact.ts.
 *
 * Key details:
 * - Circuit breaker: stop after MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES consecutive failures
 * - Recursion guard: skip if querySource is 'compact' or 'session_memory'
 * - DISABLE_AUTO_COMPACT / DISABLE_COMPACT env vars
 */
import type { KernelMessage } from '../types/KernelMessage.js'
import type { FileStateCache } from '../session/FileStateCache.js'
import type { CompactOptions } from './CompactConversation.js'
import { compactConversation } from './CompactConversation.js'
import { calculateTokenWarningState, isAutoCompactDisabled } from '../utils/Context.js'
import { tokenCountWithEstimation } from '../api/TokenCount.js'

const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

export interface AutoCompactTrackingState {
  /** Whether this session has been compacted at least once */
  compacted: boolean
  /** UUID to correlate compact events */
  turnId: string
  /** Resets to 0 on each compact, increments each loop turn */
  turnCounter: number
  /** Consecutive compact failures (reset to 0 on success) */
  consecutiveFailures: number
}

export interface AutoCompactResult {
  wasCompacted: boolean
  /** New messages if compaction ran (replaces the pre-compact messages in the loop) */
  postCompactMessages?: KernelMessage[]
  /** Estimated token count of the compact summary */
  summaryTokenEstimate?: number
  /** Present when a compact attempt ran and failed. */
  failure?: {
    attempt: number
    querySource?: string
    error: string
    consecutiveFailures: number
  }
  /** Updated tracking state */
  tracking: AutoCompactTrackingState
}

const SKIPPED_QUERY_SOURCES = new Set(['compact', 'session_memory'])

/**
 * Pure predicate: would autoCompactIfNeeded() actually run a compaction for
 * this state? Mirrors the recursion-guard / disable / circuit-breaker /
 * token-threshold gates below so callers (e.g. KernelLoop, to emit a
 * "compacting…" indicator) can decide WITHOUT triggering the work. Keep this in
 * lockstep with the gates in autoCompactIfNeeded.
 */
export function shouldAutoCompact(
  messagesForQuery: readonly KernelMessage[],
  model: string,
  querySource: string | undefined,
  tracking: AutoCompactTrackingState | undefined,
  maxOutputTokens: number | undefined,
  force = false,
): boolean {
  if (querySource && SKIPPED_QUERY_SOURCES.has(querySource)) return false
  if (isAutoCompactDisabled()) return false
  if ((tracking?.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) return false
  if (force) return true
  const tokenCount = tokenCountWithEstimation(messagesForQuery)
  return calculateTokenWarningState(tokenCount, model, maxOutputTokens).isAtCompactThreshold
}

/**
 * Check if auto-compact should trigger, and if so run it.
 *
 * @param messagesForQuery  - The messages that will be sent to the API (after boundary slice)
 * @param model             - Current main loop model
 * @param fileCache         - Session file state cache (will be cleared on compact)
 * @param querySource       - Recursion guard
 * @param tracking          - Current circuit breaker state
 * @param compactOptions    - Options forwarded to compactConversation
 */
export async function autoCompactIfNeeded(
  messagesForQuery: readonly KernelMessage[],
  model: string,
  fileCache: FileStateCache,
  querySource: string | undefined,
  tracking: AutoCompactTrackingState | undefined,
  maxOutputTokens: number | undefined,
  compactOptions: CompactOptions,
  force = false,
): Promise<AutoCompactResult> {
  const currentTracking: AutoCompactTrackingState = tracking ?? {
    compacted: false,
    turnId: crypto.randomUUID(),
    turnCounter: 0,
    consecutiveFailures: 0,
  }

  // ── Recursion guard ───────────────────────────────────────────────────────
  if (querySource && SKIPPED_QUERY_SOURCES.has(querySource)) {
    return { wasCompacted: false, tracking: currentTracking }
  }

  // ── Global disable ────────────────────────────────────────────────────────
  if (isAutoCompactDisabled()) {
    return { wasCompacted: false, tracking: currentTracking }
  }

  // ── Circuit breaker ───────────────────────────────────────────────────────
  if (currentTracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return { wasCompacted: false, tracking: currentTracking }
  }

  // ── Token threshold check ─────────────────────────────────────────────────
  const tokenCount = tokenCountWithEstimation(messagesForQuery)
  const { isAtCompactThreshold } = calculateTokenWarningState(tokenCount, model, maxOutputTokens)

  if (!force && !isAtCompactThreshold) {
    return { wasCompacted: false, tracking: { ...currentTracking, turnCounter: currentTracking.turnCounter + 1 } }
  }

  // ── Run compact ───────────────────────────────────────────────────────────
  try {
    const result = await compactConversation(messagesForQuery, fileCache, compactOptions)

    const newTracking: AutoCompactTrackingState = {
      compacted: true,
      turnId: crypto.randomUUID(),
      turnCounter: 0,
      consecutiveFailures: 0,     // success → reset
    }

    return {
      wasCompacted: true,
      postCompactMessages: result.postCompactMessages,
      summaryTokenEstimate: result.summaryTokenEstimate,
      tracking: newTracking,
    }
  } catch (_error: unknown) {
    // Compact failed — increment circuit breaker, continue without compacting
    const consecutiveFailures = currentTracking.consecutiveFailures + 1
    const newTracking: AutoCompactTrackingState = {
      ...currentTracking,
      consecutiveFailures,
    }
    return {
      wasCompacted: false,
      tracking: newTracking,
      failure: {
        attempt: consecutiveFailures,
        querySource,
        error: compactErrorSummary(_error),
        consecutiveFailures,
      },
    }
  }
}

function compactErrorSummary(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
