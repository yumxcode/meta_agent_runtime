/**
 * DeepSeekClient — OpenAI-protocol chunk stream → Anthropic-shaped StreamEvents.
 *
 * This file had NO test at all and the module sat at 6% line coverage, which is
 * how a real tool-call decoding bug survived: `id` and `name` were read exactly
 * once, when a `tool_calls[].index` was first seen, with no way to correct them
 * afterwards. KernelLoop takes the tool name off `content_block_start` and
 * finaliseAccumulator builds the `tool_use` block straight from it, so a name
 * that arrived one chunk late was lost permanently — the model's tool call
 * simply vanished, and the resulting error pointed at the tool registry.
 *
 * The whole decoder is a pure function of the chunk sequence, so everything
 * interesting here is a chunk SHAPE, not a network condition. That is what
 * these tables drive.
 */
import { describe, expect, it } from 'vitest'
import type OpenAI from 'openai'
import { processStreamInner, UNNAMED_TOOL_CALL } from '../DeepSeekClient.js'
import type { StreamEvent } from '../../types/StreamEvent.js'

type Chunk = OpenAI.Chat.ChatCompletionChunk

/** Build a content/tool delta chunk. */
function delta(d: Record<string, unknown>, finish?: string): Chunk {
  return {
    choices: [{ index: 0, delta: d, finish_reason: finish ?? null }],
  } as unknown as Chunk
}

/** Build the final usage-only chunk (choices empty). */
function usageChunk(usage: Record<string, unknown>): Chunk {
  return { choices: [], usage } as unknown as Chunk
}

async function collect(chunks: Chunk[]): Promise<StreamEvent[]> {
  async function* source(): AsyncGenerator<Chunk> {
    for (const c of chunks) yield c
  }
  const out: StreamEvent[] = []
  for await (const event of processStreamInner(source())) out.push(event)
  return out
}

/**
 * Reduce the event stream the way KernelLoop's accumulator does
 * (`KernelLoop.ts:1070-1110` + finaliseAccumulator), so assertions are about
 * what the agent ACTUALLY ends up executing, not about intermediate events.
 */
interface DecodedBlock {
  type: string
  id?: string
  name?: string
  text?: string
  thinking?: string
  args?: string
}
function decode(events: StreamEvent[]): {
  blocks: DecodedBlock[]
  stopReason: string | null
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
} {
  const blocks: DecodedBlock[] = []
  let stopReason: string | null = null
  let inputTokens = 0
  let cacheReadTokens = 0
  let outputTokens = 0
  for (const e of events as Array<Record<string, never>>) {
    const ev = e as unknown as Record<string, unknown>
    if (ev['type'] === 'content_block_start') {
      const cb = ev['content_block'] as Record<string, unknown>
      blocks[ev['index'] as number] = {
        type: cb['type'] as string,
        ...(cb['id'] !== undefined ? { id: cb['id'] as string } : {}),
        ...(cb['name'] !== undefined ? { name: cb['name'] as string } : {}),
        text: '', thinking: '', args: '',
      }
    } else if (ev['type'] === 'content_block_delta') {
      const block = blocks[ev['index'] as number]!
      const d = ev['delta'] as Record<string, unknown>
      if (d['type'] === 'text_delta') block.text += d['text'] as string
      if (d['type'] === 'thinking_delta') block.thinking += d['thinking'] as string
      if (d['type'] === 'input_json_delta') block.args += d['partial_json'] as string
    } else if (ev['type'] === 'message_start') {
      const u = ev['usage'] as Record<string, number>
      inputTokens = u['input_tokens'] ?? 0
      cacheReadTokens = u['cache_read_input_tokens'] ?? 0
    } else if (ev['type'] === 'message_delta') {
      stopReason = (ev['delta'] as Record<string, unknown>)['stop_reason'] as string | null
      outputTokens = (ev['usage'] as Record<string, number>)['output_tokens'] ?? 0
    }
  }
  return { blocks, stopReason, inputTokens, cacheReadTokens, outputTokens }
}

// ── Tool call decoding ────────────────────────────────────────────────────────

