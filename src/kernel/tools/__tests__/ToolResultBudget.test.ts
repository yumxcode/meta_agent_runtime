import { describe, expect, it } from 'vitest'
import { applyToolResultBudget } from '../ToolResultBudget.js'
import type { KernelMessage } from '../../types/KernelMessage.js'
import type { KernelTool } from '../../types/KernelTool.js'

const tool = (name: string, maxResultSizeChars?: number): KernelTool => ({
  name,
  description: 'x',
  inputJSONSchema: { type: 'object' },
  ...(maxResultSizeChars !== undefined && { maxResultSizeChars }),
  // handler is unused by applyToolResultBudget
  handler: (async () => ({ content: '' })) as unknown as KernelTool['handler'],
})

function assistantWithToolUse(id: string, name: string): KernelMessage {
  return {
    uuid: `a-${id}`,
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: {} }],
  } as KernelMessage
}

function userToolResult(id: string, content: string): KernelMessage {
  return {
    uuid: `u-${id}`,
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }],
  } as KernelMessage
}

describe('applyToolResultBudget', () => {
  const tools = [tool('big', 10)]

  it('truncates oversized tool results', () => {
    const msgs = [
      assistantWithToolUse('t1', 'big'),
      userToolResult('t1', 'x'.repeat(50)),
    ]
    const out = applyToolResultBudget(msgs, tools)
    const block = (out[1]!.content[0] as { content: string })
    expect(block.content.startsWith('xxxxxxxxxx')).toBe(true)
    expect(block.content).toMatch(/Content truncated/)
  })

  it('returns the SAME array reference when nothing needs truncation', () => {
    const msgs = [
      assistantWithToolUse('t1', 'big'),
      userToolResult('t1', 'short'),
    ]
    const out = applyToolResultBudget(msgs, tools)
    expect(out).toBe(msgs)   // no allocation
  })

  it('returns the SAME array reference when no tool has a limit', () => {
    const msgs = [
      assistantWithToolUse('t1', 'nolimit'),
      userToolResult('t1', 'x'.repeat(999)),
    ]
    const out = applyToolResultBudget(msgs, [tool('nolimit')])
    expect(out).toBe(msgs)
  })

  it('is idempotent and reference-stable on a second pass (no re-truncation churn)', () => {
    const msgs = [
      assistantWithToolUse('t1', 'big'),
      userToolResult('t1', 'x'.repeat(50)),
    ]
    const once = applyToolResultBudget(msgs, tools)
    const truncated = (once[1]!.content[0] as { content: string }).content

    const twice = applyToolResultBudget(once, tools)
    // Already-truncated content must not be touched again — same array AND
    // same message object references (proves no realloc on the steady-state path).
    expect(twice).toBe(once)
    expect(twice[1]).toBe(once[1])
    expect((twice[1]!.content[0] as { content: string }).content).toBe(truncated)
  })

  it('only reallocates the changed tail, sharing unchanged prefix references', () => {
    const prefixAssistant = assistantWithToolUse('p1', 'big')
    const prefixResult = userToolResult('p1', 'short')     // unchanged
    const tailAssistant = assistantWithToolUse('t2', 'big')
    const tailResult = userToolResult('t2', 'y'.repeat(40)) // truncated
    const msgs = [prefixAssistant, prefixResult, tailAssistant, tailResult]

    const out = applyToolResultBudget(msgs, tools)
    expect(out).not.toBe(msgs)            // a change happened → new outer array
    expect(out[0]).toBe(prefixAssistant)  // unchanged refs preserved
    expect(out[1]).toBe(prefixResult)
    expect(out[2]).toBe(tailAssistant)
    expect(out[3]).not.toBe(tailResult)   // only the changed message is new
  })
})
