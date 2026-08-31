/**
 * Transcript protocol invariant: a session never ends holding an unanswered
 * tool_use.
 *
 * The Messages API requires a tool_result immediately after every tool_use, so a
 * persisted transcript that violates this is not merely untidy — it is
 * unresumable. `--resume` replays the history, the first request 400s, and the
 * session can never be continued again. The user's only signal is an API error
 * about a message shape they never wrote.
 *
 * The loop commits assistant messages to durable history BEFORE running their
 * tools (KernelLoop `append(...assistantMessages)`), so every exit taken between
 * that append and `runTools()` has to synthesise the missing results. The
 * abort-after-streaming path always did; the no-progress guards and the
 * post_query / pre_tool phase-hook aborts did not, and NO_PROGRESS_REPEAT_LIMIT
 * is only 3 — well inside what a stuck model does routinely.
 *
 * These tests assert the INVARIANT rather than any one call site, so a future
 * exit added between the append and runTools() fails here instead of shipping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { KernelSession } from '../KernelSession.js'
import type { KernelTool } from '../types/KernelTool.js'
import type { KernelMessage } from '../types/KernelMessage.js'

vi.mock('../api/AnthropicClient.js', () => ({ streamMessages: vi.fn() }))
import { streamMessages } from '../api/AnthropicClient.js'
const mockStream = vi.mocked(streamMessages)

async function* toolUseStream(toolId: string): AsyncGenerator<import('../api/AnthropicClient.js').StreamEvent> {
  yield { type: 'message_start', usage: { input_tokens: 100 } }
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } as any }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'let me try again' } }
  yield { type: 'content_block_stop', index: 0 }
  yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: toolId, name: 'probe', input: {} } }
  yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"same"}' } }
  yield { type: 'content_block_stop', index: 1 }
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } }
  yield { type: 'message_stop' }
}

/** Always returns the identical payload, so the no-progress guards engage. */
const probeTool: KernelTool = {
  name: 'probe',
  description: 'returns a constant',
  inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
  inputJSONSchema: { type: 'object' as const, properties: { q: { type: 'string' } } },
  call: async () => ({ data: 'constant' }),
  isConcurrencySafe: () => false,
} as unknown as KernelTool

function makeConfig(overrides?: object) {
  return {
    model: 'claude-sonnet-4-6',
    tools: [probeTool],
    apiKey: 'test-key',
    maxTurns: 40,
    compact: { enabled: false },
    ...overrides,
  }
}

/** Every tool_use id that never received a matching tool_result. */
function unansweredToolUseIds(messages: readonly KernelMessage[]): string[] {
  const answered = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result') answered.add((block as { tool_use_id: string }).tool_use_id)
    }
  }
  const dangling: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        const id = (block as { id: string }).id
        if (!answered.has(id)) dangling.push(id)
      }
    }
  }
  return dangling
}

describe('transcript invariant: no dangling tool_use', () => {
  beforeEach(() => vi.clearAllMocks())

  it('holds when the no-progress guard stops a repeated tool request', async () => {
    // Identical input every turn → identical signature → the repeat guard trips.
    // Fresh ids so a dangling one cannot be masked by an earlier turn's result.
    mockStream.mockImplementation(() => toolUseStream(`tu_${crypto.randomUUID()}`) as any)

    const session = new KernelSession(makeConfig() as never)
    const events = []
    for await (const event of session.submitMessage('go')) events.push(event)

    const result = events.find(e => e.type === 'result') as { stopReason?: string } | undefined
    expect(result?.stopReason).toBe('no_progress')
    expect(unansweredToolUseIds(session.getMessages())).toEqual([])
  })

  it('holds when a pre_tool phase hook aborts before the batch runs', async () => {
    mockStream.mockImplementation(() => toolUseStream('tu_hook') as any)

    const session = new KernelSession(makeConfig({
      phaseHooks: async ({ point }: { point: string }) =>
        point === 'pre_tool' ? { abort: true, note: 'policy stop' } : {},
    }) as never)
    const events = []
    for await (const event of session.submitMessage('go')) events.push(event)

    // The assistant turn was committed, its tools never ran — exactly the window
    // that used to leave the transcript unresumable.
    const messages = session.getMessages()
    expect(messages.some(m => m.content.some(b => b.type === 'tool_use'))).toBe(true)
    expect(unansweredToolUseIds(messages)).toEqual([])
  })

  it('holds when a post_query phase hook aborts after the model replies', async () => {
    mockStream.mockImplementation(() => toolUseStream('tu_postquery') as any)

    const session = new KernelSession(makeConfig({
      phaseHooks: async ({ point }: { point: string }) =>
        point === 'post_query' ? { abort: true, note: 'policy stop' } : {},
    }) as never)
    const events = []
    for await (const event of session.submitMessage('go')) events.push(event)

    expect(unansweredToolUseIds(session.getMessages())).toEqual([])
  })

  it('marks the synthesised results as errors so the model is not misled', async () => {
    mockStream.mockImplementation(() => toolUseStream('tu_repeat') as any)

    const session = new KernelSession(makeConfig() as never)
    for await (const _ of session.submitMessage('go')) { /* drain */ }

    const synthesised = session.getMessages()
      .flatMap(m => m.content)
      .filter((b): b is { type: 'tool_result'; is_error?: boolean; content: unknown } => b.type === 'tool_result')
    expect(synthesised.length).toBeGreaterThan(0)
    // A never-executed tool reported as a SUCCESS with empty output would teach
    // the model that the call worked and returned nothing.
    expect(synthesised.at(-1)?.is_error).toBe(true)
  })
})
