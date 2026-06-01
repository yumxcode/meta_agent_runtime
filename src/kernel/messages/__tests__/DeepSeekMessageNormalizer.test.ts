import { describe, it, expect } from 'vitest'
import { makeAssistantMessage, makeUserMessage } from '../../types/KernelMessage.js'
import { normalizeMessagesForDeepSeek } from '../DeepSeekMessageNormalizer.js'

describe('normalizeMessagesForDeepSeek', () => {
  it('drops a thinking-only assistant turn (interrupted mid-thinking)', () => {
    // Ctrl+C during the thinking phase commits an assistant message holding ONLY
    // a thinking block. Emitting it as { content: null, no tool_calls } triggers
    // 400 "content or tool_calls must be set" and poisons every later turn.
    const messages = [
      makeUserMessage([{ type: 'text', text: 'analyze the reward' }]),
      makeAssistantMessage([{ type: 'thinking', thinking: 'pondering...' }]),
      makeUserMessage([{ type: 'text', text: 'analyze the reward' }]),
    ]
    const out = normalizeMessagesForDeepSeek(messages, 'sys')
    // No emitted message may be an assistant with null content and no tool_calls.
    for (const m of out) {
      if (m.role === 'assistant') {
        expect(m.content !== null || (m.tool_calls?.length ?? 0) > 0).toBe(true)
      }
    }
    // The thinking-only turn is skipped entirely.
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'analyze the reward' },
      { role: 'user', content: 'analyze the reward' },
    ])
  })

  it('keeps an assistant turn that has tool_calls even with empty text', () => {
    const messages = [
      makeUserMessage([{ type: 'text', text: 'go' }]),
      makeAssistantMessage([
        { type: 'thinking', thinking: 'plan' },
        { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } },
      ]),
    ]
    const out = normalizeMessagesForDeepSeek(messages)
    const asst = out.find(m => m.role === 'assistant')
    expect(asst).toBeDefined()
    expect(asst).toMatchObject({
      role: 'assistant',
      content: null,
      reasoning_content: 'plan',
      tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'bash' } }],
    })
  })

  it('keeps a normal text assistant turn', () => {
    const messages = [
      makeUserMessage([{ type: 'text', text: 'hi' }]),
      makeAssistantMessage([{ type: 'text', text: 'hello' }]),
    ]
    const out = normalizeMessagesForDeepSeek(messages)
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })
})
