/**
 * ToolOrchestration unit tests
 *
 * Covers:
 *  - partitionToolCalls: concurrency-safe batching, serial batching, mixed, unknown tools
 *  - buildMissingToolResultMessages: generates error results for tool_use blocks
 */
import { describe, it, expect, vi } from 'vitest'
import {
  partitionToolCalls,
  buildMissingToolResultMessages,
  runTools,
} from '../tools/ToolOrchestration.js'
import type { KernelTool, KernelToolContext } from '../types/KernelTool.js'
import type { ToolCallRequest } from '../tools/ToolExecution.js'
import type { KernelMessage } from '../types/KernelMessage.js'
import { FileStateCache } from '../session/FileStateCache.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTool(name: string, safe: boolean): KernelTool {
  return {
    name,
    description: name,
    inputSchema: {
      safeParse: (input: unknown) => ({ success: true, data: input }),
    },
    inputJSONSchema: { type: 'object' as const },
    call: async () => ({ data: `result:${name}` }),
    isConcurrencySafe: () => safe,
  }
}

function makeToolSafeparseFailure(name: string): KernelTool {
  return {
    name,
    description: name,
    inputSchema: {
      safeParse: () => ({ success: false, error: 'bad input' }),
    },
    inputJSONSchema: { type: 'object' as const },
    call: async () => ({ data: 'should not reach' }),
    isConcurrencySafe: () => true,
  }
}

function makeToolConcurrencyThrows(name: string): KernelTool {
  return {
    name,
    description: name,
    inputSchema: {
      safeParse: (input: unknown) => ({ success: true, data: input }),
    },
    inputJSONSchema: { type: 'object' as const },
    call: async () => ({ data: 'result' }),
    isConcurrencySafe: () => { throw new Error('unexpected') },
  }
}

function makeRequest(toolName: string, idx = 0): ToolCallRequest {
  return {
    toolUseId: `id-${toolName}-${idx}`,
    toolName,
    input: {},
    assistantMessageUuid: 'assistant-uuid',
  }
}

// ── partitionToolCalls ────────────────────────────────────────────────────────

describe('partitionToolCalls', () => {
  it('groups consecutive safe tools into one batch', () => {
    const tools = [makeTool('a', true), makeTool('b', true), makeTool('c', true)]
    const requests = [makeRequest('a'), makeRequest('b'), makeRequest('c')]
    const batches = partitionToolCalls(requests, tools)

    expect(batches).toHaveLength(1)
    expect(batches[0]!.isConcurrencySafe).toBe(true)
    expect(batches[0]!.requests).toHaveLength(3)
  })

  it('puts each non-safe tool in its own batch', () => {
    const tools = [makeTool('a', false), makeTool('b', false)]
    const requests = [makeRequest('a'), makeRequest('b')]
    const batches = partitionToolCalls(requests, tools)

    expect(batches).toHaveLength(2)
    expect(batches[0]!.isConcurrencySafe).toBe(false)
    expect(batches[1]!.isConcurrencySafe).toBe(false)
  })

  it('splits at non-safe boundary in mixed sequence', () => {
    // [safe, safe, NOT-safe, safe, safe]
    const tools = [
      makeTool('s1', true),
      makeTool('s2', true),
      makeTool('ns', false),
      makeTool('s3', true),
      makeTool('s4', true),
    ]
    const requests = [
      makeRequest('s1'),
      makeRequest('s2'),
      makeRequest('ns'),
      makeRequest('s3'),
      makeRequest('s4'),
    ]
    const batches = partitionToolCalls(requests, tools)

    expect(batches).toHaveLength(3)
    expect(batches[0]).toMatchObject({ isConcurrencySafe: true,  requests: expect.arrayContaining([expect.objectContaining({ toolName: 's1' })]) })
    expect(batches[1]).toMatchObject({ isConcurrencySafe: false, requests: [expect.objectContaining({ toolName: 'ns' })] })
    expect(batches[2]).toMatchObject({ isConcurrencySafe: true,  requests: expect.arrayContaining([expect.objectContaining({ toolName: 's3' })]) })
  })

  it('treats tool with safeParse failure as non-safe', () => {
    const tools = [makeToolSafeparseFailure('bad')]
    const batches = partitionToolCalls([makeRequest('bad')], tools)
    expect(batches[0]!.isConcurrencySafe).toBe(false)
  })

  it('treats tool where isConcurrencySafe throws as non-safe', () => {
    const tools = [makeToolConcurrencyThrows('throws')]
    const batches = partitionToolCalls([makeRequest('throws')], tools)
    expect(batches[0]!.isConcurrencySafe).toBe(false)
  })

  it('treats unknown tool (not in tools array) as non-safe', () => {
    const tools: KernelTool[] = []
    const batches = partitionToolCalls([makeRequest('ghost')], tools)
    expect(batches[0]!.isConcurrencySafe).toBe(false)
  })

  it('returns empty array for empty requests', () => {
    expect(partitionToolCalls([], [])).toHaveLength(0)
  })

  it('handles alternating safe/non-safe: each becomes own batch', () => {
    const tools = [makeTool('a', true), makeTool('b', false), makeTool('c', true)]
    const requests = [makeRequest('a'), makeRequest('b'), makeRequest('c')]
    const batches = partitionToolCalls(requests, tools)
    expect(batches).toHaveLength(3)
    expect(batches.map(b => b.isConcurrencySafe)).toEqual([true, false, true])
  })
})

