/**
 * TelemetryRecorder — the single object a session holds to record a run.
 *
 * It owns the three things that must stay in step: the aggregator folding the
 * counters, the sink(s) receiving records, and the run identity tying them
 * together. Keeping them behind one object is what lets the call site in
 * `KernelSession.submitMessage` be three lines — `observe` per event, `finish`
 * at the end — instead of a wiring problem repeated at every emit point.
 *
 * Failure policy, restated because it is the property that matters most:
 * **nothing in here may throw into the run.** `observe()` is called inside the
 * event loop of a session that is doing real work; a telemetry fault must
 * degrade the record, never the run.
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { KernelEvent } from '../types/KernelEvent.js'
import { EVENT_SCHEMA_VERSION, validateKernelEvent } from '../events/schema.js'
import { TelemetryAggregator } from './aggregate.js'
import { JsonlTelemetrySink, MultiSink, OtlpTelemetrySink } from './sinks.js'
import {
  HIGH_VOLUME_EVENT_TYPES,
  type TelemetryConfig,
  type TelemetryRecord,
  type TelemetrySink,
} from './types.js'
import { META_AGENT_HOME } from '../../core/metaAgentHome.js'

export interface RecorderOptions {
  sessionId: string
  config: TelemetryConfig
  /** Injectable for tests; production passes nothing and gets the real sinks. */
  sink?: TelemetrySink
  onError?: (sink: string, error: Error) => void
  now?: () => number
}

export class TelemetryRecorder {
  readonly runId: string
  private readonly aggregator: TelemetryAggregator
  private readonly sink: TelemetrySink
  private readonly detail: 'summary' | 'full'
  private readonly validate: boolean
  private readonly now: () => number
  private readonly onError: ((sink: string, error: Error) => void) | undefined
  private finished = false
  /** Schema violations seen this run, reported once each. */
  private readonly reportedViolations = new Set<string>()
  /**
   * P2-7 (review 2026-08-27): the fire-and-forget writes started by `observe()`
   * were completely untracked, so `finish()` wrote the summary and closed the
   * sink while an unknown number of record writes were still in flight — losing
   * the tail of every run on a slow sink. This counts them so `finish()` can
   * drain first.
   *
   * A counter plus a barrier promise rather than a Set of promises: `observe()`
   * runs per event on a hot path, and this must not allocate a retained object
   * per event (which was the other half of the unbounded-growth complaint).
   */
  private inFlightRecords = 0
  private idleWaiters: Array<() => void> = []

  constructor(private readonly options: RecorderOptions) {
    this.runId = randomUUID()
    this.now = options.now ?? (() => Date.now())
    this.detail = options.config.detail ?? 'summary'
    this.validate = options.config.validate === true
    this.onError = options.onError
    this.aggregator = new TelemetryAggregator(this.runId, options.sessionId, this.now())
    this.sink = options.sink ?? buildSinks(options.config, options.onError)
  }

  /**
   * Fold one event and, when it carries standing value, persist it.
   *
   * The aggregator sees EVERY event regardless of `detail`: the counters are
   * the cheap part and dropping inputs to them would make the summary wrong,
   * which is worse than a bigger file. `detail` governs only what is written.
   */
  observe(event: KernelEvent): void {
    try {
      this.aggregator.observe(event)

      if (this.validate) this.checkSchema(event)
      if (this.detail !== 'full' && HIGH_VOLUME_EVENT_TYPES.has(event.type)) return

      const record: TelemetryRecord = {
        schemaVersion: EVENT_SCHEMA_VERSION,
        ts: this.now(),
        runId: this.runId,
        sessionId: this.options.sessionId,
        event,
      }
      // Fire-and-forget: awaiting a disk write per event would put I/O latency
      // on the path between the model and the user's terminal. Tracked, though,
      // so finish() can drain what is still in flight (P2-7).
      this.inFlightRecords++
      void this.sink.record(record)
        .catch(err => this.report(err))
        .finally(() => this.settleRecord())
    } catch (err) {
      this.report(err)
    }
  }

