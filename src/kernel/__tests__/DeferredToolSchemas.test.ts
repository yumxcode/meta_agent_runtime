/**
 * The wiring that makes deferral real: KernelLoop must send the FILTERED tool
 * list to the model while keeping the full list executable.
 *
 * ToolVisibility.test.ts proves the filter is correct in isolation. This file
 * proves the loop actually uses it — the part that, if it silently regressed,
 * would leave every unit test green while the token saving quietly disappeared.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { KernelSession } from '../KernelSession.js'
import type { KernelTool } from '../types/KernelTool.js'
import { toolVisibility, resetToolVisibility } from '../tools/ToolVisibility.js'

vi.mock('../api/AnthropicClient.js', () => ({ streamMessages: vi.fn() }))

import { streamMessages } from '../api/AnthropicClient.js'
const mockStream = vi.mocked(streamMessages)

async function* textStream(text = 'ok'): AsyncGenerator<import('../api/AnthropicClient.js').StreamEvent> {
  yield { type: 'message_start', usage: { input_tokens: 50 } }
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } as never }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 0 }
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }
  yield { type: 'message_stop' }
}

function tool(name: string, opts: Partial<KernelTool> = {}): KernelTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { safeParse: (d: unknown) => ({ success: true as const, data: d }) },
    inputJSONSchema: { type: 'object', properties: {} },
    abortSupport: 'bounded',
    async call() { return { data: `${name} ran` } },
    isConcurrencySafe: () => true,
    maxResultSizeChars: 1000,
    ...opts,
  }
}

async function runOneTurn(session: KernelSession, prompt = 'hi'): Promise<void> {
  for await (const _ of session.submitMessage(prompt)) { /* drain */ }
}

/** The tool names KernelLoop put on the wire for the most recent request. */
function toolNamesSentToApi(): string[] {
  const lastCall = mockStream.mock.calls.at(-1)
  const params = lastCall?.[0] as { tools: KernelTool[] } | undefined
  return (params?.tools ?? []).map(t => t.name)
}

const TOOLS = [
  tool('read_file'),
  tool('bash'),
  tool('db_query', { namespace: 'mcp', deferLoading: true }),
  tool('db_write', { namespace: 'mcp', deferLoading: true }),
]

beforeEach(() => {
  vi.clearAllMocks()
  resetToolVisibility()
  delete process.env['META_AGENT_TOOLS_EAGER']
})

afterEach(() => {
  resetToolVisibility()
  delete process.env['META_AGENT_TOOLS_EAGER']
})

describe('KernelLoop → API tool list', () => {
  it('withholds deferred tool schemas from the request', async () => {
    mockStream.mockImplementation(() => textStream())
    const session = new KernelSession({
      model: 'claude-opus-4-6', apiKey: 'k', maxTurns: 2,
      tools: TOOLS, compact: { enabled: false },
    })
    await runOneTurn(session)

    expect(toolNamesSentToApi()).toEqual(['read_file', 'bash'])
  })

  it('sends a revealed tool from the next request onward', async () => {
    mockStream.mockImplementation(() => textStream())
    const session = new KernelSession({
      model: 'claude-opus-4-6', apiKey: 'k', maxTurns: 2,
      tools: TOOLS, compact: { enabled: false },
    })
    await runOneTurn(session, 'first')
    expect(toolNamesSentToApi()).not.toContain('db_query')

    toolVisibility().reveal(session.getSessionId(), ['db_query'])
    await runOneTurn(session, 'second')

    const sent = toolNamesSentToApi()
    expect(sent).toContain('db_query')
    // Sticky per tool, not per turn: db_write was never revealed.
    expect(sent).not.toContain('db_write')
  })

  it('sends every schema when nothing is deferred', async () => {
    mockStream.mockImplementation(() => textStream())
    const plain = [tool('read_file'), tool('bash')]
    const session = new KernelSession({
      model: 'claude-opus-4-6', apiKey: 'k', maxTurns: 2,
      tools: plain, compact: { enabled: false },
    })
    await runOneTurn(session)

    expect(toolNamesSentToApi()).toEqual(['read_file', 'bash'])
  })

  it('sends everything under META_AGENT_TOOLS_EAGER', async () => {
    process.env['META_AGENT_TOOLS_EAGER'] = '1'
    mockStream.mockImplementation(() => textStream())
    const session = new KernelSession({
      model: 'claude-opus-4-6', apiKey: 'k', maxTurns: 2,
      tools: TOOLS, compact: { enabled: false },
    })
    await runOneTurn(session)

    expect(toolNamesSentToApi()).toEqual(['read_file', 'bash', 'db_query', 'db_write'])
  })

  it('keeps a withheld tool EXECUTABLE — hiding a schema is not a permission', async () => {
    // The distinction the whole design rests on: the loop filters what it
    // SENDS, never what it will run. If the model calls a hidden tool by name,
    // it runs; refusing would put a context-budget decision on the security
    // path, where the permission layer belongs.
    let sawToolResult = false
    mockStream
      .mockImplementationOnce(async function* () {
        yield { type: 'message_start', usage: { input_tokens: 10 } }
        yield {
          type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: 'tu_1', name: 'db_write', input: {} } as never,
        }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }
        yield { type: 'message_stop' }
      })
      .mockImplementation(() => textStream('done'))

    const session = new KernelSession({
      model: 'claude-opus-4-6', apiKey: 'k', maxTurns: 3,
      tools: TOOLS, compact: { enabled: false },
    })
    for await (const event of session.submitMessage('call the hidden tool')) {
      if (event.type === 'tool_result' && !event.isError) sawToolResult = true
    }

    expect(sawToolResult).toBe(true)
  })
})
