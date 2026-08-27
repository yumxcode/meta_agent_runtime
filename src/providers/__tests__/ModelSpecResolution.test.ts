/**
 * Model spec resolution: exact table → version-aware family rule → default.
 *
 * ── The bug this replaces ───────────────────────────────────────────────────
 *
 * The old lookup enumerated model names and prefix-matched them case-sensitively.
 * Every miss fell through to a 200k window and Claude pricing — and because the
 * fallback window happened to equal a real model's, the miss was invisible:
 *
 *   glm-5.3        1M in reality → 200k here → compacted at 117k instead of 637k,
 *                  and billed at ~7x the true rate, which also trips budget caps
 *   GLM-5.3        case mismatch → same silent fallback
 *   zhipu/glm-5.3  vendor prefix → same silent fallback
 *
 * An enumerated table structurally cannot keep up with releases, so the family
 * rules key off the version instead. The tests below therefore include versions
 * that DO NOT EXIST yet — that is the point: a correct rule answers for them
 * without anyone editing this file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveModelSpec,
  getModelContextWindow,
  normalizeModelName,
  clearUnknownModelWarningsForTests,
  DEFAULT_CONTEXT_WINDOW,
} from '../registry.js'

afterEach(() => {
  clearUnknownModelWarningsForTests()
  vi.restoreAllMocks()
})

describe('a pinned table entry always wins', () => {
  it.each([
    ['glm-4.5', 128_000],
    ['glm-4.6', 200_000],
    ['glm-5.2', 1_000_000],
    ['glm-4.5-air', 128_000],
    ['claude-sonnet-4-6', 200_000],
    ['deepseek-v4-flash', 1_000_000],
  ])('%s resolves exactly to %i', (model, window) => {
    const resolved = resolveModelSpec(model)
    expect(resolved.source).toBe('exact')
    expect(resolved.spec.contextWindow).toBe(window)
  })

  it('prefers the longest matching key', () => {
    // glm-4.5-air must not be captured by the shorter glm-4.5 entry.
    expect(resolveModelSpec('glm-4.5-air').matchedBy).toBe('glm-4.5-air')
  })
})

describe('family rules answer for versions nobody has enumerated', () => {
  it.each(['glm-5.9', 'glm-6', 'glm-7.1'])('%s gets a 1M window with no table entry', model => {
    // Versions chosen precisely because they are NOT in the table. If a future
    // release gets pinned here, move it to the exact-match group above rather
    // than weakening this assertion — its whole value is that it covers
    // versions nobody has enumerated.
    const resolved = resolveModelSpec(model)
    expect(resolved.spec.contextWindow).toBe(1_000_000)
    expect(resolved.source).toBe('family')
  })

  it('gives glm-5.3 a 1M window — the version from the reported bug', () => {
    // Now pinned in the table, but it must resolve to 1M by either route: the
    // symptom was a 117k compaction trigger, and how it is resolved matters
    // less than that it is right.
    expect(resolveModelSpec('glm-5.3').spec.contextWindow).toBe(1_000_000)
  })

  it('still gives older GLM lines their real, smaller windows', () => {
    // The rule must not blanket-assign 1M — 4.x really was smaller, and
    // over-stating a window makes the session run into a hard API limit.
    expect(resolveModelSpec('glm-4.9').spec.contextWindow).toBe(200_000)
    expect(resolveModelSpec('glm-4.3').spec.contextWindow).toBe(128_000)
  })

  it('gives unpinned DeepSeek versions a 1M window', () => {
    expect(resolveModelSpec('deepseek-v5').spec.contextWindow).toBe(1_000_000)
    expect(resolveModelSpec('deepseek-v9-pro').spec.contextWindow).toBe(1_000_000)
  })

  it('does not assume a long window for unpinned Claude versions', () => {
    // Anthropic's published default is 200k; a longer window is opt-in per
    // deployment, so guessing high here would cause hard request rejections.
    expect(resolveModelSpec('claude-sonnet-9-9').spec.contextWindow).toBe(200_000)
  })

  it('carries the family\'s pricing, not the Claude default', () => {
    // The window was only half the bug. An unrecognised glm-5.3 was also billed
    // at Claude rates — roughly 7x — which silently trips budget caps.
    expect(resolveModelSpec('glm-5.3').spec.pricing.input).toBe(0.43)
    expect(resolveModelSpec('deepseek-v5').spec.pricing.input).toBeCloseTo(0.1389, 4)
  })
})

describe('normalisation closes two silent-miss paths', () => {
  it('is case-insensitive', () => {
    expect(resolveModelSpec('GLM-5.3').spec.contextWindow).toBe(1_000_000)
    expect(resolveModelSpec('DeepSeek-V5').spec.contextWindow).toBe(1_000_000)
  })

  it('ignores a vendor prefix', () => {
    expect(resolveModelSpec('zhipu/glm-5.3').spec.contextWindow).toBe(1_000_000)
    expect(resolveModelSpec('openrouter/z-ai/glm-5.3').spec.contextWindow).toBe(1_000_000)
  })

  it('normalises predictably', () => {
    expect(normalizeModelName('  Zhipu/GLM-5.3 ')).toBe('glm-5.3')
    expect(normalizeModelName('glm-5.3')).toBe('glm-5.3')
  })
})

describe('an unknown model is reported, not silently defaulted', () => {
  it('marks the source as default', () => {
    const resolved = resolveModelSpec('not-a-real-model-xyz')
    expect(resolved.source).toBe('default')
    expect(resolved.matchedBy).toBeUndefined()
    expect(resolved.spec.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('warns once per model name', () => {
    // The silence was the actual defect: a 200k default is indistinguishable
    // from a genuine 200k match by its number alone.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getModelContextWindow('mystery-model-1')
    getModelContextWindow('mystery-model-1')
    getModelContextWindow('mystery-model-2')

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]![0]).toContain('mystery-model-1')
    expect(warn.mock.calls[0]![0]).toContain('META_AGENT_AUTO_COMPACT_WINDOW')
  })

  it('does not warn for a model that resolved by family rule', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getModelContextWindow('glm-5.3')
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not warn for a pinned model', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getModelContextWindow('glm-4.6')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('the reported compaction symptom is fixed', () => {
  it('gives glm-5.3 a 637k trigger rather than 117k', async () => {
    const { calculateTokenWarningState } = await import('../../kernel/utils/Context.js')
    expect(calculateTokenWarningState(0, 'glm-5.3').autoCompactThreshold).toBe(637_000)
    // The observed failure: a session compacted at 169.3k because the trigger
    // had been computed as 117k.
    expect(calculateTokenWarningState(169_300, 'glm-5.3').isAtCompactThreshold).toBe(false)
  })
})