  private settleRecord(): void {
    this.inFlightRecords--
    if (this.inFlightRecords > 0) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  /**
   * Resolve once every record write started so far has settled.
   *
   * Bounded: a sink wedged forever must not stop the process from exiting, and
   * telemetry is never worth blocking shutdown over.
   */
  private async drainRecords(timeoutMs = 5_000): Promise<void> {
    if (this.inFlightRecords === 0) return
    const idle = new Promise<void>(resolve => this.idleWaiters.push(resolve))
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    })
    try {
      await Promise.race([idle, deadline])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Validate against the frozen contract.
   *
   * This checks the RUNTIME against its own published schema, so it catches the
   * case the fixture test cannot: an emit site that constructs an event by hand
   * and gets a field wrong. Off by default — it is a development self-check,
   * not something a user's run should pay for per event.
   */
  private checkSchema(event: KernelEvent): void {
    const result = validateKernelEvent(event)
    if (result.ok) return
    const key = `${event.type}:${result.errors.join('|')}`
    if (this.reportedViolations.has(key)) return
    this.reportedViolations.add(key)
    this.report(new Error(
      `event "${event.type}" does not match schema v${EVENT_SCHEMA_VERSION}: ${result.errors.join('; ')}`,
    ))
  }

  /** Emit the run summary and release the sinks. Idempotent. */
  async finish(): Promise<void> {
    if (this.finished) return
    this.finished = true
    // P2-7: drain the record writes observe() started before writing the
    // summary, so the summary is not ordered ahead of the events it summarises
    // and the sink is not closed out from under them.
    try {
      await this.drainRecords()
    } catch (err) {
      this.report(err)
    }
    try {
      await this.sink.summary(this.aggregator.build(this.now()))
    } catch (err) {
      this.report(err)
    }
    try {
      await this.sink.close()
    } catch (err) {
      this.report(err)
    }
  }

  /** The counters so far — used by tests and by an in-process consumer. */
  snapshot(): ReturnType<TelemetryAggregator['build']> {
    return this.aggregator.build(this.now())
  }

  private report(err: unknown): void {
    this.onError?.('telemetry', err instanceof Error ? err : new Error(String(err)))
  }
}

/** Default telemetry directory when the config does not name one. */
export function defaultTelemetryDir(): string {
  return join(META_AGENT_HOME, 'telemetry')
}

/**
 * Assemble the configured sinks.
 *
 * JSONL is on unless explicitly disabled, because a telemetry config that
 * enabled collection but wrote nowhere would be a silent no-op — the most
 * confusing possible outcome for someone who just turned it on.
 */
function buildSinks(
  config: TelemetryConfig,
  onError?: (sink: string, error: Error) => void,
): TelemetrySink {
  const sinks: TelemetrySink[] = []
  if (config.jsonl !== false) {
    sinks.push(new JsonlTelemetrySink(config.dir ?? defaultTelemetryDir(), { ...(onError ? { onError } : {}) }))
  }
  if (config.otlpEndpoint) {
    sinks.push(new OtlpTelemetrySink(
      config.otlpEndpoint,
      config.otlpHeaders ?? {},
      { ...(onError ? { onError } : {}) },
    ))
  }
  return sinks.length === 1 ? sinks[0]! : new MultiSink(sinks)
}

/**
 * Build a recorder, or `null` when telemetry is off.
 *
 * Returning null rather than a no-op recorder keeps the disabled path free of
 * per-event work: the caller's `?.observe()` compiles to a nullish check, not a
 * method call that discards its argument.
 */
export function createTelemetryRecorder(
  sessionId: string,
  config: TelemetryConfig | undefined,
  options: Omit<RecorderOptions, 'sessionId' | 'config'> = {},
): TelemetryRecorder | null {
  if (!config?.enabled) return null
  return new TelemetryRecorder({ sessionId, config, ...options })
}
