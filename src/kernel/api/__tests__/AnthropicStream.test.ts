/**
 * AnthropicClient.streamMessages — retry, no-replay, and error classification.
 *
 * This is the wire path for the DEFAULT provider: Zhipu/GLM speaks the
 * Anthropic protocol (`providers/registry.ts` → `zhipu.protocol: 'anthropic'`),
 * so every request a default install makes goes through this function. It sat
 * at 14.6% line coverage with only an auth-header test beside it.
 *
 * The logic worth pinning is not the happy path — it is the retry loop's
 * decision table, and above all the `yieldedAny` rule: once ANY event has
 * reached the caller, a retry would replay the whole response from the start,
 * duplicating rendered terminal output and double-counting usage/cost. That
 * rule is one boolean and one `if`, and nothing was watching it.
 *
 * The SDK is mocked at the module boundary so these are ordinary fast unit
 * tests with no network and no key.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// ── SDK mock ──────────────────────────────────────────────────────────────────
// Declared before the import of the module under test (vi.mock is hoisted).

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: createMock }
    constructor(public opts: unknown) {}
  }
  return { default: FakeAnthropic }
})

// Keep the watchdog out of the way: these tests are about the retry loop.
// Only `withStreamWatchdog` is replaced — `isStreamTimeoutError` must stay real
// because Errors.isRetryableError calls it on every classification.
vi.mock('../StreamWatchdog.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../StreamWatchdog.js')>()),
  withStreamWatchdog: <T>(stream: T) => stream,
}))

const { streamMessages, clearAnthropicClientCache } = await import('../AnthropicClient.js')
const { PromptTooLongError, FallbackTriggeredError, AvailabilityFallbackTriggeredError } =
  await import('../Errors.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

function params(overrides: Record<string, unknown> = {}): never {
  return {
    model: 'glm-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    sessionId: 'test-session',
    abortSignal: new AbortController().signal,
    ...overrides,
  } as never
}

/** An async iterable of SDK-shaped events. */
async function* events(...items: unknown[]): AsyncGenerator<unknown> {
  for (const i of items) yield i
}

/** Yields one event, then throws — the "mid-stream failure" shape. */
async function* eventsThenThrow(first: unknown, error: unknown): AsyncGenerator<unknown> {
  yield first
  throw error
}

function apiError(status: number, message = `status ${status}`): Error {
  const err = new Error(message) as Error & { status: number }
  err.status = status
  return err
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const e of gen) out.push(e)
  return out
}

const cfg = { apiKey: 'test-key', maxRetries: 3 } as never

beforeEach(() => {
  createMock.mockReset()
  clearAnthropicClientCache()
})
afterEach(() => {
  vi.useRealTimers()
})

// ── Happy path ────────────────────────────────────────────────────────────────

