/**
 * Telemetry through a real KernelSession.
 *
 * The unit tests prove the aggregator counts and the sinks write. This file
 * proves the two are actually connected to the event funnel — the part that, if
 * it silently regressed, would leave every other telemetry test green while
 * nothing was ever recorded.
 *
 * It also pins the two ordering guarantees that are easy to get wrong and
 * impossible to notice afterwards:
 *   - the terminal `result` is folded in BEFORE the summary is built, or every
 *     summary reports zero cost and zero turns;
 *   - `finish()` runs in a `finally`, or the only runs that produce a record
 *     are the ones that did not need investigating.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { KernelSession } from '../KernelSession.js'
import type { KernelTool } from '../types/KernelTool.js'
import type { TelemetryRecord, TelemetrySink, TelemetrySummary } from '../telemetry/types.js'

vi.mock('../api/AnthropicClient.js', () => ({ streamMessages: vi.fn() }))
import { streamMessages } from '../api/AnthropicClient.js'
const mockStream = vi.mocked(streamMessages)

class MemorySink implements TelemetrySink {
  readonly name = 'memory'
  records: TelemetryRecord[] = []
  summaries: TelemetrySummary[] = []
  closed = 0
  async record(r: TelemetryRecord): Promise<void> { this.records.push(r) }
  async summary(s: TelemetrySummary): Promise<void> { this.summaries.push(s) }
  async close(): Promise<void> { this.closed++ }
}

/**
 * The recorder is constructed inside `submitMessage`, so a sink cannot be
 * injected through config. Patching the factory is the seam — and patching it
 * rather than reaching into the session keeps the test honest about what the
 * production path does.
 */
async function withSink<T>(sink: MemorySink, fn: () => Promise<T>): Promise<T> {
  const recorderModule = await import('../telemetry/recorder.js')
  const original = recorderModule.createTelemetryRecorder
  const spy = vi.spyOn(recorderModule, 'createTelemetryRecorder')
  spy.mockImplementation((sessionId, config, options) =>
    original(sessionId, config, { ...options, sink }))
  try {
    return await fn()
  } finally {
    spy.mockRestore()
  }
}

async function* textStream(text = 'ok'): AsyncGenerator<import('../api/AnthropicClient.js').StreamEvent> {
  yield { type: 'message_start', usage: { input_tokens: 100 } }
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } as never }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 0 }
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }
  yield { type: 'message_stop' }
}

function echoTool(name: string, isError = false): KernelTool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { safeParse: (d: unknown) => ({ success: true as const, data: d }) },
    inputJSONSchema: { type: 'object', properties: {} },
    abortSupport: 'bounded',
    async call() { return { data: `${name} ran`, isError } },
    isConcurrencySafe: () => true,
    maxResultSizeChars: 1000,
  }
}

/** One assistant turn that calls `toolName`, then a plain text turn. */
function toolThenText(toolName: string): void {
  mockStream
    .mockImplementationOnce(async function* () {
      yield { type: 'message_start', usage: { input_tokens: 50 } }
      yield {
        type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: toolName, input: {} } as never,
      }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }
      yield { type: 'message_stop' }
    })
    .mockImplementation(() => textStream('done'))
}

function makeSession(tools: KernelTool[] = []): KernelSession {
  return new KernelSession({
    model: 'claude-opus-4-6', apiKey: 'k', maxTurns: 5,
    tools, compact: { enabled: false },
    telemetry: { enabled: true },
  })
}

async function drain(session: KernelSession, prompt = 'hi'): Promise<void> {
  for await (const _ of session.submitMessage(prompt)) { /* consume */ }
}

beforeEach(() => vi.clearAllMocks())

