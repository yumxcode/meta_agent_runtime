/**
 * Telemetry: the counters, the sinks, and the promise that none of it can break
 * the run it observes.
 *
 * The last of those is the property most worth testing. Everything else here is
 * arithmetic; "a failing disk does not fail the overnight run" is the invariant
 * that decides whether turning telemetry on is safe.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KernelEvent } from '../types/KernelEvent.js'
import { TelemetryAggregator, rollupSummaries } from '../telemetry/aggregate.js'
import { JsonlTelemetrySink, MultiSink, OtlpTelemetrySink } from '../telemetry/sinks.js'
import { TelemetryRecorder, createTelemetryRecorder } from '../telemetry/recorder.js'
import type { TelemetryRecord, TelemetrySink, TelemetrySummary } from '../telemetry/types.js'
import { EVENT_SCHEMA_VERSION } from '../events/schema.js'

const usage = {
  inputTokens: 100, outputTokens: 50,
  cacheWriteTokens: 0, cacheReadTokens: 0,
}

function resultEvent(over: Partial<Extract<KernelEvent, { type: 'result' }>> = {}): KernelEvent {
  return {
    type: 'result',
    subtype: 'success',
    sessionId: 's',
    usage,
    costUsd: 0.5,
    numTurns: 3,
    stopReason: 'end_turn',
    resultText: 'done',
    ...over,
  } as KernelEvent
}

/** In-memory sink so sink behaviour and recorder behaviour are tested apart. */
class MemorySink implements TelemetrySink {
  readonly name = 'memory'
  records: TelemetryRecord[] = []
  summaries: TelemetrySummary[] = []
  closed = 0
  async record(r: TelemetryRecord): Promise<void> { this.records.push(r) }
  async summary(s: TelemetrySummary): Promise<void> { this.summaries.push(s) }
  async close(): Promise<void> { this.closed++ }
}

