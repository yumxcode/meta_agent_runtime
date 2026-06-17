import { describe, it, expect } from 'vitest'
import { structuralTruncate } from '../StructuralTruncate.js'
import type { KernelMessage } from '../../types/KernelMessage.js'

const MODEL = 'claude-sonnet-4-6'

function userText(uuid: string, text: string): KernelMessage {
  return { uuid, role: 'user', content: [{ type: 'text', text }] }
}
function assistantToolUse(uuid: string, id: string): KernelMessage {
  return { uuid, role: 'assistant', content: [{ type: 'tool_use', id, name: 'bash', input: { command: 'ls' } }] }
}
function toolResult(uuid: string, id: string, text: string): KernelMessage {
  return { uuid, role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }
}

describe('structuralTruncate', () => {
  // Build a long history: many older turns with huge tool_result blobs + a recent tail.
  function bigHistory(): KernelMessage[] {
    const blob = 'X'.repeat(50_000)
    const msgs: KernelMessage[] = [userText('goal', 'Build the feature')]
    for (let i = 0; i < 20; i++) {
      msgs.push(assistantToolUse(`a${i}`, `t${i}`))
      msgs.push(toolResult(`r${i}`, `t${i}`, blob))
    }
    return msgs
  }

  it('preserves message count, order, and roles (valid sequence, no dropped pairs)', () => {
    const input = bigHistory()
    const { postCompactMessages } = structuralTruncate(input, MODEL, 20_000)
    expect(postCompactMessages.length).toBe(input.length)
    expect(postCompactMessages.map((m) => m.role)).toEqual(input.map((m) => m.role))
    expect(postCompactMessages.map((m) => m.uuid)).toEqual(input.map((m) => m.uuid))
  })

  it('clips oversized blocks in the OLDER portion', () => {
    const input = bigHistory()
    const { postCompactMessages } = structuralTruncate(input, MODEL, 20_000)
    // The first tool_result (oldest) blob should be clipped well below 50k chars.
    const firstResult = postCompactMessages.find((m) =>
      m.content.some((b) => b.type === 'tool_result'),
    )!
    const block = firstResult.content.find((b) => b.type === 'tool_result') as { content: string }
    expect(block.content.length).toBeLessThan(50_000)
  })

  it('keeps the most recent messages verbatim', () => {
    const input = bigHistory()
    const { postCompactMessages } = structuralTruncate(input, MODEL, 20_000)
    const last = postCompactMessages[postCompactMessages.length - 1]!
    const origLast = input[input.length - 1]!
    expect(JSON.stringify(last)).toBe(JSON.stringify(origLast))
  })

  it('reduces the estimated token count', () => {
    const input = bigHistory()
    const { summaryTokenEstimate } = structuralTruncate(input, MODEL, 20_000)
    // 20 blobs of 50k chars ≈ hundreds of thousands of tokens before; after clipping
    // the older portion this must be far smaller.
    expect(summaryTokenEstimate).toBeLessThan(100_000)
  })

  it('is a no-op-ish pass for a tiny history (nothing to clip)', () => {
    const input = [userText('g', 'hi'), assistantToolUse('a', 't'), toolResult('r', 't', 'ok')]
    const { postCompactMessages } = structuralTruncate(input, MODEL, 20_000)
    expect(postCompactMessages.length).toBe(3)
  })
})