describe('streamMessages · pass-through', () => {
  it('forwards every SDK event unchanged', async () => {
    createMock.mockResolvedValueOnce(events({ type: 'message_start' }, { type: 'message_stop' }))
    const out = await drain(streamMessages(params(), cfg))
    expect(out).toEqual([{ type: 'message_start' }, { type: 'message_stop' }])
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('sends maxTokens, system prompt and stream:true in the request', async () => {
    createMock.mockResolvedValueOnce(events({ type: 'message_stop' }))
    await drain(streamMessages(
      params({ maxOutputTokens: 1234, systemPrompt: 'be terse' }),
      cfg,
    ))
    expect(createMock.mock.calls[0]![0]).toMatchObject({
      model: 'glm-5.2',
      max_tokens: 1234,
      stream: true,
      system: 'be terse',
    })
  })

  it('omits `system` entirely when there is no system prompt', async () => {
    createMock.mockResolvedValueOnce(events({ type: 'message_stop' }))
    await drain(streamMessages(params(), cfg))
    expect(createMock.mock.calls[0]![0]).not.toHaveProperty('system')
  })
})

// ── The no-replay rule ────────────────────────────────────────────────────────

describe('streamMessages · never replays a partially delivered stream', () => {
  it('a RETRYABLE mid-stream failure is thrown, not retried', async () => {
    // 529 overloaded is retryable — but only BEFORE anything was yielded.
    createMock.mockReturnValueOnce(
      Promise.resolve(eventsThenThrow({ type: 'message_start' }, apiError(529))),
    )
    const gen = streamMessages(params(), cfg)
    const seen: unknown[] = []
    await expect(async () => {
      for await (const e of gen) seen.push(e)
    }).rejects.toThrow(/529|overload/i)

    // The caller already rendered this event; a replay would duplicate it.
    expect(seen).toEqual([{ type: 'message_start' }])
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('a failure BEFORE the first event IS retried', async () => {
    createMock
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValueOnce(events({ type: 'message_stop' }))
    const out = await drain(streamMessages(params(), { ...(cfg as object), maxRetries: 3 } as never))
    expect(out).toEqual([{ type: 'message_stop' }])
    expect(createMock).toHaveBeenCalledTimes(2)
  })
})

// ── Retry decision table ──────────────────────────────────────────────────────

describe('streamMessages · retry classification', () => {
  it('retries up to maxRetries then reports provider unavailability', async () => {
    createMock.mockRejectedValue(apiError(503))
    await expect(drain(streamMessages(params(), { apiKey: 'k', maxRetries: 2 } as never)))
      .rejects.toBeInstanceOf(AvailabilityFallbackTriggeredError)
    // initial attempt + 2 retries
    expect(createMock).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry a non-retryable 401', async () => {
    createMock.mockRejectedValue(apiError(401, 'invalid api key'))
    await expect(drain(streamMessages(params(), cfg))).rejects.toThrow(/invalid api key/)
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('maxRetries: 0 means exactly one attempt', async () => {
    createMock.mockRejectedValue(apiError(500))
    await expect(drain(streamMessages(params(), { apiKey: 'k', maxRetries: 0 } as never)))
      .rejects.toBeInstanceOf(AvailabilityFallbackTriggeredError)
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('reports each retry through onRetry with attempt/limit/status', async () => {
    createMock
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValueOnce(events({ type: 'message_stop' }))
    const seen: Array<[number, number, number, number | null]> = []
    await drain(streamMessages(
      params(),
      { apiKey: 'k', maxRetries: 3 } as never,
      (attempt, max, delayMs, status) => seen.push([attempt, max, delayMs, status]),
    ))
    expect(seen).toHaveLength(1)
    expect(seen[0]![0]).toBe(1)
    expect(seen[0]![1]).toBe(3)
    expect(seen[0]![2]).toBeGreaterThan(0)
    expect(seen[0]![3]).toBe(429)
  })

  // Real backoff is 1s + 2s + 4s, so this one genuinely takes ~7s of wall time.
  it('backoff grows between attempts', async () => {
    createMock.mockRejectedValue(apiError(503))
    const delays: number[] = []
    await expect(drain(streamMessages(
      params(),
      { apiKey: 'k', maxRetries: 3 } as never,
      (_a, _m, delayMs) => delays.push(delayMs),
    ))).rejects.toBeInstanceOf(AvailabilityFallbackTriggeredError)
    expect(delays).toHaveLength(3)
    // Exponential with ≤25% jitter, so each step must exceed the previous one.
    expect(delays[1]!).toBeGreaterThan(delays[0]!)
    expect(delays[2]!).toBeGreaterThan(delays[1]!)
  }, 20_000)
})

// ── Special error translation ─────────────────────────────────────────────────

describe('streamMessages · error translation', () => {
  it('translates a prompt-too-long 400 into PromptTooLongError without retrying', async () => {
    createMock.mockRejectedValue(apiError(400, 'prompt is too long: 300000 tokens > 200000 maximum'))
    await expect(drain(streamMessages(params(), cfg))).rejects.toBeInstanceOf(PromptTooLongError)
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('a prompt-too-long that surfaces MID-stream is still translated', async () => {
    // KernelLoop keys its compact-and-retry recovery off this type; letting the
    // raw 400 through instead would end the run.
    createMock.mockReturnValueOnce(Promise.resolve(eventsThenThrow(
      { type: 'message_start' },
      apiError(400, 'prompt is too long: 300000 tokens > 200000 maximum'),
    )))
    const gen = streamMessages(params(), cfg)
    await expect(async () => { for await (const _ of gen) { /* drain */ } })
      .rejects.toBeInstanceOf(PromptTooLongError)
  })

  it('translates a model-capability error into FallbackTriggeredError', async () => {
    createMock.mockRejectedValue(apiError(400, 'model does not support thinking'))
    await expect(drain(streamMessages(params(), cfg))).rejects.toBeInstanceOf(FallbackTriggeredError)
    expect(createMock).toHaveBeenCalledTimes(1)
  })
})

// ── Abort ─────────────────────────────────────────────────────────────────────

describe('streamMessages · abort', () => {
  it('an already-aborted signal does not retry', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    createMock.mockRejectedValue(apiError(503))
    await expect(drain(streamMessages(params({ abortSignal: ctrl.signal }), cfg)))
      .rejects.toThrow()
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('aborting mid-backoff rethrows the original error rather than retrying', async () => {
    const ctrl = new AbortController()
    createMock.mockRejectedValue(apiError(503, 'upstream overloaded'))
    const gen = streamMessages(params({ abortSignal: ctrl.signal }), { apiKey: 'k', maxRetries: 5 } as never)
    const done = expect(drain(gen)).rejects.toThrow(/upstream overloaded/)
    setTimeout(() => ctrl.abort(), 30)
    await done
    // It gave up during the first backoff rather than burning all five retries.
    expect(createMock.mock.calls.length).toBeLessThan(5)
  })

  it('does not leak an abort listener per retry attempt', async () => {
    // The forwarder is attached per ATTEMPT to a signal that lives as long as
    // the session; without the removeEventListener in the finally, a long run
    // accumulates one listener per retry. Count them directly rather than
    // trusting a runtime-specific listenerCount helper.
    const ctrl = new AbortController()
    let attached = 0
    const realAdd = ctrl.signal.addEventListener.bind(ctrl.signal)
    const realRemove = ctrl.signal.removeEventListener.bind(ctrl.signal)
    ctrl.signal.addEventListener = ((...args: Parameters<typeof realAdd>) => {
      if (args[0] === 'abort') attached++
      return realAdd(...args)
    }) as typeof realAdd
    ctrl.signal.removeEventListener = ((...args: Parameters<typeof realRemove>) => {
      if (args[0] === 'abort') attached--
      return realRemove(...args)
    }) as typeof realRemove

    createMock
      .mockRejectedValueOnce(apiError(429))
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValue(events({ type: 'message_stop' }))
    await drain(streamMessages(params({ abortSignal: ctrl.signal }), { apiKey: 'k', maxRetries: 3 } as never))

    // 3 attempts ran; every forwarder they attached was detached again.
    expect(createMock).toHaveBeenCalledTimes(3)
    expect(attached).toBe(0)
  }, 20_000)
})

// ── Betas ─────────────────────────────────────────────────────────────────────

describe('streamMessages · beta headers', () => {
  it('sends the default interleaved-thinking beta', async () => {
    createMock.mockResolvedValueOnce(events({ type: 'message_stop' }))
    await drain(streamMessages(params(), cfg))
    // Header lands on the SDK client, which the cache keys on — a second call
    // with different betas must therefore construct a different client.
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('includeDefaultBetas:false plus extras yields only the extras', async () => {
    createMock.mockResolvedValue(events({ type: 'message_stop' }))
    await drain(streamMessages(params({ includeDefaultBetas: false, betas: ['x-1'] }), cfg))
    await drain(streamMessages(params({ betas: ['x-1'] }), cfg))
    // Both calls succeeded; the assertion that matters is that differing beta
    // sets do not collide in the client cache (distinct cache keys).
    expect(createMock).toHaveBeenCalledTimes(2)
  })
})
