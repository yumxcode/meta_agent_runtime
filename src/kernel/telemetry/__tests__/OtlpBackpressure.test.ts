/**
 * Regression tests for P2-7 (review 2026-08-27): the OTLP exporter must bound
 * what a wedged collector can cost it.
 *
 * Before: `flush()` awaited a `fetch()` with no AbortSignal and no coordination
 * between calls. A collector that accepted connections and never answered
 * accumulated one un-settled request per batch threshold, each holding its
 * payload string and closure, and `finish()` could block forever on the summary
 * flush.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OtlpTelemetrySink } from '../sinks.js'
import type { TelemetryRecord } from '../types.js'

const ENDPOINT = 'http://127.0.0.1:9/v1/logs'   // discard port; never contacted

function record(i: number): TelemetryRecord {
  return {
    schemaVersion: 1,
    ts: 1_700_000_000_000 + i,
    runId: 'run-1',
    sessionId: 'session-1',
    event: { type: 'test.event', index: i },
  } as unknown as TelemetryRecord
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response
}

describe('OtlpTelemetrySink single-flight (P2-7)', () => {
  it('never has more than one request in flight', async () => {
    let inFlight = 0
    let peak = 0
    fetchMock.mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return okResponse()
    })

    const sink = new OtlpTelemetrySink(ENDPOINT, {}, { batchSize: 2 })
    // 10 records at batchSize 2 = 5 batches, all pushed without awaiting —
    // exactly the fire-and-forget pattern the Recorder uses.
    const writes = Array.from({ length: 10 }, (_, i) => sink.record(record(i)))
    await Promise.all(writes)
    await sink.close()

    expect(peak).toBe(1)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
  })

  it('aborts a request that outlives its timeout', async () => {
    let sawAbort = false
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      // A collector that accepts the connection and never answers.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          sawAbort = true
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    })

    const errors: Error[] = []
    const sink = new OtlpTelemetrySink(ENDPOINT, {}, {
      batchSize: 1,
      requestTimeoutMs: 50,
      onError: (_name, err) => errors.push(err),
    })

    await sink.record(record(0))
    await sink.close()

    expect(sawAbort).toBe(true)
    expect(errors[0]?.message).toMatch(/exceeded 50ms/)
  })

  it('close() resolves even when the collector never answers', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    )

    const sink = new OtlpTelemetrySink(ENDPOINT, {}, { batchSize: 1, requestTimeoutMs: 50 })
    await sink.record(record(0))

    // The defect: this hung. Race it so a regression fails rather than stalls.
    const outcome = await Promise.race([
      sink.close().then(() => 'closed'),
      new Promise<string>(r => setTimeout(() => r('hung'), 2_000)),
    ])
    expect(outcome).toBe('closed')
  })

  it('sheds the oldest batches instead of queueing without bound', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(r => { release = r })
    let calls = 0
    fetchMock.mockImplementation(async () => {
      calls++
      await gate
      return okResponse()
    })

    const errors: Error[] = []
    const sink = new OtlpTelemetrySink(ENDPOINT, {}, {
      batchSize: 1,
      maxPendingBatches: 4,
      onError: (_name, err) => errors.push(err),
    })

    // 40 batches against a stalled collector. Unbounded queueing was the
    // memory-growth half of P2-7.
    for (let i = 0; i < 40; i++) void sink.record(record(i))
    release?.()
    await sink.close()

    // One in-flight plus at most maxPendingBatches queued — nowhere near 40.
    expect(calls).toBeLessThanOrEqual(6)
    expect(errors.some(e => /dropped \d+ batch/.test(e.message))).toBe(true)
  })

  it('reports a non-2xx response without throwing at the caller', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response)

    const errors: Error[] = []
    const sink = new OtlpTelemetrySink(ENDPOINT, {}, {
      batchSize: 1,
      onError: (_n, err) => errors.push(err),
    })

    await expect(sink.record(record(0))).resolves.toBeUndefined()
    await sink.close()
    expect(errors[0]?.message).toMatch(/503/)
  })

  it('delivers records in order through the chain', async () => {
    const bodies: string[] = []
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      await new Promise(r => setTimeout(r, 2))
      return okResponse()
    })

    const sink = new OtlpTelemetrySink(ENDPOINT, {}, { batchSize: 1 })
    for (let i = 0; i < 5; i++) void sink.record(record(i))
    await sink.close()

    // The event is JSON-serialised into a stringValue and the payload is then
    // serialised again, so the field name arrives backslash-escaped.
    const order = bodies.map(b => {
      const m = /"index":(\d+)/.exec(b.replace(/\\/g, ''))
      return m ? Number(m[1]) : -1
    })
    expect(order).toEqual([0, 1, 2, 3, 4])
  })
})
