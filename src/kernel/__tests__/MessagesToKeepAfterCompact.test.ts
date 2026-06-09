/**
 * Tests for buildMessagesToKeepAfterCompact — the bounded current-turn tail
 * preserved verbatim across a compaction.
 */
import { describe, it, expect } from 'vitest'
import { buildMessagesToKeepAfterCompact } from '../loop/KernelLoop.js'
import { normalizeMessagesForAPI } from '../messages/MessageNormalizer.js'
import type { KernelMessage } from '../types/KernelMessage.js'
import type { KernelTool } from '../types/KernelTool.js'

const NO_TOOLS: KernelTool[] = []

function user(text: string): KernelMessage {
  return { uuid: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }] }
}
function toolResult(id: string, text: string): KernelMessage {
  return {
    uuid: crypto.randomUUID(),
    role: 'user',
    sourceToolAssistantUUID: 'a',
    content: [{ type: 'tool_result', tool_use_id: id, content: text }],
  }
}
function assistantCall(id: string, text = 'doing'): KernelMessage {
  return {
    uuid: crypto.randomUUID(),
    role: 'assistant',
    content: [{ type: 'text', text }, { type: 'tool_use', id, name: 'bash', input: { cmd: 'x' } }],
  }
}

describe('buildMessagesToKeepAfterCompact', () => {
  it('keeps the real user text plus complete tail pairs', () => {
    const msgs: KernelMessage[] = [
      user('older task'),                       // not the last real user msg
      assistantCall('t0'), toolResult('t0', 'old'),
      user('analyze V10-c'),                    // last real user msg → tail starts after
      assistantCall('t1'), toolResult('t1', 'obs dist'),
      assistantCall('t2'), toolResult('t2', 'grad table'),
    ]
    const kept = buildMessagesToKeepAfterCompact(msgs, NO_TOOLS)
    // user text + (a1 + r1) + (a2 + r2) = 5 messages
    expect(kept.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect(kept[0]!.content[0]).toMatchObject({ type: 'text', text: 'analyze V10-c' })
    // older task / its tool cycle must NOT be in the kept tail
    const flat = JSON.stringify(kept)
    expect(flat).not.toContain('older task')
    expect(flat).not.toContain('"old"')
  })

  it('drops a dangling assistant tool_use with no matching tool_result', () => {
    const msgs: KernelMessage[] = [
      user('task'),
      assistantCall('t1'), toolResult('t1', 'r1'),
      assistantCall('t2'), // dangling — no tool_result for t2
    ]
    const kept = buildMessagesToKeepAfterCompact(msgs, NO_TOOLS)
    expect(kept.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(JSON.stringify(kept)).not.toContain('t2')
  })

  it('honours the token budget, always keeping at least the newest unit', () => {
    const big = 'x'.repeat(4000) // ~1000 tokens per result
    const msgs: KernelMessage[] = [
      user('task'),
      assistantCall('t1'), toolResult('t1', big),
      assistantCall('t2'), toolResult('t2', big),
      assistantCall('t3'), toolResult('t3', big),
    ]
    // Budget that fits ~1 unit only
    const kept = buildMessagesToKeepAfterCompact(msgs, NO_TOOLS, 1200)
    // user text + exactly the newest unit (a3 + r3)
    expect(kept.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(JSON.stringify(kept)).toContain('t3')
    expect(JSON.stringify(kept)).not.toContain('t1')
  })

  it('produces a valid role-alternating API sequence', () => {
    const msgs: KernelMessage[] = [
      user('task'),
      assistantCall('t1'), toolResult('t1', 'r1'),
    ]
    const kept = buildMessagesToKeepAfterCompact(msgs, NO_TOOLS)
    // Simulate post-compact placement: summary(user) then kept
    const wire = normalizeMessagesForAPI([
      { uuid: 's', role: 'user', content: [{ type: 'text', text: 'SUMMARY' }], isCompactSummary: true },
      ...kept,
    ])
    // After merge: user(summary+task), assistant, user(tool_result)
    expect(wire.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('returns only user text when there is no tail', () => {
    const msgs: KernelMessage[] = [user('just a question')]
    const kept = buildMessagesToKeepAfterCompact(msgs, NO_TOOLS)
    expect(kept).toHaveLength(1)
    expect(kept[0]!.role).toBe('user')
  })
})
