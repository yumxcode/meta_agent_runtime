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

// ── Images ───────────────────────────────────────────────────────────────────

const PNG_BLOCK = {
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' },
}

describe('normalizeMessagesForDeepSeek — images', () => {
  it('emits a plain string when a user message has no image', () => {
    // The array form is observable only when it is needed: every text-only
    // request stays byte-identical to what it was before images existed.
    const out = normalizeMessagesForDeepSeek(
      [makeUserMessage([{ type: 'text', text: 'hello' }])],
    )
    expect(out).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('converts a user image into an OpenAI image_url part with a data URL', () => {
    const out = normalizeMessagesForDeepSeek([
      makeUserMessage([{ type: 'text', text: 'what is this?' }, PNG_BLOCK]),
    ])
    expect(out).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }])
  })

  it('passes a URL-sourced image through without inlining it', () => {
    const out = normalizeMessagesForDeepSeek([
      makeUserMessage([{ type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } }]),
    ])
    expect(out).toEqual([{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }],
    }])
  })

  it('downgrades an image on an assistant message, which DeepSeek rejects with 400', () => {
    const out = normalizeMessagesForDeepSeek([
      makeUserMessage([{ type: 'text', text: 'go' }]),
      makeAssistantMessage([{ type: 'text', text: 'here: ' }, PNG_BLOCK]),
    ])
    expect(out[1]).toEqual({ role: 'assistant', content: 'here: [image omitted]' })
  })

  it('lifts a tool_result image into a trailing user message, keeping tool replies contiguous', () => {
    // Three constraints at once: a `tool` message's content is a string, images
    // are legal only on `user` messages, and the run of tool replies must follow
    // its assistant's tool_calls without interruption. Deferring satisfies all
    // three; the tool_call_id in the caption preserves attribution.
    const out = normalizeMessagesForDeepSeek([
      makeUserMessage([{ type: 'text', text: 'screenshot it' }]),
      makeAssistantMessage([{ type: 'tool_use', id: 'call_1', name: 'shot', input: {} }]),
      makeUserMessage([
        { type: 'tool_result', tool_use_id: 'call_1', content: [
          { type: 'text', text: 'captured' }, PNG_BLOCK,
        ] } as never,
      ]),
    ])

    const roles = out.map(m => m.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'captured' })
    expect(out[3]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Image returned by tool call call_1:' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    })
  })

  it('keeps every tool reply adjacent when two tool calls both return images', () => {
    const out = normalizeMessagesForDeepSeek([
      makeUserMessage([{ type: 'text', text: 'both' }]),
      makeAssistantMessage([
        { type: 'tool_use', id: 'a', name: 'shot', input: {} },
        { type: 'tool_use', id: 'b', name: 'shot', input: {} },
      ]),
      makeUserMessage([
        { type: 'tool_result', tool_use_id: 'a', content: [PNG_BLOCK] } as never,
        { type: 'tool_result', tool_use_id: 'b', content: [PNG_BLOCK] } as never,
      ]),
    ])
    // No user message may separate the two tool replies.
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
  })

  it('gives a tool message a placeholder when its only payload was an image', () => {
    const out = normalizeMessagesForDeepSeek([
      makeUserMessage([{ type: 'text', text: 'go' }]),
      makeAssistantMessage([{ type: 'tool_use', id: 'call_1', name: 'shot', input: {} }]),
      makeUserMessage([
        { type: 'tool_result', tool_use_id: 'call_1', content: [PNG_BLOCK] } as never,
      ]),
    ])
    // Empty content on a tool message reads as "the tool returned nothing".
    expect(out[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '[image returned; see the following user message]',
    })
  })
})
