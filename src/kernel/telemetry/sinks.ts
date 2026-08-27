/**
 * Telemetry sinks — JSONL (primary) and OTLP/HTTP (optional).
 *
 * The invariant every sink here obeys: **a sink never throws into the run**.
 * Telemetry observes the work; it does not get to fail the work. Every method
 * catches its own errors and, at most, reports them once through `onError`.
 * A sink that propagated an ENOSPC would turn "the disk filled up" into "the
 * overnight run died", which is strictly worse than losing the telemetry.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { TelemetryRecord, TelemetrySink, TelemetrySummary } from './types.js'
import { redactSecrets } from '../../infra/redaction/secretRedaction.js'

export interface SinkOptions {
  /** Called at most once per distinct failure, for diagnostics. */
  onError?: (sink: string, error: Error) => void
}

/**
 * Append-only JSONL on local disk.
 *
 * One file per UTC day rather than per run: the questions being asked span runs
 * ("last week's 200 runs"), and a directory with 200 files is harder to grep
 * than seven. Records and summaries go to separate files because they are read
 * for different purposes — summaries are the queryable index, records are the
 * detail you open when a summary looks wrong.
 */
export class JsonlTelemetrySink implements TelemetrySink {
  readonly name = 'jsonl'
  private reportedError = false

  constructor(
    private readonly dir: string,
    private readonly options: SinkOptions = {},
  ) {}

  private async append(file: string, line: string): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
      await appendFile(join(this.dir, file), `${line}\n`, 'utf-8')
    } catch (err) {
      this.report(err)
    }
  }

  private report(err: unknown): void {
    // Once per sink instance: a failing disk fails on EVERY event, and a
    // per-event warning would bury the run's real output in noise.
    if (this.reportedError) return
    this.reportedError = true
    this.options.onError?.(this.name, err instanceof Error ? err : new Error(String(err)))
  }

  private static day(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10)
  }

  async record(record: TelemetryRecord): Promise<void> {
    await this.append(`events-${JsonlTelemetrySink.day(record.ts)}.jsonl`, serialise(record))
  }

  async summary(summary: TelemetrySummary): Promise<void> {
    await this.append(`runs-${JsonlTelemetrySink.day(summary.ts)}.jsonl`, serialise(summary))
  }

  async close(): Promise<void> {
    // appendFile opens and closes per call, so there is nothing held open.
    // The method exists because the interface promises it, and because a
    // buffered implementation would need it.
  }
}

/**
 * Serialise one record.
 *
 * Two things happen here that are easy to forget and expensive to omit:
 *
 * 1. **Redaction.** Tool results carry command output, and command output
 *    carries tokens. `runShellCommand` already redacts what it returns, but
 *    telemetry is a SECOND destination for the same bytes and a longer-lived
 *    one — a transcript that lives for a day in a log file is a bigger exposure
 *    than one that lives for a turn in a context window.
 * 2. **Cycle tolerance.** Tool inputs are `unknown` and arrive from a model;
 *    a structure JSON.stringify cannot handle must degrade to a note, not
 *    throw inside a sink.
 */
function serialise(value: unknown): string {
  try {
    return redactSecrets(JSON.stringify(value))
  } catch {
    return JSON.stringify({ error: 'telemetry record was not serialisable' })
  }
}

/**
 * OTLP/HTTP log exporter.
 *
 * Deliberately hand-rolled against the OTLP JSON protocol rather than pulling
 * in `@opentelemetry/*`: that dependency tree is large, and this runtime ships
 * three runtime dependencies on purpose. What is needed here — POST a batch of
 * log records as JSON — is a `fetch` call and a shape.
 *
 * Records are batched and flushed on a size threshold or at close, because one
 * HTTP round-trip per event would make the exporter slower than the work it is
 * measuring.
 */
export class OtlpTelemetrySink implements TelemetrySink {
  readonly name = 'otlp'
  private buffer: unknown[] = []
  private reportedError = false
  /**
   * P2-7 (review 2026-08-27): single-flight write chain.
   *
   * `flush()` used to `await fetch()` with no coordination, and the Recorder
   * calls `record()` fire-and-forget. Against a wedged collector — one that
   * accepts the connection and never responds — every batch threshold started
   * ANOTHER request that never settled. Requests, their payload strings and
   * their closures accumulated for the life of the process, and `finish()`
   * could block forever waiting on the summary flush.
   *
   * All writes now queue behind this chain: at most one request is ever in
   * flight, and `close()` has one thing to await.
   */
  private inFlight: Promise<void> = Promise.resolve()
  /** Batches waiting for the chain; bounded by `maxPendingBatches`. */
  private pending: unknown[][] = []
  private droppedBatches = 0

