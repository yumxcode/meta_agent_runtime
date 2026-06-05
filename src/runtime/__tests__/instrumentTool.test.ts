import { describe, expect, it } from 'vitest'
import { instrumentTool } from '../instrumentTool.js'
import type { MetaAgentTool } from '../../core/types.js'

describe('instrumentTool', () => {
  it('preserves tool execution metadata', () => {
    const tool: MetaAgentTool = {
      name: 'slow_tool',
      description: 'slow tool',
      inputSchema: { type: 'object', properties: {} },
      timeoutMs: 0,
      maxResultSizeChars: 1234,
      isConcurrencySafe: true,
      permission: { kind: 'none' },
      async call() {
        return { content: 'ok' }
      },
    }

    const wrapped = instrumentTool(tool, {} as never)

    expect(wrapped.timeoutMs).toBe(0)
    expect(wrapped.maxResultSizeChars).toBe(1234)
    expect(wrapped.isConcurrencySafe).toBe(true)
    expect(wrapped.permission).toEqual({ kind: 'none' })
  })
})
