/**
 * FlashClient — failure reporting policy and result caching.
 *
 * The bug this file pins came in from the field, in robotics mode:
 *
 *   [meta-agent] flash call failed (model=glm-4.5-air, maxTokens=250,
 *   timeout=8000ms) — using caller fallback: Timed out after 8000 ms
 *
 * printed into the middle of a streaming model response, every few turns. It
 * came from QueryAnalyzer's background cache-warm — a request that had ALREADY
 * lost its race and been abandoned, i.e. a component working exactly as
 * designed. `query()` warned on every failure with no way for a caller to say
 * "mine is best-effort".
 *
 * Silencing it outright would have been worse: the warning exists because a
 * flash model that is misconfigured, unreachable, or simply too slow for its
 * budget otherwise degrades a whole feature into its fallback with no symptom
 * at all. So speculative failures are counted and reported ONCE per caller
 * after a threshold. These tests hold that shape: quiet by default, loud enough
 * to be discoverable, and never a per-turn stream of noise.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: createMock }
    constructor(public opts: unknown) {}
  }
  return { default: FakeAnthropic }
})
vi.mock('openai', () => {
  class FakeOpenAI {
    chat = { completions: { create: createMock } }
    constructor(public opts: unknown) {}
  }
  return { default: FakeOpenAI }
})

const { FlashClient } = await import('../FlashClient.js')

/** Zhipu/GLM baseURL keeps the client on the Anthropic protocol path. */
const CONFIG = {
  apiKey: 'k',
  baseURL: 'https://open.bigmodel.cn/api/anthropic',
  model: 'glm-5.2',
  flashModel: 'glm-4.5-air',
} as never