  constructor(
    private readonly endpoint: string,
    private readonly headers: Record<string, string> = {},
    private readonly options: SinkOptions & {
      batchSize?: number
      /** Per-request wall-clock budget. A collector that never answers must not pin us. */
      requestTimeoutMs?: number
      /** How many batches may wait behind a slow collector before we shed load. */
      maxPendingBatches?: number
    } = {},
  ) {}

  private get batchSize(): number {
    return this.options.batchSize ?? 64
  }

  /**
   * 10s: long enough for a loaded collector on a slow link, short enough that a
   * wedged one cannot hold a request open across a whole session.
   */
  private get requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? 10_000
  }

  /**
   * Telemetry is not worth unbounded memory. Past this many queued batches the
   * OLDEST are dropped — with a slow collector the recent events are the ones
   * describing what is currently going wrong.
   */
  private get maxPendingBatches(): number {
    return this.options.maxPendingBatches ?? 32
  }

  async record(record: TelemetryRecord): Promise<void> {
    this.buffer.push(this.toLogRecord(record.ts, 'event', record))
    if (this.buffer.length >= this.batchSize) await this.flush()
  }

  async summary(summary: TelemetrySummary): Promise<void> {
    this.buffer.push(this.toLogRecord(summary.ts, 'summary', summary))
    // Summaries are the payload people actually query, and there is exactly one
    // per run — flush immediately rather than risking it sitting in a buffer
    // that a crash would discard.
    await this.flush()
  }

  private toLogRecord(ts: number, kind: string, body: unknown): unknown {
    return {
      timeUnixNano: String(BigInt(ts) * 1_000_000n),
      severityText: 'INFO',
      body: { stringValue: serialise(body) },
      attributes: [
        { key: 'meta_agent.kind', value: { stringValue: kind } },
      ],
    }
  }

  /**
   * Hand the current buffer to the write chain and wait for the queue to drain.
   *
   * Awaiting the chain (rather than just this batch) is what makes `close()`
   * and `summary()` correct: when they return, nothing is still queued.
   */
  async flush(): Promise<void> {
    if (this.buffer.length > 0) {
      this.enqueue(this.buffer)
      this.buffer = []
    }
    await this.inFlight
  }

  /** Queue a batch, shedding the oldest if the collector has fallen behind. */
  private enqueue(batch: unknown[]): void {
    this.pending.push(batch)
    while (this.pending.length > this.maxPendingBatches) {
      this.pending.shift()
      this.droppedBatches++
    }
    this.inFlight = this.inFlight.then(() => this.drain())
  }

  /** Send whatever is queued, one request at a time. */
  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.shift()!
      await this.send(batch)
    }
    if (this.droppedBatches > 0) {
      const dropped = this.droppedBatches
      this.droppedBatches = 0
      this.report(new Error(
        `OTLP exporter dropped ${dropped} batch(es): collector could not keep up ` +
        `(max ${this.maxPendingBatches} batches queued)`,
      ))
    }
  }

  private async send(batch: unknown[]): Promise<void> {
    const payload = {
      resourceLogs: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'meta-agent' } },
          ],
        },
        scopeLogs: [{ logRecords: batch }],
      }],
    }
    // P2-7: `fetch()` had no AbortSignal, so a collector that accepted the
    // connection and went silent held the request open indefinitely.
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.requestTimeoutMs)
    timer.unref?.()
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      })
      if (!res.ok) this.report(new Error(`OTLP endpoint returned ${res.status}`))
      // Drain the body even on success: an undrained response body keeps the
      // socket (and its buffers) alive under keep-alive.
      await res.arrayBuffer().catch(() => undefined)
    } catch (err) {
      if (ctrl.signal.aborted) {
        this.report(new Error(`OTLP request exceeded ${this.requestTimeoutMs}ms and was aborted`))
      } else {
        this.report(err)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private report(err: unknown): void {
    if (this.reportedError) return
    this.reportedError = true
    this.options.onError?.(this.name, err instanceof Error ? err : new Error(String(err)))
  }

  async close(): Promise<void> {
    await this.flush()
  }
}

/** Fan out to several sinks; one sink's failure never affects another. */
export class MultiSink implements TelemetrySink {
  readonly name = 'multi'
  constructor(private readonly sinks: readonly TelemetrySink[]) {}

  async record(record: TelemetryRecord): Promise<void> {
    await Promise.all(this.sinks.map(s => s.record(record)))
  }

  async summary(summary: TelemetrySummary): Promise<void> {
    await Promise.all(this.sinks.map(s => s.summary(summary)))
  }

  async close(): Promise<void> {
    await Promise.all(this.sinks.map(s => s.close()))
  }
}
