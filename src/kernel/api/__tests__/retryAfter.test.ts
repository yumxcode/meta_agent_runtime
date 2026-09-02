/**
 * The retry ladder must not out-stubborn the server.
 *
 * Both clients backed off on a fixed 1s→30s exponential schedule and ignored
 * the response headers entirely. A 429 whose quota window resets in 60 s
 * therefore burned all five attempts inside that window (~45 s of waiting in
 * total), failed, and was reported as `AvailabilityFallbackTriggeredError` —
 * which downgrades the model. One honest wait would have succeeded.
 */
import { describe, expect, it } from 'vitest'
import { MAX_RETRY_AFTER_MS, retryAfterMsFromError } from '../Errors.js'

const NOW = Date.parse('2026-09-02T10:00:00Z')

describe('retryAfterMsFromError', () => {
  it('returns null when there is nothing to go on', () => {
    expect(retryAfterMsFromError(undefined)).toBeNull()
    expect(retryAfterMsFromError(new Error('boom'))).toBeNull()
    expect(retryAfterMsFromError({ status: 429 })).toBeNull()
    expect(retryAfterMsFromError({ status: 429, headers: {} })).toBeNull()
  })

  it('reads delta-seconds from a plain header object', () => {
    expect(retryAfterMsFromError({ headers: { 'retry-after': '30' } }, NOW)).toBe(30_000)
  })

  it('is case-insensitive — SDKs do not agree on header casing', () => {
    expect(retryAfterMsFromError({ headers: { 'Retry-After': '5' } }, NOW)).toBe(5_000)
  })

  it('reads a fetch Headers instance', () => {
    const headers = new Headers({ 'retry-after': '12' })
    expect(retryAfterMsFromError({ headers }, NOW)).toBe(12_000)
  })

  it('accepts the HTTP-date form', () => {
    const at = new Date(NOW + 45_000).toUTCString()
    // toUTCString has second resolution, so allow the rounding.
    expect(retryAfterMsFromError({ headers: { 'retry-after': at } }, NOW))
      .toBeGreaterThanOrEqual(44_000)
  })

  it('falls back to the soonest anthropic rate-limit reset', () => {
    const headers = {
      'anthropic-ratelimit-requests-reset': new Date(NOW + 90_000).toISOString(),
      'anthropic-ratelimit-input-tokens-reset': new Date(NOW + 20_000).toISOString(),
    }
    expect(retryAfterMsFromError({ headers }, NOW)).toBe(20_000)
  })

  it('ignores resets that are already in the past', () => {
    const headers = {
      'anthropic-ratelimit-requests-reset': new Date(NOW - 10_000).toISOString(),
    }
    expect(retryAfterMsFromError({ headers }, NOW)).toBeNull()
  })

  it('caps a hostile or misconfigured hint', () => {
    // `retry-after: 86400` on a quota page is not hypothetical, and in a
    // proxied deployment the header is attacker-influenceable.
    expect(retryAfterMsFromError({ headers: { 'retry-after': '86400' } }, NOW))
      .toBe(MAX_RETRY_AFTER_MS)
  })

  it('ignores garbage rather than parking on NaN', () => {
    expect(retryAfterMsFromError({ headers: { 'retry-after': 'soon' } }, NOW)).toBeNull()
    expect(retryAfterMsFromError({ headers: { 'retry-after': '-5' } }, NOW)).toBeNull()
    expect(retryAfterMsFromError({ headers: { 'retry-after': '' } }, NOW)).toBeNull()
  })
})

describe('the delay a client actually sleeps', () => {
  // Mirrors the expression in AnthropicClient / DeepSeekClient.
  const effective = (backoffMs: number, error: unknown): number =>
    Math.max(backoffMs, retryAfterMsFromError(error, NOW) ?? 0)

  it('keeps our backoff when the server asks for less', () => {
    expect(effective(8_000, { headers: { 'retry-after': '1' } })).toBe(8_000)
  })

  it('waits the server out when it asks for more', () => {
    expect(effective(2_000, { headers: { 'retry-after': '60' } })).toBe(60_000)
  })

  it('is unchanged when no hint is present', () => {
    expect(effective(4_000, new Error('503'))).toBe(4_000)
  })
})