describe('TelemetryAggregator', () => {
  it('counts tool calls and errors per name', () => {
    // The headline question is "which tool fails most", so the counters must be
    // per NAME — a single global failure rate cannot answer it.
    const agg = new TelemetryAggregator('run', 's', 0)
    agg.observe({ type: 'tool_use', id: '1', name: 'bash', input: {}, sessionId: 's' })
    agg.observe({ type: 'tool_result', id: '1', toolName: 'bash', content: 'x', isError: true, sessionId: 's' })
    agg.observe({ type: 'tool_use', id: '2', name: 'bash', input: {}, sessionId: 's' })
    agg.observe({ type: 'tool_result', id: '2', toolName: 'bash', content: 'x', isError: false, sessionId: 's' })
    agg.observe({ type: 'tool_use', id: '3', name: 'read_file', input: {}, sessionId: 's' })
    agg.observe({ type: 'tool_result', id: '3', toolName: 'read_file', content: 'x', isError: false, sessionId: 's' })

    const s = agg.build(1_000)
    expect(s.tools['bash']).toEqual({ calls: 2, errors: 1 })
    expect(s.tools['read_file']).toEqual({ calls: 1, errors: 0 })
  })

  it('attributes a result to the tool_use id, not just the echoed name', () => {
    const agg = new TelemetryAggregator('run', 's', 0)
    agg.observe({ type: 'tool_use', id: 'x', name: 'real_name', input: {}, sessionId: 's' })
    agg.observe({ type: 'tool_result', id: 'x', toolName: 'stale_name', content: '', isError: true, sessionId: 's' })
    expect(agg.build(0).tools['real_name']?.errors).toBe(1)
  })

  it('computes the compaction ratio, and reports 0 rather than NaN', () => {
    // A NaN here would silently poison every downstream average.
    expect(new TelemetryAggregator('r', 's', 0).build(0).compaction.ratio).toBe(0)

    const agg = new TelemetryAggregator('r', 's', 0)
    agg.observe({ type: 'compact_start', sessionId: 's' })
    agg.observe({
      type: 'compact_boundary',
      compactMetadata: { previousTokens: 80_000, summaryTokens: 8_000 },
      sessionId: 's',
    })
    const s = agg.build(0)
    expect(s.compaction).toMatchObject({ started: 1, completed: 1, ratio: 0.1 })
  })

  it('buckets a null retry status as "network" rather than dropping it', () => {
    // A transport failure with no HTTP status is a distinct and interesting
    // bucket, not a missing value.
    const agg = new TelemetryAggregator('r', 's', 0)
    agg.observe({ type: 'api_retry', attempt: 1, maxRetries: 5, retryDelayMs: 1, errorStatus: null, sessionId: 's' })
    agg.observe({ type: 'api_retry', attempt: 2, maxRetries: 5, retryDelayMs: 1, errorStatus: 529, sessionId: 's' })
    const s = agg.build(0)
    expect(s.apiRetries).toEqual({ total: 2, byStatus: { network: 1, '529': 1 } })
  })

  it('records permission denials by tool', () => {
    const agg = new TelemetryAggregator('r', 's', 0)
    agg.observe(resultEvent({
      permissionDenials: [
        { toolName: 'bash', toolUseId: 'a', reason: 'r', timestamp: 0 },
        { toolName: 'bash', toolUseId: 'b', reason: 'r', timestamp: 0 },
        { toolName: 'write_file', toolUseId: 'c', reason: 'r', timestamp: 0 },
      ],
    }))
    expect(agg.build(0).permissionDenials).toEqual({ bash: 2, write_file: 1 })
  })

  it('takes cost/turns/outcome from the result event', () => {
    const agg = new TelemetryAggregator('r', 's', 100)
    agg.observe(resultEvent({ subtype: 'error_max_turns', costUsd: 2.25, numTurns: 60 }))
    const s = agg.build(1_100)
    expect(s).toMatchObject({ outcome: 'error_max_turns', costUsd: 2.25, numTurns: 60, durationMs: 1_000 })
    expect(s.schemaVersion).toBe(EVENT_SCHEMA_VERSION)
  })

  it('counts system messages by subtype', () => {
    const agg = new TelemetryAggregator('r', 's', 0)
    agg.observe({ type: 'system_message', subtype: 'warning', text: '[drift] x', sessionId: 's' })
    agg.observe({ type: 'system_message', subtype: 'warning', text: '[verify] y', sessionId: 's' })
    agg.observe({ type: 'system_message', subtype: 'info', text: 'z', sessionId: 's' })
    expect(agg.build(0).systemMessages).toEqual({ warning: 2, info: 1 })
  })

  it('never reports a negative duration', () => {
    // Clock adjustments happen; a negative duration in a summary is worse than
    // a zero because it silently breaks any aggregate over it.
    expect(new TelemetryAggregator('r', 's', 5_000).build(1_000).durationMs).toBe(0)
  })
})

describe('rollupSummaries — the cross-run query', () => {
  const mk = (over: Partial<TelemetrySummary>): TelemetrySummary => ({
    schemaVersion: EVENT_SCHEMA_VERSION, ts: 0, runId: 'r', sessionId: 's',
    durationMs: 0, costUsd: 0, numTurns: 0, usage,
    tools: {}, systemMessages: {},
    compaction: { started: 0, completed: 0, failed: 0, previousTokens: 0, summaryTokens: 0, ratio: 0 },
    apiRetries: { total: 0, byStatus: {} }, permissionDenials: {},
    ...over,
  })

  it('answers "which tool failed most across all runs"', () => {
    const rollup = rollupSummaries([
      mk({ tools: { bash: { calls: 10, errors: 4 }, read_file: { calls: 20, errors: 0 } } }),
      mk({ tools: { bash: { calls: 5, errors: 3 }, glob: { calls: 2, errors: 1 } } }),
    ])
    expect(rollup.toolFailures[0]).toEqual({
      name: 'bash', calls: 15, errors: 7, errorRate: 7 / 15,
    })
  })

  it('ranks by absolute errors before rate', () => {
    // A tool that failed 40 times matters more than one that failed its only
    // call; sorting by rate alone inverts that.
    const rollup = rollupSummaries([
      mk({ tools: { noisy: { calls: 100, errors: 40 }, once: { calls: 1, errors: 1 } } }),
    ])
    expect(rollup.toolFailures.map(t => t.name)).toEqual(['noisy', 'once'])
  })

  it('aggregates outcomes, cost and retries', () => {
    const rollup = rollupSummaries([
      mk({ outcome: 'success', costUsd: 1, numTurns: 5, apiRetries: { total: 2, byStatus: { '529': 2 } } }),
      mk({ outcome: 'success', costUsd: 2, numTurns: 10 }),
      mk({ outcome: 'error_max_turns', costUsd: 3, numTurns: 60 }),
    ])
    expect(rollup.runs).toBe(3)
    expect(rollup.totalCostUsd).toBe(6)
    expect(rollup.totalTurns).toBe(75)
    expect(rollup.outcomes).toEqual({ success: 2, error_max_turns: 1 })
    expect(rollup.apiRetries).toEqual({ total: 2, byStatus: { '529': 2 } })
  })

  it('averages the compaction ratio over runs that compacted', () => {
    const rollup = rollupSummaries([
      mk({ compaction: { started: 1, completed: 1, failed: 0, previousTokens: 100, summaryTokens: 10, ratio: 0.1 } }),
      mk({ compaction: { started: 1, completed: 1, failed: 0, previousTokens: 100, summaryTokens: 30, ratio: 0.3 } }),
      mk({}), // no compaction — must not drag the average toward zero
    ])
    expect(rollup.compaction).toEqual({ runsWithCompaction: 2, averageRatio: 0.2 })
  })

  it('handles an empty corpus', () => {
    expect(rollupSummaries([])).toMatchObject({ runs: 0, totalCostUsd: 0, toolFailures: [] })
  })
})