// ── buildMissingToolResultMessages ────────────────────────────────────────────

describe('buildMissingToolResultMessages', () => {
  function makeAssistantMsg(toolIds: string[]): KernelMessage {
    return {
      uuid: 'msg-uuid',
      role: 'assistant',
      content: toolIds.map(id => ({
        type: 'tool_use' as const,
        id,
        name: 'some_tool',
        input: {},
      })),
    }
  }

  it('generates one error result per tool_use block', () => {
    const msgs = [makeAssistantMsg(['t1', 't2'])]
    const results = buildMissingToolResultMessages(msgs, 'Interrupted')
    expect(results).toHaveLength(2)
    expect(results.every(m => m.role === 'user')).toBe(true)
  })

  it('marks results as errors', () => {
    const msgs = [makeAssistantMsg(['t1'])]
    const results = buildMissingToolResultMessages(msgs, 'Oops')
    const block = (results[0]!.content as Array<{ type: string; is_error?: boolean }>)[0]
    expect(block!.is_error).toBe(true)
  })

  it('ignores non-tool_use content blocks', () => {
    const msg: KernelMessage = {
      uuid: 'uuid',
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 'tid', name: 'tool', input: {} },
      ],
    }
    const results = buildMissingToolResultMessages([msg], 'err')
    expect(results).toHaveLength(1)
  })

  it('returns empty array for messages with no tool_use blocks', () => {
    const msg: KernelMessage = {
      uuid: 'uuid',
      role: 'assistant',
      content: [{ type: 'text', text: 'just text' }],
    }
    expect(buildMissingToolResultMessages([msg], 'err')).toHaveLength(0)
  })

  it('handles multiple assistant messages', () => {
    const msgs = [
      makeAssistantMsg(['t1']),
      makeAssistantMsg(['t2', 't3']),
    ]
    expect(buildMissingToolResultMessages(msgs, 'err')).toHaveLength(3)
  })
})

// ── runTools — allow-all permission, returns ordered results ──────────────────

