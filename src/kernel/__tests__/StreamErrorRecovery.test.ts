/**
 * StreamErrorRecovery unit tests
 *
 * Covers the bounded "surface-and-retry" recovery for model-call (stream)
 * errors that are NOT control-flow signals (FallbackTriggeredError) or
 * PromptTooLongError:
 *
 *  - A transient stream error is recovered: the turn retries and succeeds,
 *    emitting a system_message warning instead of aborting.
 *  - A persistent stream error is retried up to maxStreamErrorRecoveries, then
 *    fails as error_during_execution (no infinite loop).
 *  - Recovery can be disabled with maxStreamErrorRecoveries: 0 (fail-fast).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { KernelSession } from '../KernelSession.js'
import type { KernelTool } from '../types/KernelTool.js'

vi.mock('../api/AnthropicClient.js', () => ({
  streamMessages: vi.fn(),
}))

import { streamMessages } from '../api/AnthropicClient.js'
const mockStream = vi.mocked(streamMessages)

async function* textStream(text = 'ok'): AsyncGenerator<import('../api/AnthropicClient.js').StreamEvent> {
  yield { type: 'message_start', usage: { input_tokens: 50 } }
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } as any }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 0 }
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }
  yield { type: 'message_stop' }
}

async function collectEvents(session: KernelSession, prompt: string) {
  const events = []
  for await (const e of session.submitMessage(prompt)) events.push(e)
  return events
}

function makeConfig(overrides?: object) {
  return {
    model: 'claude-opus-4-6',
    tools: [] as KernelTool[],
    apiKey: 'test-key',
    maxTurns: 5,
    compact: { enabled: false },
    // keep backoff from slowing the suite
    maxStreamErrorRecoveries: 2,
    ...overrides,
  }
}

// A provider-style error envelope (mirrors the real "1234 网络错误" shape).
function apiError(): Error {
  return Object.assign(new Error('network error'), {
    error: { type: 'api_error', code: '1234', message: '[1234][网络错误，请稍后重试]' },
  })
}

beforeEach(() => vi.clearAllMocks())

describe('KernelLoop — stream error recovery', () => {
  it('recovers from a transient stream error and completes successfully', async () => {
    let call = 0
    mockStream.mockImplementation(async function* () {
      call++
      if (call === 1) throw apiError()
      yield* textStream('recovered response')
    })

    const session = new KernelSession(makeConfig())
    const events = await collectEvents(session, 'Hello')

    // Two attempts: first failed, second succeeded.
    expect(call).toBe(2)

    // A non-fatal warning was surfaced.
    const warning = events.find(e => e.type === 'system_message')
    expect(warning).toBeTruthy()
    expect((warning as { subtype?: string })?.subtype).toBe('warning')

    // The turn ultimately succeeded.
    const result = events.find(e => e.type === 'result')
    expect(result?.subtype).toBe('success')
  })

  it('gives up after maxStreamErrorRecoveries on a persistent error', async () => {
    let call = 0
    mockStream.mockImplementation(async function* () {
      call++
      throw apiError()
      // eslint-disable-next-line no-unreachable
      yield* textStream()
    })

    const session = new KernelSession(makeConfig({ maxStreamErrorRecoveries: 2 }))
    const events = await collectEvents(session, 'Hello')

    // 1 initial + 2 recovery retries = 3 attempts, then fail-fast.
    expect(call).toBe(3)
    const result = events.find(e => e.type === 'result')
    expect(result?.subtype).toBe('error_during_execution')
  })

  it('fails fast when recovery is disabled (maxStreamErrorRecoveries: 0)', async () => {
    let call = 0
    mockStream.mockImplementation(async function* () {
      call++
      throw apiError()
      // eslint-disable-next-line no-unreachable
      yield* textStream()
    })

    const session = new KernelSession(makeConfig({ maxStreamErrorRecoveries: 0 }))
    const events = await collectEvents(session, 'Hello')

    expect(call).toBe(1)
    const result = events.find(e => e.type === 'result')
    expect(result?.subtype).toBe('error_during_execution')
  })
})
