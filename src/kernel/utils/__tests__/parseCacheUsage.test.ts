import { describe, it, expect } from 'vitest'
import { parseCacheUsage } from '../parseCacheUsage.js'

describe('parseCacheUsage', () => {
  it('parses native Anthropic shape (input excludes cache)', () => {
    const ev = {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 800,
          cache_read_input_tokens: 1200,
          cache_creation_input_tokens: 50,
        },
      },
    }
    expect(parseCacheUsage(ev, 'anthropic')).toEqual({
      inputTokens: 800,
      cacheReadTokens: 1200,
      cacheWriteTokens: 50,
    })
  })

  it('parses flattened StreamEvent usage (DeepSeek synthetic message_start)', () => {
    const ev = {
      type: 'message_start',
      usage: { input_tokens: 800, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 },
    }
    expect(parseCacheUsage(ev)).toEqual({
      inputTokens: 800,
      cacheReadTokens: 1200,
      cacheWriteTokens: 0,
    })
  })

  it('parses OpenAI/GLM prompt_tokens_details shape and de-includes cached', () => {
    // prompt_tokens INCLUDES cached → inputTokens must be the remainder.
    const usage = { prompt_tokens: 2000, prompt_tokens_details: { cached_tokens: 1200 } }
    expect(parseCacheUsage(usage, 'zhipu')).toEqual({
      inputTokens: 800,
      cacheReadTokens: 1200,
      cacheWriteTokens: 0,
    })
  })

  it('parses GLM cache hit when wrapped in { usage }', () => {
    const chunk = { usage: { prompt_tokens: 1500, prompt_tokens_details: { cached_tokens: 900 } } }
    expect(parseCacheUsage(chunk, 'zhipu')).toEqual({
      inputTokens: 600,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    })
  })

  it('parses DeepSeek native hit/miss pair', () => {
    const usage = { prompt_tokens: 2000, prompt_cache_hit_tokens: 1200, prompt_cache_miss_tokens: 800 }
    expect(parseCacheUsage(usage, 'deepseek')).toEqual({
      inputTokens: 800,
      cacheReadTokens: 1200,
      cacheWriteTokens: 0,
    })
  })

  it('returns zeros for missing / malformed usage', () => {
    expect(parseCacheUsage(undefined)).toEqual({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(parseCacheUsage({})).toEqual({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(parseCacheUsage({ usage: { prompt_tokens: 'x' } } as never)).toEqual({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('never returns negative input when cached exceeds prompt_tokens', () => {
    const usage = { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 900 } }
    expect(parseCacheUsage(usage).inputTokens).toBe(0)
  })
})