describe('runTools (integration)', () => {
  const allowAll = async () => ({ behavior: 'allow' as const })

  function makeContext(): KernelToolContext {
    return {
      sessionId: 'test-session',
      abortSignal: new AbortController().signal,
      readFileState: new FileStateCache(),
      messages: [],
    }
  }

  it('returns results in original request order even for parallel tools', async () => {
    let callOrder: string[] = []
    const tools: KernelTool[] = [
      {
        name: 'slow',
        description: 'slow',
        inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
        inputJSONSchema: { type: 'object' as const },
        isConcurrencySafe: () => true,
        call: async () => {
          await new Promise(r => setTimeout(r, 20))
          callOrder.push('slow')
          return { data: 'slow-result' }
        },
      },
      {
        name: 'fast',
        description: 'fast',
        inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
        inputJSONSchema: { type: 'object' as const },
        isConcurrencySafe: () => true,
        call: async () => {
          callOrder.push('fast')
          return { data: 'fast-result' }
        },
      },
    ]

    const requests: ToolCallRequest[] = [
      { toolUseId: 'id-slow', toolName: 'slow', input: {}, assistantMessageUuid: 'a' },
      { toolUseId: 'id-fast', toolName: 'fast', input: {}, assistantMessageUuid: 'a' },
    ]

    const result = await runTools(requests, tools, makeContext(), allowAll)
    // Results should be in request order (slow first), not execution-finish order
    const msgs = result.toolResultMessages
    expect(msgs).toHaveLength(2)
    const firstContent = msgs[0]!.content as Array<{ tool_use_id: string }>
    expect(firstContent[0]!.tool_use_id).toBe('id-slow')
  })

  it('returns empty result sets for empty requests', async () => {
    const result = await runTools([], [], makeContext(), allowAll)
    expect(result.toolResultMessages).toHaveLength(0)
    expect(result.extraMessages).toHaveLength(0)
    expect(result.permissionDenials).toHaveLength(0)
  })

  it('records permission denial when tool is denied', async () => {
    const tools: KernelTool[] = [makeTool('guarded', false)]
    const request: ToolCallRequest = {
      toolUseId: 'id-g',
      toolName: 'guarded',
      input: {},
      assistantMessageUuid: 'a',
    }
    const denyAll = async () => ({ behavior: 'deny' as const, reason: 'nope' })
    const result = await runTools([request], tools, makeContext(), denyAll)
    expect(result.permissionDenials).toHaveLength(1)
    expect(result.permissionDenials[0]!.toolName).toBe('guarded')
  })

  it('does not execute a tool when input validation fails', async () => {
    const call = vi.fn()
    const tools: KernelTool[] = [{
      name: 'strict',
      description: 'strict',
      inputSchema: { safeParse: () => ({ success: false, error: 'bad input' }) },
      inputJSONSchema: { type: 'object' as const },
      isConcurrencySafe: () => false,
      call,
    }]
    const request: ToolCallRequest = {
      toolUseId: 'id-strict',
      toolName: 'strict',
      input: {},
      assistantMessageUuid: 'a',
    }

    const result = await runTools([request], tools, makeContext(), allowAll)
    expect(call).not.toHaveBeenCalled()
    const content = result.toolResultMessages[0]!.content[0] as { content: string; is_error?: boolean }
    expect(content.is_error).toBe(true)
    expect(content.content).toContain('Invalid tool input')
  })

  it('truncates oversized tool results before returning tool_result messages', async () => {
    const tools: KernelTool[] = [{
      name: 'loud',
      description: 'loud',
      inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
      inputJSONSchema: { type: 'object' as const },
      maxResultSizeChars: 10,
      isConcurrencySafe: () => false,
      call: async () => ({ data: 'x'.repeat(100) }),
    }]
    const request: ToolCallRequest = {
      toolUseId: 'id-loud',
      toolName: 'loud',
      input: {},
      assistantMessageUuid: 'a',
    }

    const result = await runTools([request], tools, makeContext(), allowAll)
    const content = result.toolResultMessages[0]!.content[0] as { content: string }
    expect(content.content).toMatch(/^x{10}\n\n\[Content truncated/)
    expect(content.content).toContain('Content truncated')
  })
})