describe('telemetry is wired to the event funnel', () => {
  it('records events and exactly one summary for a run', async () => {
    const sink = new MemorySink()
    mockStream.mockImplementation(() => textStream())
    await withSink(sink, () => drain(makeSession()))

    expect(sink.summaries).toHaveLength(1)
    expect(sink.closed).toBe(1)
    // text_delta is high-volume and excluded by default; the terminal result
    // is not.
    expect(sink.records.map(r => r.event.type)).toContain('result')
    expect(sink.records.map(r => r.event.type)).not.toContain('text_delta')
  })

  it('folds the terminal result in BEFORE building the summary', async () => {
    // If the ordering inverts, every summary reports zero usage and no outcome
    // — a working-looking pipeline producing useless numbers.
    //
    // Driven with a TOOL CALL so `numTurns` is genuinely non-zero: a text-only
    // reply completes with toolBatchCount 0, so asserting turns > 0 there would
    // be asserting against correct behaviour.
    const sink = new MemorySink()
    toolThenText('probe')
    await withSink(sink, () => drain(makeSession([echoTool('probe')])))

    const summary = sink.summaries[0]!
    expect(summary.outcome).toBe('success')
    expect(summary.numTurns).toBeGreaterThan(0)
    expect(summary.usage.inputTokens).toBeGreaterThan(0)
  })

  it('reports zero turns for a text-only reply, because that is the truth', () => {
    // Pinned so the assertion above is not "fixed" one day by making
    // toolBatchCount count something it should not.
    const sink = new MemorySink()
    mockStream.mockImplementation(() => textStream())
    return withSink(sink, async () => {
      await drain(makeSession())
      expect(sink.summaries[0]!.numTurns).toBe(0)
      expect(sink.summaries[0]!.outcome).toBe('success')
    })
  })

  it('counts a failing tool against its name', async () => {
    const sink = new MemorySink()
    toolThenText('flaky')
    await withSink(sink, () => drain(makeSession([echoTool('flaky', true)])))

    expect(sink.summaries[0]!.tools['flaky']).toEqual({ calls: 1, errors: 1 })
  })

  it('counts a succeeding tool with zero errors', async () => {
    const sink = new MemorySink()
    toolThenText('steady')
    await withSink(sink, () => drain(makeSession([echoTool('steady', false)])))

    expect(sink.summaries[0]!.tools['steady']).toEqual({ calls: 1, errors: 0 })
  })

  it('writes a summary even when the run fails', async () => {
    // The runs worth investigating are exactly the ones that did not finish
    // cleanly; a record that only exists for clean runs is the wrong record.
    const sink = new MemorySink()
    mockStream.mockImplementation(() => { throw new Error('stream exploded') })
    await withSink(sink, () => drain(makeSession()))

    expect(sink.summaries).toHaveLength(1)
    expect(sink.summaries[0]!.outcome).toMatch(/error/)
  })

  it('writes a summary even when the consumer abandons the stream', async () => {
    const sink = new MemorySink()
    mockStream.mockImplementation(() => textStream())
    await withSink(sink, async () => {
      const session = makeSession()
      // Break out after the first event: the generator's `finally` is what has
      // to run, and it only does because finish() lives there.
      for await (const _ of session.submitMessage('hi')) break
    })

    expect(sink.summaries).toHaveLength(1)
  })

  it('gives each run its own id, and stamps every record with it', async () => {
    const sink = new MemorySink()
    mockStream.mockImplementation(() => textStream())
    const session = makeSession()
    await withSink(sink, async () => {
      await drain(session, 'first')
      await drain(session, 'second')
    })

    expect(sink.summaries).toHaveLength(2)
    const [a, b] = sink.summaries
    expect(a!.runId).not.toBe(b!.runId)
    // Same session across both runs — runId scopes a submitMessage, sessionId
    // scopes the conversation.
    expect(a!.sessionId).toBe(b!.sessionId)
    for (const record of sink.records) {
      expect([a!.runId, b!.runId]).toContain(record.runId)
    }
  })

  it('does nothing at all when telemetry is disabled', async () => {
    const sink = new MemorySink()
    mockStream.mockImplementation(() => textStream())
    await withSink(sink, async () => {
      // No `telemetry` key: the recorder is never constructed, so the sink is
      // never reached even though it was injectable.
      const session = new KernelSession({
        model: 'claude-opus-4-6', apiKey: 'k', maxTurns: 5,
        tools: [], compact: { enabled: false },
      })
      await drain(session)
    })

    expect(sink.records).toHaveLength(0)
    expect(sink.summaries).toHaveLength(0)
  })
})
