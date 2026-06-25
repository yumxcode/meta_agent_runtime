import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgenticSession } from '../AgenticSession.js'
import { MetaAgentSession } from '../../core/MetaAgentSession.js'
import type { MetaAgentTool } from '../../core/types.js'

const sandboxMock = vi.hoisted(() => {
  const handle = {
    description: 'test-sandbox',
    wrapExec: vi.fn((command: string) => ({ file: 'sandbox', args: [command] })),
    destroy: vi.fn(async () => undefined),
  }
  const create = vi.fn(async () => handle)
  const createSandboxExecutor = vi.fn(() => ({
    platform: 'macos' as const,
    isAvailable: () => true,
    create,
  }))
  return { handle, create, createSandboxExecutor }
})

vi.mock('../../kernel/api/AnthropicClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../kernel/api/AnthropicClient.js')>()),
  streamMessages: vi.fn(),
}))

vi.mock('../../sandbox/index.js', () => ({
  createSandboxExecutor: sandboxMock.createSandboxExecutor,
}))

import { streamMessages } from '../../kernel/api/AnthropicClient.js'
const mockStream = vi.mocked(streamMessages)

async function* textStream(text: string): AsyncGenerator<import('../../kernel/api/AnthropicClient.js').StreamEvent> {
  yield { type: 'message_start', usage: { input_tokens: 100 } }
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } as never }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 0 }
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }
  yield { type: 'message_stop' }
}

async function* toolUseStream(toolId: string, toolName: string, input: unknown): AsyncGenerator<import('../../kernel/api/AnthropicClient.js').StreamEvent> {
  yield { type: 'message_start', usage: { input_tokens: 100 } }
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} } as never }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }
  yield { type: 'content_block_stop', index: 0 }
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }
  yield { type: 'message_stop' }
}

function makeTool(): MetaAgentTool {
  return {
    name: 'calculator',
    description: async ctx => `Calculator. Siblings: ${[...ctx.toolNames].join(',')}`,
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
    call: async input => ({ content: `value=${input['expression']}`, isError: false }),
    isConcurrencySafe: false,
  }
}

function makeSandboxProbeTool(onCall: (hasHandle: boolean) => void): MetaAgentTool {
  return {
    name: 'sandbox_probe',
    abortSupport: 'bounded',
    description: 'Probe sandbox injection.',
    permission: {
      category: 'execute',
      sandbox: { allowUnsandboxedFallback: true },
    },
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
    },
    call: async (_input, ctx) => {
      onCall(ctx.sandboxHandle === sandboxMock.handle)
      return { content: 'ok', isError: false }
    },
  }
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { vi.clearAllMocks() })

describe('AgenticSession facade wiring', () => {
  it('registers tools provided in the constructor and resolves dynamic descriptions', async () => {
    let callCount = 0
    mockStream.mockImplementation(params => {
      callCount++
      if (callCount === 1) {
        expect(params.tools.map(t => t.name)).toContain('calculator')
        return toolUseStream('tool-1', 'calculator', { expression: '2+2' })
      }
      return textStream('done')
    })

    const session = new AgenticSession({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-6',
      tools: [makeTool()],
    })

    const events = []
    for await (const event of session.submit('calculate')) {
      events.push(event)
    }

    expect(events.some(e => e.type === 'tool_result' && e.content.includes('value=2+2'))).toBe(true)
    const firstRequest = mockStream.mock.calls[0]?.[0]
    const description = firstRequest?.tools[0]?.description
    expect(description).toBeTypeOf('function')
    if (typeof description === 'function') {
      await expect(description({ sessionId: 's', model: 'm' })).resolves.toContain('Siblings: calculator')
    }
  })

  it('preloads initialMessages into the kernel history', () => {
    const session = new AgenticSession({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-6',
      initialMessages: [
        { role: 'user', content: 'previous question' },
        { role: 'assistant', content: [{ type: 'text', text: 'previous answer' }] },
      ],
    })

    expect(session.getMessages()).toHaveLength(2)
    expect(session.getMessages()[0]?.role).toBe('user')
    expect(session.getMessages()[1]?.role).toBe('assistant')
  })

  it('passes the resolved compactModel into kernel compact config', () => {
    const session = new AgenticSession({
      apiKey: 'test-key',
      baseURL: 'https://open.bigmodel.cn/api/anthropic',
      model: 'glm-5.1',
      flashModel: 'glm-4.5-air',
      compactModel: 'glm-5.1',
      tools: [],
    })

    const engineConfig = (session as unknown as {
      _engine: { _config: { baseURL?: string; compact?: { model?: string } } }
    })._engine._config

    expect(engineConfig.baseURL).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(engineConfig.compact?.model).toBe('glm-5.1')
  })

  it('injects and reuses sandbox handles for direct AgenticSession tools', async () => {
    const seenHandles: boolean[] = []
    let callCount = 0
    mockStream.mockImplementation(() => {
      callCount++
      if (callCount === 1) return toolUseStream('tool-1', 'sandbox_probe', { label: 'first' })
      if (callCount === 2) return toolUseStream('tool-2', 'sandbox_probe', { label: 'second' })
      return textStream('done')
    })

    const session = new AgenticSession({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-6',
      tools: [makeSandboxProbeTool(hasHandle => seenHandles.push(hasHandle))],
    })

    for await (const _event of session.submit('probe')) {
      // consume stream
    }

    expect(seenHandles).toEqual([true, true])
    expect(sandboxMock.createSandboxExecutor).toHaveBeenCalledTimes(1)
    expect(sandboxMock.create).toHaveBeenCalledTimes(1)
  })

  it('forces auto-mode sandboxing to fail closed when no backend is available', async () => {
    sandboxMock.createSandboxExecutor.mockReturnValueOnce({
      platform: 'noop',
      isAvailable: () => false,
      create: vi.fn(async () => sandboxMock.handle),
    })
    mockStream
      .mockImplementationOnce(() => toolUseStream('tool-1', 'sandbox_probe', { label: 'auto' }))
      .mockImplementationOnce(() => textStream('done'))

    const session = new AgenticSession({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-6',
      autonomy: { lockWorkspace: true, autoApproveInWorkspace: true },
      tools: [makeSandboxProbeTool(() => {
        throw new Error('tool should not run without sandbox backend')
      })],
    })

    const events = []
    for await (const event of session.submit('probe')) {
      events.push(event)
    }

    expect(events.some(e =>
      e.type === 'tool_result' &&
      e.isError &&
      e.content.includes('Sandbox requested, but no supported sandbox backend is available'),
    )).toBe(true)
  })
})

describe('MetaAgentSession facade wiring', () => {
  it('registers constructor tools through the public session entry point', async () => {
    let callCount = 0
    mockStream.mockImplementation(() => {
      callCount++
      return callCount === 1
        ? toolUseStream('tool-1', 'calculator', { expression: '3+3' })
        : textStream('done')
    })

    const session = new MetaAgentSession({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-6',
      tools: [makeTool()],
    })

    const events = []
    for await (const event of session.submit('calculate')) {
      events.push(event)
    }

    expect(events.some(e => e.type === 'tool_result' && e.content.includes('value=3+3'))).toBe(true)
  })
})