describe('tool_calls accumulation', () => {
  it('A · id + name in the first delta (the common shape)', async () => {
    const { blocks } = decode(await collect([
      delta({ tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'bash', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] }),
      delta({}, 'tool_calls'),
    ]))
    expect(blocks[0]).toMatchObject({ type: 'tool_use', id: 'call_abc', name: 'bash', args: '{"cmd":"ls"}' })
  })

  it('B · opener carries only `type`; id + name arrive in a LATER delta', async () => {
    // Pre-fix this produced { id: 'call_0', name: '' } — the call was lost.
    const { blocks } = decode(await collect([
      delta({ tool_calls: [{ index: 0, type: 'function', function: { arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'bash' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] }),
      delta({}, 'tool_calls'),
    ]))
    expect(blocks[0]).toMatchObject({ type: 'tool_use', id: 'call_abc', name: 'bash', args: '{"cmd":"ls"}' })
  })

  it('C · name streamed in fragments', async () => {
    // Pre-fix this produced name 'ba'.
    const { blocks } = decode(await collect([
      delta({ tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'ba', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { name: 'sh' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] }),
      delta({}, 'tool_calls'),
    ]))
    expect(blocks[0]).toMatchObject({ id: 'call_abc', name: 'bash', args: '{"cmd":"ls"}' })
  })

  it('D · arguments that arrive BEFORE the name are buffered, not dropped', async () => {
    const { blocks } = decode(await collect([
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"cm' } }] }),
      delta({ tool_calls: [{ index: 0, id: 'call_x', function: { name: 'bash', arguments: 'd":"' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'ls"}' } }] }),
      delta({}, 'tool_calls'),
    ]))
    // Order matters: the buffered prefix must be flushed ahead of later args.
    expect(blocks[0]).toMatchObject({ id: 'call_x', name: 'bash', args: '{"cmd":"ls"}' })
    expect(JSON.parse(blocks[0]!.args!)).toEqual({ cmd: 'ls' })
  })

  it('E · parallel tool calls keep their own id/name/args and wire order', async () => {
    const { blocks } = decode(await collect([
      delta({ tool_calls: [
        { index: 0, id: 'c0', function: { name: 'read_file', arguments: '' } },
        { index: 1, id: 'c1', function: { name: 'grep', arguments: '' } },
      ] }),
      delta({ tool_calls: [{ index: 1, function: { arguments: '{"pattern":"x"}' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"file_path":"a"}' } }] }),
      delta({}, 'tool_calls'),
    ]))
    expect(blocks[0]).toMatchObject({ id: 'c0', name: 'read_file', args: '{"file_path":"a"}' })
    expect(blocks[1]).toMatchObject({ id: 'c1', name: 'grep', args: '{"pattern":"x"}' })
  })

  it('F · interleaved parallel calls whose names both arrive late', async () => {
    const { blocks } = decode(await collect([
      delta({ tool_calls: [{ index: 0, type: 'function' }, { index: 1, type: 'function' }] }),
      delta({ tool_calls: [{ index: 1, id: 'c1', function: { name: 'grep' } }] }),
      delta({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'bash' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }),
      delta({}, 'tool_calls'),
    ]))
    // Block indices follow FIRST SIGHT of the tool index, not name arrival —
    // otherwise the two calls would swap places relative to the wire.
    expect(blocks[0]).toMatchObject({ id: 'c0', name: 'bash' })
    expect(blocks[1]).toMatchObject({ id: 'c1', name: 'grep' })
  })

  it('G · a tool call whose name NEVER arrives is surfaced, not silently dropped', async () => {
    const { blocks } = decode(await collect([
      delta({ tool_calls: [{ index: 0, id: 'c0', function: { arguments: '{"a":1}' } }] }),
      delta({}, 'tool_calls'),
    ]))
    expect(blocks[0]).toMatchObject({ type: 'tool_use', id: 'c0', name: UNNAMED_TOOL_CALL, args: '{"a":1}' })
  })

  it('H · a call with no id at all still gets a usable synthetic id', async () => {
    const { blocks } = decode(await collect([
      delta({ tool_calls: [{ index: 0, function: { name: 'bash', arguments: '{}' } }] }),
      delta({}, 'tool_calls'),
    ]))
    expect(blocks[0]).toMatchObject({ name: 'bash', id: 'call_0' })
  })

  it('I · tc.index omitted entirely is treated as index 0', async () => {
    const { blocks } = decode(await collect([
      delta({ tool_calls: [{ id: 'c0', function: { name: 'bash', arguments: '{' } }] }),
      delta({ tool_calls: [{ function: { arguments: '}' } }] }),
      delta({}, 'tool_calls'),
    ]))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ id: 'c0', name: 'bash', args: '{}' })
  })
})

// ── Text / thinking ───────────────────────────────────────────────────────────

describe('text and reasoning blocks', () => {
  it('opens a text block once and concatenates every delta', async () => {
    const { blocks } = decode(await collect([
      delta({ content: 'Hello' }),
      delta({ content: ', ' }),
      delta({ content: 'world' }),
      delta({}, 'stop'),
    ]))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'Hello, world' })
  })

  it('maps reasoning_content to a thinking block ahead of the text block', async () => {
    const { blocks } = decode(await collect([
      delta({ reasoning_content: 'let me think' }),
      delta({ reasoning_content: ' harder' }),
      delta({ content: 'answer' }),
      delta({}, 'stop'),
    ]))
    expect(blocks[0]).toMatchObject({ type: 'thinking', thinking: 'let me think harder' })
    expect(blocks[1]).toMatchObject({ type: 'text', text: 'answer' })
  })

  it('empty-string content does not open a spurious block', async () => {
    const { blocks } = decode(await collect([
      delta({ content: '' }),
      delta({ reasoning_content: '' }),
      delta({}, 'stop'),
    ]))
    expect(blocks.filter(Boolean)).toHaveLength(0)
  })

  it('content-less keepalive chunks are ignored', async () => {
    const { blocks, stopReason } = decode(await collect([
      delta({}),
      delta({ content: 'x' }),
      delta({}),
      delta({}, 'stop'),
    ]))
    expect(blocks).toHaveLength(1)
    expect(stopReason).toBe('end_turn')
  })
})

// ── Stop reason + usage ───────────────────────────────────────────────────────

describe('stop reason mapping', () => {
  const cases: Array<[string, string | null]> = [
    ['stop', 'end_turn'],
    ['tool_calls', 'tool_use'],
    ['length', 'max_tokens'],
    ['content_filter', 'stop_sequence'],
  ]
  for (const [wire, mapped] of cases) {
    it(`${wire} → ${mapped}`, async () => {
      const { stopReason } = decode(await collect([delta({ content: 'x' }), delta({}, wire)]))
      expect(stopReason).toBe(mapped)
    })
  }

  it('a stream that never sends finish_reason yields a null stop reason', async () => {
    const { stopReason } = decode(await collect([delta({ content: 'x' })]))
    expect(stopReason).toBeNull()
  })
})

describe('usage normalization', () => {
  it('splits prompt_tokens into non-cached input + cache reads', async () => {
    // The cached portion must NOT be double-counted downstream in CostTracker.
    const { inputTokens, cacheReadTokens, outputTokens } = decode(await collect([
      delta({ content: 'x' }),
      delta({}, 'stop'),
      usageChunk({ prompt_tokens: 1000, completion_tokens: 42, prompt_tokens_details: { cached_tokens: 400 } }),
    ]))
    expect(inputTokens).toBe(600)
    expect(cacheReadTokens).toBe(400)
    expect(outputTokens).toBe(42)
  })

  it("handles DeepSeek's native prompt_cache_hit/miss pair", async () => {
    const { inputTokens, cacheReadTokens } = decode(await collect([
      delta({ content: 'x' }),
      delta({}, 'stop'),
      usageChunk({ prompt_tokens: 1000, completion_tokens: 7, prompt_cache_hit_tokens: 300, prompt_cache_miss_tokens: 700 }),
    ]))
    expect(inputTokens).toBe(700)
    expect(cacheReadTokens).toBe(300)
  })

  it('a stream with NO usage chunk reports zeros rather than throwing', async () => {
    const { inputTokens, outputTokens } = decode(await collect([delta({ content: 'x' }), delta({}, 'stop')]))
    expect(inputTokens).toBe(0)
    expect(outputTokens).toBe(0)
  })
})

// ── Event ordering contract ───────────────────────────────────────────────────

describe('event ordering', () => {
  it('emits all content BEFORE message_start/delta/stop', async () => {
    const events = await collect([
      delta({ content: 'hi' }),
      delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'bash', arguments: '{}' } }] }),
      delta({}, 'tool_calls'),
      usageChunk({ prompt_tokens: 5, completion_tokens: 6 }),
    ])
    const types = (events as unknown as Array<{ type: string }>).map(e => e.type)
    const firstTerminal = types.indexOf('message_start')
    expect(firstTerminal).toBeGreaterThan(0)
    expect(types.slice(firstTerminal)).toEqual(['message_start', 'message_delta', 'message_stop'])
    // KernelLoop reads inputTokens on message_start and outputTokens on
    // message_delta, and only consumes both at message_stop — which is what
    // makes emitting usage after the content safe.
    expect(types.slice(0, firstTerminal).every(t => t.startsWith('content_block'))).toBe(true)
  })

  it('an entirely empty stream still terminates cleanly', async () => {
    const events = await collect([])
    const types = (events as unknown as Array<{ type: string }>).map(e => e.type)
    expect(types).toEqual(['message_start', 'message_delta', 'message_stop'])
  })
})
