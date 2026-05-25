/**
 * FallbackAndBetas unit tests
 *
 * Covers:
 *  - isFallbackTriggeredError: detection heuristics
 *  - KernelSession fallback model switch: FallbackTriggeredError → switch model → retry
 *  - Tombstone: second FallbackTriggeredError is not retried
 *  - betas propagation: KernelConfig.betas forwarded to streamMessages
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isFallbackTriggeredError, FallbackTriggeredError } from '../api/Errors.js'
import { KernelSession } from '../KernelSession.js'
import type { KernelTool } from '../types/KernelTool.js'

// ── Mock streamMessages ───────────────────────────────────────────────────────

vi.mock('../api/AnthropicClient.js', () => ({
  streamMessages: vi.fn(),
}))

import { streamMessages } from '../api/AnthropicClient.js'
const mockStream = vi.mocked(streamMessages)

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

// ── isFallbackTriggeredError ──────────────────────────────────────────────────

describe('isFallbackTriggeredError', () => {
  it('returns true for FallbackTriggeredError instance', () => {
    expect(isFallbackTriggeredError(new FallbackTriggeredError())).toBe(true)
  })

  it('returns true for 400 "extended thinking" error', () => {
    expect(isFallbackTriggeredError({ status: 400, message: 'Extended thinking is not supported' })).toBe(true)
  })

  it('returns true for 400 "thinking is not supported" error', () => {
    expect(isFallbackTriggeredError({ status: 400, message: 'thinking is not supported for this model' })).toBe(true)
  })

  it('returns true for 400 "model does not support" error', () => {
    expect(isFallbackTriggeredError({ status: 400, message: 'model does not support this feature' })).toBe(true)
  })

  it('returns true for 404 with "model" in message', () => {
    expect(isFallbackTriggeredError({ status: 404, message: 'model not found' })).toBe(true)
  })

  it('returns false for generic 400 error', () => {
    expect(isFallbackTriggeredError({ status: 400, message: 'invalid request' })).toBe(false)
  })

  it('returns false for 500 error', () => {
    expect(isFallbackTriggeredError({ status: 500, message: 'server error' })).toBe(false)
  })

  it('returns false for null', () => {
    expect(isFallbackTriggeredError(null)).toBe(false)
  })

  it('returns false for plain string', () => {
    expect(isFallbackTriggeredError('some error')).toBe(false)
  })
})

// ── Fallback model switching in KernelSession ─────────────────────────────────

describe('KernelSession — fallback model', () => {
  it('switches to fallbackModel when FallbackTriggeredError is thrown', async () => {
    const modelsUsed: string[] = []

    mockStream.mockImplementation(async function* (params) {
      modelsUsed.push(params.model)
      if (params.model === 'claude-opus-4-6') {
        throw new FallbackTriggeredError('Thinking not supported')
      }
      yield* textStream('fallback response')
    })

    const session = new KernelSession(makeConfig({
      model: 'claude-opus-4-6',
      fallbackModel: 'claude-sonnet-4-6',
    }))

    const events = await collectEvents(session, 'Hello')

    // Primary model was tried first, then fallback
    expect(modelsUsed).toEqual(['claude-opus-4-6', 'claude-sonnet-4-6'])

    // Session should complete successfully with the fallback model
    const result = events.find(e => e.type === 'result')
    expect(result?.subtype).toBe('success')
  })

  it('does not retry fallback if no fallbackModel is configured', async () => {
    let callCount = 0
    mockStream.mockImplementation(async function* () {
      callCount++
      throw new FallbackTriggeredError('Thinking not supported')
    })

    const session = new KernelSession(makeConfig({ model: 'claude-opus-4-6' /* no fallbackModel */ }))
    const events = await collectEvents(session, 'Hello')

    // Only one attempt — error propagates as loop error
    expect(callCount).toBe(1)
    const result = events.find(e => e.type === 'result')
    expect(result?.subtype).toBe('error_during_execution')
  })

  it('tombstone prevents infinite fallback loop', async () => {
    const modelsUsed: string[] = []

    mockStream.mockImplementation(async function* (params) {
      modelsUsed.push(params.model)
      // Both primary and fallback throw FallbackTriggeredError
      throw new FallbackTriggeredError('Not supported')
    })

    const session = new KernelSession(makeConfig({
      model: 'claude-opus-4-6',
      fallbackModel: 'claude-sonnet-4-6',
    }))

    const events = await collectEvents(session, 'Hello')

    // Primary tried, fallback tried once, then tombstone stops further retries
    expect(modelsUsed).toEqual(['claude-opus-4-6', 'claude-sonnet-4-6'])

    const result = events.find(e => e.type === 'result')
    expect(result?.subtype).toBe('error_during_execution')
  })
})

// ── betas propagation ─────────────────────────────────────────────────────────

describe('KernelSession — betas propagation', () => {
  it('passes betas from KernelConfig to streamMessages', async () => {
    const capturedBetas: string[][] = []

    mockStream.mockImplementation(async function* (params) {
      capturedBetas.push(params.betas ?? [])
      yield* textStream()
    })

    const session = new KernelSession(makeConfig({
      betas: ['token-efficient-tools-2025-02-19'],
    }))

    await collectEvents(session, 'Hello')

    expect(capturedBetas[0]).toContain('token-efficient-tools-2025-02-19')
  })

  it('uses empty betas array when none configured', async () => {
    const capturedBetas: (string[] | undefined)[] = []

    mockStream.mockImplementation(async function* (params) {
      capturedBetas.push(params.betas)
      yield* textStream()
    })

    const session = new KernelSession(makeConfig())
    await collectEvents(session, 'Hello')

    // Undefined or empty — no caller betas; AnthropicClient adds default beta header
    expect(capturedBetas[0] === undefined || capturedBetas[0]!.length === 0).toBe(true)
  })
})
