/**
 * H3 regression: the empty-response recovery must drop only ITS OWN assistant
 * messages.
 *
 * The recovery removed `assistantMessages.length` entries from the TAIL of the
 * history, assuming `append(...assistantMessages)` was the last thing to touch
 * it. The post_query phase hook runs in between and may append injected meta
 * messages, so with a hook configured the splice deleted the injections and
 * left part of the empty assistant turn behind — corrupting history in exactly
 * the situation the recovery exists to repair.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { KernelSession } from '../KernelSession.js'
import type { KernelTool } from '../types/KernelTool.js'
import type { StreamEvent } from '../api/AnthropicClient.js'

vi.mock('../api/AnthropicClient.js', () => ({
  streamMessages: vi.fn(),
}))

import { streamMessages } from '../api/AnthropicClient.js'
const mockStream = vi.mocked(streamMessages)

async function* emptyEndTurnStream(): AsyncGenerator<StreamEvent> {
  yield { type: 'message_start', usage: { input_tokens: 10 } }
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } as never }
  yield { type: 'content_block_stop', index: 0 }
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }
  yield { type: 'message_stop' }
}

async function* textStream(text: string): AsyncGenerator<StreamEvent> {
  yield { type: 'message_start', usage: { input_tokens: 10 } }
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } as never }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 0 }
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }
  yield { type: 'message_stop' }
}

const INJECTED = '[policy] keep the deploy freeze in mind'

beforeEach(() => vi.clearAllMocks())

describe('empty-response recovery with a post_query phase hook', () => {
  it('keeps the hook injection and drops only the empty assistant turn', async () => {
    let call = 0
    mockStream.mockImplementation(async function* () {
      call++
      if (call === 1) yield* emptyEndTurnStream()
      else yield* textStream('recovered response')
    })

    // Inject exactly once, on the first post_query, so the second turn's
    // history is easy to assert against.
    let injected = false
    const session = new KernelSession({
      model: 'claude-opus-4-6',
      tools: [] as KernelTool[],
      apiKey: 'test-key',
      maxTurns: 5,
      compact: { enabled: false },
      maxStreamErrorRecoveries: 2,
      phaseHooks: async ({ point }) => {
        if (point !== 'post_query' || injected) return {}
        injected = true
        return { inject: [INJECTED] }
      },
    })

    const events = []
    for await (const e of session.submitMessage('Hello')) events.push(e)

    expect(call).toBe(2)
    expect(events.find(e => e.type === 'result')?.subtype).toBe('success')

    const texts = session.getMessages().flatMap(msg =>
      msg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text),
    )

    // The hook's injection survived the recovery.
    expect(texts).toContain(INJECTED)

    // The empty assistant turn is gone — no assistant message with empty text.
    const emptyAssistantTurns = session.getMessages().filter(msg =>
      msg.role === 'assistant' &&
      msg.content.length > 0 &&
      msg.content.every(b => b.type === 'text' && b.text.trim() === ''),
    )
    expect(emptyAssistantTurns).toHaveLength(0)

    // And the retry's real answer is present.
    expect(texts).toContain('recovered response')
  })
})