function textReply(text: string): unknown {
  return { content: [{ type: 'text', text }] }
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  createMock.mockReset()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

const opts = (extra: Record<string, unknown> = {}) => ({
  system: 's', user: 'u', maxTokens: 250, ...extra,
} as never)

// ── Happy path ────────────────────────────────────────────────────────────────

describe('query', () => {
  it('returns the trimmed text', async () => {
    createMock.mockResolvedValueOnce(textReply('  hello  '))
    expect(await new FlashClient(CONFIG).query(opts())).toBe('hello')
  })

  it('returns null when the model produced no text block', async () => {
    createMock.mockResolvedValueOnce({ content: [] })
    expect(await new FlashClient(CONFIG).query(opts())).toBeNull()
    expect(warn).not.toHaveBeenCalled()   // not an error, just an empty answer
  })

  it('uses the configured flashModel, not the main model', async () => {
    createMock.mockResolvedValueOnce(textReply('x'))
    const client = new FlashClient(CONFIG)
    await client.query(opts())
    expect(client.modelId).toBe('glm-4.5-air')
    expect((createMock.mock.calls[0]![0] as Record<string, unknown>)['model']).toBe('glm-4.5-air')
  })
})

// ── Caching ───────────────────────────────────────────────────────────────────

describe('result cache', () => {
  it('a cacheKey hit skips the network entirely', async () => {
    createMock.mockResolvedValueOnce(textReply('cached'))
    const client = new FlashClient(CONFIG)
    expect(await client.query(opts({ cacheKey: 'k1' }))).toBe('cached')
    expect(await client.query(opts({ cacheKey: 'k1' }))).toBe('cached')
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('different keys do not collide', async () => {
    createMock.mockResolvedValueOnce(textReply('a')).mockResolvedValueOnce(textReply('b'))
    const client = new FlashClient(CONFIG)
    expect(await client.query(opts({ cacheKey: 'k1' }))).toBe('a')
    expect(await client.query(opts({ cacheKey: 'k2' }))).toBe('b')
  })

  it('a failed call is not cached, so a later attempt can still succeed', async () => {
    createMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(textReply('ok'))
    const client = new FlashClient(CONFIG)
    expect(await client.query(opts({ cacheKey: 'k1' }))).toBeNull()
    expect(await client.query(opts({ cacheKey: 'k1' }))).toBe('ok')
  })

  it('clearCache drops results', async () => {
    createMock.mockResolvedValue(textReply('v'))
    const client = new FlashClient(CONFIG)
    await client.query(opts({ cacheKey: 'k1' }))
    client.clearCache()
    await client.query(opts({ cacheKey: 'k1' }))
    expect(createMock).toHaveBeenCalledTimes(2)
  })
})

// ── Failure reporting ─────────────────────────────────────────────────────────

describe('ordinary (non-speculative) failures', () => {
  it('warn on EVERY failure — a broken knowledge pipeline must not be silent', async () => {
    createMock.mockRejectedValue(new Error('Timed out after 42500 ms'))
    const client = new FlashClient(CONFIG)
    for (let i = 0; i < 3; i++) await client.query(opts())
    expect(warn).toHaveBeenCalledTimes(3)
    expect(String(warn.mock.calls[0]![0])).toMatch(/flash call failed/)
    expect(String(warn.mock.calls[0]![0])).toContain('glm-4.5-air')
  })

  it('names the effective timeout so the budget itself can be diagnosed', async () => {
    createMock.mockRejectedValue(new Error('nope'))
    await new FlashClient(CONFIG).query(opts({ timeoutMs: 8_000 }))
    expect(String(warn.mock.calls[0]![0])).toContain('timeout=8000ms')
  })
})

describe('speculative failures', () => {
  it('are SILENT below the threshold', async () => {
    createMock.mockRejectedValue(new Error('Timed out'))
    const client = new FlashClient(CONFIG)
    for (let i = 0; i < 4; i++) {
      await client.query(opts({ speculative: true, label: 'query-intent-analysis' }))
    }
    // This is the regression: four abandoned cache-warms used to print four
    // alarming lines into the middle of the user's streaming output.
    expect(warn).not.toHaveBeenCalled()
    expect(client.speculativeFailureCount('query-intent-analysis')).toBe(4)
  })

  it('report EXACTLY ONCE at the threshold, then stay quiet', async () => {
    createMock.mockRejectedValue(new Error('Timed out'))
    const client = new FlashClient(CONFIG)
    for (let i = 0; i < 20; i++) {
      await client.query(opts({ speculative: true, label: 'query-intent-analysis' }))
    }
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]![0])
    expect(message).toContain('query-intent-analysis')
    expect(message).toMatch(/failed 5 times/)
    // The wording must not read as breakage — it isn't.
    expect(message).toMatch(/best-effort/)
    expect(message).toMatch(/contributing nothing/)
  })

  it('count per label, so two callers do not mask each other', async () => {
    createMock.mockRejectedValue(new Error('Timed out'))
    const client = new FlashClient(CONFIG)
    for (let i = 0; i < 4; i++) await client.query(opts({ speculative: true, label: 'a' }))
    for (let i = 0; i < 4; i++) await client.query(opts({ speculative: true, label: 'b' }))
    expect(warn).not.toHaveBeenCalled()
    expect(client.speculativeFailureCount('a')).toBe(4)
    expect(client.speculativeFailureCount('b')).toBe(4)
  })

  it('a successful speculative call still returns its result', async () => {
    createMock.mockResolvedValueOnce(textReply('intent json'))
    const client = new FlashClient(CONFIG)
    expect(await client.query(opts({ speculative: true, label: 'x' }))).toBe('intent json')
    expect(warn).not.toHaveBeenCalled()
  })

  it('clearCache resets the failure counters too', async () => {
    createMock.mockRejectedValue(new Error('Timed out'))
    const client = new FlashClient(CONFIG)
    for (let i = 0; i < 4; i++) await client.query(opts({ speculative: true, label: 'x' }))
    client.clearCache()
    expect(client.speculativeFailureCount('x')).toBe(0)
  })
})
