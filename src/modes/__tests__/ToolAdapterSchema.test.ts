import { describe, expect, it } from 'vitest'
import { resolveToolAbortSupport, toKernelTool } from '../toolAdapter.js'
import type { MetaAgentTool } from '../../core/types.js'

function makeTool(inputSchema: Record<string, unknown>): MetaAgentTool {
  return {
    name: 'noop',
    description: 'noop',
    inputSchema,
    async call() { return { content: 'ok', isError: false } },
  }
}

describe('toolAdapter schema validator — extended constraints (M3)', () => {
  it('declares built-in abort contracts and leaves unknown tools undeclared', () => {
    expect(resolveToolAbortSupport({ name: 'bash' })).toBe('cooperative')
    expect(resolveToolAbortSupport({ name: 'read_file' })).toBe('bounded')
    expect(resolveToolAbortSupport({ name: 'mcp_call' })).toBe('non_cooperative')
    expect(resolveToolAbortSupport({ name: 'third_party_unknown' })).toBeUndefined()
  })
  it('enforces minLength / maxLength on strings', () => {
    const tool = toKernelTool(makeTool({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 3, maxLength: 5 },
      },
      required: ['name'],
    }))
    expect(tool.inputSchema.safeParse({ name: 'ab' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ name: 'abcdef' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ name: 'abcd' }).success).toBe(true)
  })

  it('enforces pattern on strings', () => {
    const tool = toKernelTool(makeTool({
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[a-z]+$' },
      },
      required: ['id'],
    }))
    expect(tool.inputSchema.safeParse({ id: 'abc' }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ id: 'abc1' }).success).toBe(false)
  })

  it('enforces minimum / maximum on numbers', () => {
    const tool = toKernelTool(makeTool({
      type: 'object',
      properties: {
        n: { type: 'number', minimum: 1, maximum: 10 },
      },
      required: ['n'],
    }))
    expect(tool.inputSchema.safeParse({ n: 0 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ n: 11 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ n: 5 }).success).toBe(true)
  })

  it('enforces minItems / maxItems / uniqueItems on arrays', () => {
    const tool = toKernelTool(makeTool({
      type: 'object',
      properties: {
        xs: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3, uniqueItems: true },
      },
      required: ['xs'],
    }))
    expect(tool.inputSchema.safeParse({ xs: ['a'] }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ xs: ['a', 'b', 'c', 'd'] }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ xs: ['a', 'a'] }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ xs: ['a', 'b'] }).success).toBe(true)
  })
})
