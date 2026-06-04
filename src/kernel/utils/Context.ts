/**
 * Context — model context window sizes and threshold calculations.
 *
 * Window sizes come from the Provider Registry (single source of truth).
 * Threshold logic mirrors CC's autocompact.ts.
 */
import { getModelContextWindow, DEFAULT_CONTEXT_WINDOW } from '../../providers/registry.js'

export function getContextWindowSize(model: string): number {
  // Allow env override (CC: CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  const envOverride = process.env['CLAUDE_CODE_AUTO_COMPACT_WINDOW']
  if (envOverride) {
    const n = parseInt(envOverride, 10)
    if (!isNaN(n) && n > 0) return n
  }
  return getModelContextWindow(model)
}

// ── Threshold calculations (mirroring CC's autocompact.ts) ───────────────────

const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768
const LONG_CONTEXT_AUTOCOMPACT_CAP = 180_000

export interface TokenWarningState {
  /** Context is at or above the autocompact trigger threshold */
  isAtCompactThreshold: boolean
  /** Context is at or above the blocking limit (request will be rejected) */
  isAtBlockingLimit: boolean
  autoCompactThreshold: number
  blockingLimit: number
  effectiveContextWindow: number
}

export function calculateTokenWarningState(
  currentTokenCount: number,
  model: string,
  maxOutputTokens: number = DEFAULT_MAX_OUTPUT_TOKENS,
): TokenWarningState {
  // Allow override via env (CC: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
  const pctOverride = process.env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE']

  const contextWindow = getContextWindowSize(model)
  const effectiveContextWindow = contextWindow - Math.min(maxOutputTokens, 20_000)

  let autoCompactThreshold: number
  if (pctOverride) {
    const pct = parseFloat(pctOverride)
    if (!isNaN(pct) && pct > 0 && pct <= 1) {
      autoCompactThreshold = Math.floor(effectiveContextWindow * pct)
    } else {
      autoCompactThreshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
    }
  } else {
    autoCompactThreshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
  }

  if (!pctOverride && contextWindow > DEFAULT_CONTEXT_WINDOW) {
    const rawCap = process.env['META_AGENT_LONG_CONTEXT_AUTOCOMPACT_THRESHOLD']
    const cap = rawCap ? Number.parseInt(rawCap, 10) : LONG_CONTEXT_AUTOCOMPACT_CAP
    if (Number.isFinite(cap) && cap > 0) {
      autoCompactThreshold = Math.min(autoCompactThreshold, cap)
    }
  }

  const blockingLimit = effectiveContextWindow - MANUAL_COMPACT_BUFFER_TOKENS

  return {
    isAtCompactThreshold: currentTokenCount >= autoCompactThreshold,
    isAtBlockingLimit: currentTokenCount >= blockingLimit,
    autoCompactThreshold,
    blockingLimit,
    effectiveContextWindow,
  }
}

export function isAutoCompactDisabled(): boolean {
  return !!(
    process.env['DISABLE_COMPACT'] ||
    process.env['DISABLE_AUTO_COMPACT']
  )
}

// ── Escalated max tokens (for max_output_tokens recovery) ────────────────────
export const ESCALATED_MAX_TOKENS = 131_072
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3
