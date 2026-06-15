/**
 * Context (token threshold + model window) unit tests
 *
 * Covers:
 *  - getContextWindowSize: known model, prefix match, env override, unknown model
 *  - calculateTokenWarningState: threshold math, blocking limit, percentage override
 *  - isAutoCompactDisabled: env var checks
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getContextWindowSize,
  calculateTokenWarningState,
  isAutoCompactDisabled,
  ESCALATED_MAX_TOKENS,
  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
} from '../utils/Context.js'
import { tokenCountWithEstimation } from '../api/TokenCount.js'
import type { KernelMessage } from '../types/KernelMessage.js'

// ── getContextWindowSize ──────────────────────────────────────────────────────

describe('getContextWindowSize', () => {
  afterEach(() => {
    delete process.env['CLAUDE_CODE_AUTO_COMPACT_WINDOW']
  })

  it('returns 200_000 for known claude models', () => {
    expect(getContextWindowSize('claude-sonnet-4-6')).toBe(200_000)
    expect(getContextWindowSize('claude-opus-4-6')).toBe(200_000)
    expect(getContextWindowSize('claude-haiku-4-5-20251001')).toBe(200_000)
  })

  it('returns 1_000_000 for deepseek models', () => {
    expect(getContextWindowSize('deepseek-chat')).toBe(1_000_000)
    expect(getContextWindowSize('deepseek-reasoner')).toBe(1_000_000)
    expect(getContextWindowSize('deepseek-v4-flash')).toBe(1_000_000)
    expect(getContextWindowSize('deepseek-v4-pro')).toBe(1_000_000)
  })

  it('returns default 200_000 for unknown model', () => {
    expect(getContextWindowSize('some-unknown-model-xyz')).toBe(200_000)
  })

  it('uses env override when set to valid number', () => {
    process.env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'] = '50000'
    expect(getContextWindowSize('claude-sonnet-4-6')).toBe(50_000)
  })

  it('ignores invalid env override and falls back to table', () => {
    process.env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'] = 'not-a-number'
    expect(getContextWindowSize('claude-sonnet-4-6')).toBe(200_000)
  })

  it('ignores zero/negative env override', () => {
    process.env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'] = '0'
    expect(getContextWindowSize('claude-sonnet-4-6')).toBe(200_000)
  })
})

// ── tokenCountWithEstimation ─────────────────────────────────────────────────

describe('tokenCountWithEstimation', () => {
  it('includes content appended after the latest assistant usage report', () => {
    const messages: KernelMessage[] = [
      {
        uuid: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      {
        uuid: 'tool-result-1',
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: 'x'.repeat(400),
        }],
      },
    ]

    expect(tokenCountWithEstimation(messages)).toBe(210)
  })
})

// ── calculateTokenWarningState ────────────────────────────────────────────────

describe('calculateTokenWarningState', () => {
  beforeEach(() => {
    delete process.env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE']
    delete process.env['CLAUDE_CODE_AUTO_COMPACT_WINDOW']
  })
  afterEach(() => {
    delete process.env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE']
    delete process.env['CLAUDE_CODE_AUTO_COMPACT_WINDOW']
  })

  const MODEL = 'claude-sonnet-4-6'
  const CONTEXT = 200_000
  const MAX_OUT = 32_768
  // effectiveContextWindow = 200_000 - min(32_768, 20_000) = 180_000
  const EFFECTIVE = 180_000
  // Default auto-compact trigger = 65% of the effective window.
  const THRESHOLD = Math.floor(EFFECTIVE * 0.65)
  const MANUAL_BUFFER = 3_000

  it('returns correct threshold values for default config', () => {
    const state = calculateTokenWarningState(0, MODEL, MAX_OUT)
    expect(state.effectiveContextWindow).toBe(EFFECTIVE)
    expect(state.autoCompactThreshold).toBe(THRESHOLD)
    expect(state.blockingLimit).toBe(EFFECTIVE - MANUAL_BUFFER)
  })

  it('isAtCompactThreshold is false below threshold', () => {
    const below = THRESHOLD - 1
    const { isAtCompactThreshold } = calculateTokenWarningState(below, MODEL, MAX_OUT)
    expect(isAtCompactThreshold).toBe(false)
  })

  it('isAtCompactThreshold is true at threshold', () => {
    const at = THRESHOLD
    const { isAtCompactThreshold } = calculateTokenWarningState(at, MODEL, MAX_OUT)
    expect(isAtCompactThreshold).toBe(true)
  })

  it('isAtBlockingLimit is false below blocking limit', () => {
    const below = EFFECTIVE - MANUAL_BUFFER - 1
    const { isAtBlockingLimit } = calculateTokenWarningState(below, MODEL, MAX_OUT)
    expect(isAtBlockingLimit).toBe(false)
  })

  it('isAtBlockingLimit is true at blocking limit', () => {
    const at = EFFECTIVE - MANUAL_BUFFER
    const { isAtBlockingLimit } = calculateTokenWarningState(at, MODEL, MAX_OUT)
    expect(isAtBlockingLimit).toBe(true)
  })

  it('respects CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', () => {
    process.env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'] = '0.5'
    const state = calculateTokenWarningState(0, MODEL, MAX_OUT)
    expect(state.autoCompactThreshold).toBe(Math.floor(EFFECTIVE * 0.5))
  })

  it('ignores invalid CLAUDE_AUTOCOMPACT_PCT_OVERRIDE and uses default', () => {
    process.env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'] = 'bad'
    const state = calculateTokenWarningState(0, MODEL, MAX_OUT)
    expect(state.autoCompactThreshold).toBe(THRESHOLD)
  })

  it('ignores out-of-range CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (>1)', () => {
    process.env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'] = '1.5'
    const state = calculateTokenWarningState(0, MODEL, MAX_OUT)
    expect(state.autoCompactThreshold).toBe(THRESHOLD)
  })

  it('caps maxOutputTokens contribution at 20_000', () => {
    // Very large maxOutputTokens — capped at 20_000
    const state = calculateTokenWarningState(0, MODEL, 100_000)
    expect(state.effectiveContextWindow).toBe(CONTEXT - 20_000)
  })

  it('uses default maxOutputTokens when undefined', () => {
    // Default is 32_768; min(32_768, 20_000) = 20_000
    const state = calculateTokenWarningState(0, MODEL)
    expect(state.effectiveContextWindow).toBe(CONTEXT - 20_000)
  })
})

// ── isAutoCompactDisabled ─────────────────────────────────────────────────────

describe('isAutoCompactDisabled', () => {
  afterEach(() => {
    delete process.env['DISABLE_COMPACT']
    delete process.env['DISABLE_AUTO_COMPACT']
  })

  it('returns false when neither env var is set', () => {
    expect(isAutoCompactDisabled()).toBe(false)
  })

  it('returns true when DISABLE_COMPACT is set', () => {
    process.env['DISABLE_COMPACT'] = '1'
    expect(isAutoCompactDisabled()).toBe(true)
  })

  it('returns true when DISABLE_AUTO_COMPACT is set', () => {
    process.env['DISABLE_AUTO_COMPACT'] = 'true'
    expect(isAutoCompactDisabled()).toBe(true)
  })
})

// ── Constants ─────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('ESCALATED_MAX_TOKENS is 131_072', () => {
    expect(ESCALATED_MAX_TOKENS).toBe(131_072)
  })

  it('MAX_OUTPUT_TOKENS_RECOVERY_LIMIT is 3', () => {
    expect(MAX_OUTPUT_TOKENS_RECOVERY_LIMIT).toBe(3)
  })
})
