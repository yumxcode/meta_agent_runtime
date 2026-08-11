/**
 * streamDeepSeekMessages — request shaping, retry, and the no-replay rule.
 *
 * DeepSeekStream.test.ts covers the chunk decoder; this covers the loop around
 * it, which is the other half of the 6% the module started at. Same contract as
 * AnthropicClient (the two were written to mirror each other), so the same
 * failure modes apply: a mid-stream retry would replay already-rendered output
 * and double-count usage, and a leaked abort forwarder accumulates for the life
 * of a long session.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const createMock = vi.fn()

vi.mock('openai', () => {
  class FakeOpenAI {
    chat = { completions: { create: createMock } }
    constructor(public opts: unknown) {}
  }
  return { default: FakeOpenAI }
})

vi.mock('../StreamWatchdog.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../StreamWatchdog.js')>()),
  withStreamWatchdog: <T>(stream: T) => stream,
}))

const { streamDeepSeekMessages, clearDeepSeekClientCache, clearDeepSeekToolsCache } =
  await import('../DeepSeekClient.js')
const { PromptTooLongError, AvailabilityFallbackTriggeredError } = await import('../Errors.js')

function params(overrides: Record<string, unknown> = {}): never {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    sessionId: 'ds-test',
    abortSignal: new AbortController().signal,
    ...overrides,
  } as never
}

async function* chunks(...items: unknown[]): AsyncGenerator<unknown> {
  for (const i of items) yield i
}

async function* chunkThenThrow(first: unknown, error: unknown): AsyncGenerator<unknown> {
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

const text = { choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }
const cfg = { apiKey: 'test-key', maxRetries: 3 } as never

beforeEach(() => {
  createMock.mockReset()
  clearDeepSeekClientCache()
  clearDeepSeekToolsCache()
})

describe('request shaping', () => {
  it('always asks for usage — without it every turn would cost $0.00', async () => {
    createMock.mockResolvedValueOnce(chunks(text))
    await drain(streamDeepSeekMessages(params(), cfg))
    expect(createMock.mock.calls[0]![0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      model: 'deepseek-chat',
    })
  })

  it('omits `tools` entirely when the session has none', async () => {
    createMock.mockResolvedValueOnce(chunks(text))
    await drain(streamDeepSeekMessages(params(), cfg))
    expect(createMock.mock.calls[0]![0]).not.toHaveProperty('tools')
  })

  it('disables thinking when no thinkingConfig is supplied', async () => {
    createMock.mockResolvedValueOnce(chunks(text))
    await drain(streamDeepSeekMessages(params(), cfg))
    const body = createMock.mock.calls[0]![0] as Record<string, unknown>
    expect(body['thinking']).toEqual({ type: 'disabled' })
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('enables thinking and sends reasoning_effort when configured', async () => {
    createMock.mockResolvedValueOnce(chunks(text))
    await drain(streamDeepSeekMessages(params({ thinkingConfig: { type: 'enabled', budget_tokens: 8000 } }), cfg))
    const body = createMock.mock.calls[0]![0] as Record<string, unknown>
    expect(body['thinking']).toEqual({ type: 'enabled' })
    expect(body['reasoning_effort']).toBeDefined()
  })

  it('honours an explicit maxOutputTokens', async () => {
    createMock.mockResolvedValueOnce(chunks(text))
    await drain(streamDeepSeekMessages(params({ maxOutputTokens: 4096 }), cfg))
    expect((createMock.mock.calls[0]![0] as Record<string, unknown>)['max_tokens']).toBe(4096)
  })
})

describe('no-replay rule', () => {
  it('does not retry once an event has reached the caller', async () => {
    createMock.mockReturnValueOnce(Promise.resolve(chunkThenThrow(text, apiError(529))))
    const seen: unknown[] = []
    await expect(async () => {
      for await (const e of streamDeepSeekMessages(params(), cfg)) seen.push(e)
    }).rejects.toThrow()
    // Whatever reached the caller was already rendered; replaying it would
    // duplicate terminal output and double-count the assistant message.
    expect(seen.length).toBeGreaterThan(0)
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('retries a failure that happened before any event', async () => {
    createMock
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValueOnce(chunks(text))
    await drain(streamDeepSeekMessages(params(), cfg))
    expect(createMock).toHaveBeenCalledTimes(2)
  })
})

describe('retry classification', () => {
  it('reports provider unavailability after exhausting retries', async () => {
    createMock.mockRejectedValue(apiError(503))
    await expect(drain(streamDeepSeekMessages(params(), { apiKey: 'k', maxRetries: 2 } as never)))
      .rejects.toBeInstanceOf(AvailabilityFallbackTriggeredError)
    expect(createMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry a 401', async () => {
    createMock.mockRejectedValue(apiError(401, 'bad key'))
    await expect(drain(streamDeepSeekMessages(params(), cfg))).rejects.toThrow(/bad key/)
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('translates prompt-too-long without retrying', async () => {
    createMock.mockRejectedValue(apiError(400, 'prompt is too long: 200000 tokens > 128000 maximum'))
    await expect(drain(streamDeepSeekMessages(params(), cfg))).rejects.toBeInstanceOf(PromptTooLongError)
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('reports retries through onRetry', async () => {
    createMock
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValueOnce(chunks(text))
    const seen: number[] = []
    await drain(streamDeepSeekMessages(params(), { apiKey: 'k', maxRetries: 3 } as never,
      attempt => seen.push(attempt)))
    expect(seen).toEqual([1])
  })

  it('an already-aborted signal does not retry', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    createMock.mockRejectedValue(apiError(503))
    await expect(drain(streamDeepSeekMessages(params({ abortSignal: ctrl.signal }), cfg))).rejects.toThrow()
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('does not leak an abort forwarder per attempt', async () => {
    const ctrl = new AbortController()
    let attached = 0
    const realAdd = ctrl.signal.addEventListener.bind(ctrl.signal)
    const realRemove = ctrl.signal.removeEventListener.bind(ctrl.signal)
    ctrl.signal.addEventListener = ((...a: Parameters<typeof realAdd>) => {
      if (a[0] === 'abort') attached++
      return realAdd(...a)
    }) as typeof realAdd
    ctrl.signal.removeEventListener = ((...a: Parameters<typeof realRemove>) => {
      if (a[0] === 'abort') attached--
      return realRemove(...a)
    }) as typeof realRemove

    createMock
      .mockRejectedValueOnce(apiError(429))
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValue(chunks(text))
    await drain(streamDeepSeekMessages(params({ abortSignal: ctrl.signal }), { apiKey: 'k', maxRetries: 3 } as never))
    expect(createMock).toHaveBeenCalledTimes(3)
    expect(attached).toBe(0)
  }, 20_000)
})

describe('end-to-end through the decoder', () => {
  it('a normal turn yields content then the terminal events', async () => {
    createMock.mockResolvedValueOnce(chunks(
      { choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
    ))
    const types = (await drain(streamDeepSeekMessages(params(), cfg)) as Array<{ type: string }>).map(e => e.type)
    expect(types).toEqual([
      'content_block_start', 'content_block_delta',
      'message_start', 'message_delta', 'message_stop',
    ])
  })

  it('a tool-call turn produces a complete tool_use block', async () => {
    createMock.mockResolvedValueOnce(chunks(
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'bash', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ))
    const events = await drain(streamDeepSeekMessages(params(), cfg)) as Array<Record<string, unknown>>
    const start = events.find(e => e['type'] === 'content_block_start')!
    expect(start['content_block']).toMatchObject({ type: 'tool_use', id: 'c1', name: 'bash' })
    const stop = events.find(e => e['type'] === 'message_delta')!
    expect((stop['delta'] as Record<string, unknown>)['stop_reason']).toBe('tool_use')
  })
})