describe('JsonlTelemetrySink', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'telemetry-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes events and summaries to separate day-stamped files', () => {
    // Separate files because they are read for different purposes: summaries
    // are the queryable index, records are the detail you open afterwards.
    const sink = new JsonlTelemetrySink(dir)
    const ts = Date.parse('2026-08-22T10:00:00Z')
    return (async () => {
      await sink.record({ schemaVersion: '1.0.0', ts, runId: 'r', sessionId: 's', event: resultEvent() })
      await sink.summary({ ...(new TelemetryAggregator('r', 's', ts).build(ts)) })
      const files = readdirSync(dir).sort()
      expect(files).toEqual(['events-2026-08-22.jsonl', 'runs-2026-08-22.jsonl'])
    })()
  })

  it('appends one JSON object per line', async () => {
    const sink = new JsonlTelemetrySink(dir)
    const ts = Date.parse('2026-08-22T10:00:00Z')
    for (let i = 0; i < 3; i++) {
      await sink.record({ schemaVersion: '1.0.0', ts, runId: 'r', sessionId: 's', event: resultEvent({ numTurns: i }) })
    }
    const lines = readFileSync(join(dir, 'events-2026-08-22.jsonl'), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map(l => JSON.parse(l).event.numTurns)).toEqual([0, 1, 2])
  })

  it('redacts credentials on the way out', async () => {
    // Telemetry is a SECOND, longer-lived destination for tool output than the
    // context window. A token that survives into a day-long log file is a
    // bigger exposure than one that survives a turn.
    const sink = new JsonlTelemetrySink(dir)
    const ts = Date.parse('2026-08-22T10:00:00Z')
    await sink.record({
      schemaVersion: '1.0.0', ts, runId: 'r', sessionId: 's',
      event: {
        type: 'tool_result', id: '1', toolName: 'bash',
        content: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        isError: false, sessionId: 's',
      },
    })
    const written = readFileSync(join(dir, 'events-2026-08-22.jsonl'), 'utf-8')
    expect(written).not.toContain('ghp_abcdefghij')
    expect(written).toContain('REDACTED')
  })

  it('reports a write failure once and never throws it into the run', async () => {
    // The invariant that decides whether enabling telemetry is safe.
    //
    // The unwritable path is a directory nested inside a FILE, which fails
    // fast with ENOTDIR on every platform. Pointing at something like
    // /proc/... instead makes the failure mode depend on the sandbox.
    const errors: string[] = []
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const sink = new JsonlTelemetrySink(join(blocker, 'nested'), {
      onError: (name, err) => errors.push(`${name}:${err.message}`),
    })
    const ts = Date.now()
    for (let i = 0; i < 5; i++) {
      await expect(
        sink.record({ schemaVersion: '1.0.0', ts, runId: 'r', sessionId: 's', event: resultEvent() }),
      ).resolves.toBeUndefined()
    }
    // Once, not five times: a failing disk fails on every event, and a
    // per-event warning would bury the run's real output.
    expect(errors).toHaveLength(1)
  })

  it('degrades a non-serialisable record instead of throwing', async () => {
    const sink = new JsonlTelemetrySink(dir)
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const ts = Date.parse('2026-08-22T10:00:00Z')
    await sink.record({
      schemaVersion: '1.0.0', ts, runId: 'r', sessionId: 's',
      event: { type: 'tool_use', id: '1', name: 'x', input: cyclic, sessionId: 's' },
    })
    expect(readFileSync(join(dir, 'events-2026-08-22.jsonl'), 'utf-8')).toContain('not serialisable')
  })
})

