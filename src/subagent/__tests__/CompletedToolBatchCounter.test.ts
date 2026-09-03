import { describe, expect, it } from 'vitest'
import { CompletedToolBatchCounter } from '../CompletedToolBatchCounter.js'

describe('CompletedToolBatchCounter', () => {
  it('counts a parallel tool batch as one completed turn', () => {
    const counter = new CompletedToolBatchCounter()
    counter.observeToolUse('a')
    counter.observeToolUse('b')
    counter.observeToolUse('c')
    expect(counter.observeToolResult('a')).toBeUndefined()
    expect(counter.observeToolResult('c')).toBeUndefined()
    expect(counter.observeToolResult('b')).toBe(1)
    expect(counter.completedBatches).toBe(1)
  })

  it('counts sequential batches independently and ignores duplicate results', () => {
    const counter = new CompletedToolBatchCounter()
    counter.observeToolUse('a')
    expect(counter.observeToolResult('a')).toBe(1)
    expect(counter.observeToolResult('a')).toBeUndefined()
    counter.observeToolUse('b')
    expect(counter.observeToolResult('b')).toBe(2)
  })

  it('recovers at the next batch boundary when a result went missing', () => {
    const counter = new CompletedToolBatchCounter()
    counter.observeToolUse('a')
    counter.observeToolUse('lost')
    expect(counter.observeToolResult('a')).toBeUndefined()

    // All tool_use events precede results within one Kernel batch, so this is
    // unambiguously a new batch rather than another member of the old one.
    expect(counter.observeToolUse('b')).toEqual({
      completedBatches: 1,
      staleToolUseIds: ['lost'],
    })
    expect(counter.observeToolResult('b')).toBe(2)
  })
})
