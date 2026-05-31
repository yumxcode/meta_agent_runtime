import { describe, expect, it, beforeEach } from 'vitest'
import { CampaignStateStore } from '../CampaignStateStore.js'

// The eval cache and its touch helper are static-private but we can poke them
// via the test-only reset method + a thin reflection layer; the goal is to
// verify the LRU eviction behaviour, not to exercise full evaluations.jsonl
// reads (which need real campaign directories).

describe('CampaignStateStore._evalCache LRU (S5)', () => {
  beforeEach(() => {
    CampaignStateStore.resetAllForTest()
  })

  it('drops the least-recently-touched entry once over cap', () => {
    const cache = (CampaignStateStore as unknown as {
      _evalCache: Map<string, { offset: number; results: unknown[] }>
      _touchEvalCache: (id: string, entry: { offset: number; results: unknown[] }) => void
      _EVAL_CACHE_MAX: number
    })
    const cap = cache._EVAL_CACHE_MAX
    // Fill 1 over cap
    for (let i = 0; i < cap + 5; i++) {
      cache._touchEvalCache(`c-${i}`, { offset: i, results: [{ i }] })
    }
    expect(cache._evalCache.size).toBe(cap)
    // The first 5 keys should have been evicted
    expect(cache._evalCache.has('c-0')).toBe(false)
    expect(cache._evalCache.has('c-4')).toBe(false)
    expect(cache._evalCache.has(`c-${cap + 4}`)).toBe(true)
  })

  it('touch promotes an existing entry to most-recently-used', () => {
    const cache = (CampaignStateStore as unknown as {
      _evalCache: Map<string, { offset: number; results: unknown[] }>
      _touchEvalCache: (id: string, entry: { offset: number; results: unknown[] }) => void
      _EVAL_CACHE_MAX: number
    })
    const cap = cache._EVAL_CACHE_MAX
    // Fill the cache to capacity
    for (let i = 0; i < cap; i++) {
      cache._touchEvalCache(`c-${i}`, { offset: i, results: [] })
    }
    // Touch c-0 (oldest) → it should survive the next overflow
    const entry0 = cache._evalCache.get('c-0')!
    cache._touchEvalCache('c-0', entry0)
    // One more insertion → c-1 should be evicted instead of c-0
    cache._touchEvalCache('c-new', { offset: 999, results: [] })
    expect(cache._evalCache.has('c-0')).toBe(true)
    expect(cache._evalCache.has('c-1')).toBe(false)
  })
})