describe('OtlpTelemetrySink', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it('batches records and flushes a summary immediately', async () => {
    const calls: unknown[] = []
    globalThis.fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse((init as RequestInit).body as string))
      return { ok: true, status: 200 } as Response
    }) as typeof fetch

    const sink = new OtlpTelemetrySink('http://collector/v1/logs', {}, { batchSize: 3 })
    const ts = Date.now()
    const rec = { schemaVersion: '1.0.0', ts, runId: 'r', sessionId: 's', event: resultEvent() }
    await sink.record(rec)
    await sink.record(rec)
    expect(calls).toHaveLength(0)      // still buffering
    await sink.record(rec)
    expect(calls).toHaveLength(1)      // batch threshold reached

    await sink.summary(new TelemetryAggregator('r', 's', ts).build(ts))
    // Summaries are what people query and there is one per run — never left in
    // a buffer that a crash would discard.
    expect(calls).toHaveLength(2)
  })

  it('reports a non-2xx once and does not throw', async () => {
    const errors: string[] = []
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 }) as Response) as typeof fetch
    const sink = new OtlpTelemetrySink('http://collector', {}, {
      batchSize: 1, onError: (n, e) => errors.push(`${n}:${e.message}`),
    })
    const ts = Date.now()
    await sink.record({ schemaVersion: '1.0.0', ts, runId: 'r', sessionId: 's', event: resultEvent() })
    await sink.record({ schemaVersion: '1.0.0', ts, runId: 'r', sessionId: 's', event: resultEvent() })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('503')
  })

  it('survives a network error', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    const sink = new OtlpTelemetrySink('http://collector', {}, { batchSize: 1 })
    const ts = Date.now()
    await expect(
      sink.record({ schemaVersion: '1.0.0', ts, runId: 'r', sessionId: 's', event: resultEvent() }),
    ).resolves.toBeUndefined()
  })

  it('flushes the buffer on close', async () => {
    const calls: number[] = []
    globalThis.fetch = vi.fn(async () => { calls.push(1); return { ok: true, status: 200 } as Response }) as typeof fetch
    const sink = new OtlpTelemetrySink('http://collector', {}, { batchSize: 1000 })
    const ts = Date.now()
    await sink.record({ schemaVersion: '1.0.0', ts, runId: 'r', sessionId: 's', event: resultEvent() })
    expect(calls).toHaveLength(0)
    await sink.close()
    expect(calls).toHaveLength(1)
  })
})

describe('MultiSink', () => {
  it('fans out and isolates one sink from another', async () => {
    const good = new MemorySink()
    const bad: TelemetrySink = {
      name: 'bad',
      record: async () => { throw new Error('boom') },
      summary: async () => { throw new Error('boom') },
      close: async () => {},
    }
    const multi = new MultiSink([bad, good])
    const ts = Date.now()
    // Promise.all rejects on the first failure, so the recorder catches it.
    // What matters is that `good` still received the record.
    await multi.record({ schemaVersion: '1.0.0', ts, runId: 'r', sessionId: 's', event: resultEvent() })
      .catch(() => undefined)
    expect(good.records).toHaveLength(1)
  })
})

describe('TelemetryRecorder', () => {
  it('is null when telemetry is disabled — the default', () => {
    // Returning null rather than a no-op keeps the disabled path a nullish
    // check instead of a method call per event.
    expect(createTelemetryRecorder('s', undefined)).toBeNull()
    expect(createTelemetryRecorder('s', { enabled: false })).toBeNull()
    expect(createTelemetryRecorder('s', { enabled: true }, { sink: new MemorySink() })).not.toBeNull()
  })

  it('drops high-volume deltas by default but still counts them', async () => {
    const sink = new MemorySink()
    const rec = new TelemetryRecorder({ sessionId: 's', config: { enabled: true }, sink })
    rec.observe({ type: 'text_delta', delta: 'a', sessionId: 's' })
    rec.observe({ type: 'thinking_delta', delta: 'b', sessionId: 's' })
    rec.observe({ type: 'tool_use', id: '1', name: 'bash', input: {}, sessionId: 's' })
    await new Promise(r => setImmediate(r))

    expect(sink.records.map(r => r.event.type)).toEqual(['tool_use'])
    // The aggregator sees everything regardless — dropping inputs to the
    // counters would make the summary wrong, which is worse than a big file.
    expect(rec.snapshot().tools['bash']?.calls).toBe(1)
  })

  it('records deltas under detail: full', async () => {
    const sink = new MemorySink()
    const rec = new TelemetryRecorder({ sessionId: 's', config: { enabled: true, detail: 'full' }, sink })
    rec.observe({ type: 'text_delta', delta: 'a', sessionId: 's' })
    await new Promise(r => setImmediate(r))
    expect(sink.records).toHaveLength(1)
  })

  it('emits exactly one summary and is idempotent', async () => {
    const sink = new MemorySink()
    const rec = new TelemetryRecorder({ sessionId: 's', config: { enabled: true }, sink })
    rec.observe(resultEvent())
    await rec.finish()
    await rec.finish()
    expect(sink.summaries).toHaveLength(1)
    expect(sink.closed).toBe(1)
    expect(sink.summaries[0]).toMatchObject({ outcome: 'success', costUsd: 0.5 })
  })

  it('stamps every record with the run id and schema version', async () => {
    const sink = new MemorySink()
    const rec = new TelemetryRecorder({ sessionId: 'sess-x', config: { enabled: true }, sink })
    rec.observe({ type: 'tool_use', id: '1', name: 'bash', input: {}, sessionId: 'sess-x' })
    await new Promise(r => setImmediate(r))
    expect(sink.records[0]).toMatchObject({
      runId: rec.runId, sessionId: 'sess-x', schemaVersion: EVENT_SCHEMA_VERSION,
    })
  })

  it('reports a schema violation once when validation is on', async () => {
    // This catches what the fixture test cannot: an emit site that builds an
    // event by hand and gets a field wrong.
    const errors: string[] = []
    const rec = new TelemetryRecorder({
      sessionId: 's',
      config: { enabled: true, validate: true },
      sink: new MemorySink(),
      onError: (_n, e) => errors.push(e.message),
    })
    const malformed = { type: 'tool_result', id: '1', toolName: 'x', content: 'y', sessionId: 's' } as unknown as KernelEvent
    rec.observe(malformed)
    rec.observe(malformed)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('isError')
  })

  it('stays silent about schema violations when validation is off', () => {
    const errors: string[] = []
    const rec = new TelemetryRecorder({
      sessionId: 's', config: { enabled: true }, sink: new MemorySink(),
      onError: (_n, e) => errors.push(e.message),
    })
    rec.observe({ type: 'tool_result', id: '1' } as unknown as KernelEvent)
    expect(errors).toHaveLength(0)
  })

  it('never throws out of observe(), whatever the sink does', () => {
    // observe() runs inside the session's event loop. A telemetry fault must
    // degrade the record, never the run.
    const rec = new TelemetryRecorder({
      sessionId: 's',
      config: { enabled: true },
      sink: {
        name: 'explosive',
        record: () => { throw new Error('sync boom') },
        summary: async () => { throw new Error('boom') },
        close: async () => { throw new Error('boom') },
      },
    })
    expect(() => rec.observe(resultEvent())).not.toThrow()
  })

  it('never throws out of finish(), whatever the sink does', async () => {
    const rec = new TelemetryRecorder({
      sessionId: 's',
      config: { enabled: true },
      sink: {
        name: 'explosive',
        record: async () => {},
        summary: async () => { throw new Error('boom') },
        close: async () => { throw new Error('boom') },
      },
    })
    await expect(rec.finish()).resolves.toBeUndefined()
  })
})
