/**
 * Telemetry contracts — what gets recorded, and where it goes.
 *
 * The question this exists to answer
 * ----------------------------------
 * "Last week's 200 unattended runs: which tool failed most, which phase burned
 * the budget, how often did drift fire, what was the compaction ratio?"
 *
 * Today none of that is answerable. `CostTracker` is 18 lines that add up a
 * number, and `DebugWriter` dumps per-session transcripts for a human to read
 * one at a time. Neither aggregates, and neither survives in a form you can
 * query. For a runtime whose flagship mode is *unattended*, that is the wrong
 * gap to have: nobody is watching while it runs, so the record afterwards is
 * the only account of what happened.
 *
 * Design decisions worth stating
 * ------------------------------
 * **Default OFF.** Telemetry writes to disk. A runtime that starts logging
 * without being asked is a runtime that fills someone's disk and surprises
 * them. `telemetry.enabled` must be set explicitly.
 *
 * **JSONL is the primary sink, OTLP is optional.** The target user runs a robot
 * on one machine, not a Kubernetes cluster with a collector. Requiring an OTLP
 * endpoint before you can answer "which tool fails most" would mean nobody ever
 * answers it. A file you can `jq` needs no infrastructure at all.
 *
 * **Events are the frozen KernelEvent, not a parallel schema.** The whole point
 * of A2.1 was to make the event stream a contract; inventing a second, private
 * shape for telemetry would immediately re-open the gap it closed.
 */

import type { KernelEvent } from '../types/KernelEvent.js'

/**
 * One line in the telemetry stream.
 *
 * The envelope carries what the event deliberately does NOT: the schema version
 * (a property of the stream), wall-clock time, and the run identity. Keeping
 * these out of `KernelEvent` is what let the event union stay untouched.
 */
export interface TelemetryRecord {
  /** Contract version of `event` — see kernel/events/schema.ts. */
  schemaVersion: string
  /** Epoch ms when the record was produced. */
  ts: number
  /** Stable id for one `submitMessage()` run, so turns can be grouped. */
  runId: string
  /** Session id, duplicated out of the event for cheap filtering. */
  sessionId: string
  /** The frozen kernel event, verbatim. */
  event: KernelEvent
}

/** Aggregated counters for one run, emitted once at the end. */
export interface TelemetrySummary {
  schemaVersion: string
  ts: number
  runId: string
  sessionId: string
  /** Wall-clock duration of the run. */
  durationMs: number
  /** Terminal result subtype, when the run produced one. */
  outcome?: string
  costUsd: number
  numTurns: number
  usage: {
    inputTokens: number
    outputTokens: number
    cacheWriteTokens: number
    cacheReadTokens: number
  }
  /**
   * Per-tool call/error counts. The headline question — "which tool fails most"
   * — is a sort over this map, which is why it is recorded per NAME rather than
   * as a single failure rate.
   */
  tools: Record<string, { calls: number; errors: number }>
  /** How often each system-message subtype fired (drift/verify warnings live here). */
  systemMessages: Record<string, number>
  /** Compaction behaviour: frequency and how much it actually saved. */
  compaction: {
    started: number
    completed: number
    failed: number
    /** Total tokens before compaction, summed across boundaries. */
    previousTokens: number
    /** Total summary tokens produced. */
    summaryTokens: number
    /** summaryTokens / previousTokens; 0 when nothing was compacted. */
    ratio: number
  }
  /** API retries, and the statuses that caused them. */
  apiRetries: { total: number; byStatus: Record<string, number> }
  /** Permission denials by tool name. */
  permissionDenials: Record<string, number>
}

/**
 * Where telemetry goes.
 *
 * Every method returns a promise and every implementation must swallow its own
 * failures: a telemetry sink that throws would take down the run it was only
 * observing, which inverts the entire point of observability.
 */
export interface TelemetrySink {
  /** Short name, used in diagnostics. */
  readonly name: string
  record(record: TelemetryRecord): Promise<void>
  summary(summary: TelemetrySummary): Promise<void>
  /** Flush and release resources. Safe to call more than once. */
  close(): Promise<void>
}

export interface TelemetryConfig {
  /** Master switch. Absent or false = no telemetry at all, no files touched. */
  enabled?: boolean
  /**
   * Directory for JSONL output. Default: `<META_AGENT_HOME>/telemetry`.
   * The JSONL sink is on whenever telemetry is enabled unless `jsonl: false`.
   */
  dir?: string
  /** Disable the JSONL sink (e.g. when only OTLP is wanted). Default: true. */
  jsonl?: boolean
  /**
   * OTLP/HTTP endpoint. Absent = no OTLP export.
   * Optional by design — see the module header.
   */
  otlpEndpoint?: string
  /** Extra headers for the OTLP request (auth tokens, tenant ids). */
  otlpHeaders?: Record<string, string>
  /**
   * Record every event, or only the ones that carry aggregate signal.
   *
   * Default 'summary': text/thinking deltas are the overwhelming majority of
   * events by count and carry the model's raw output — high volume, high
   * sensitivity, and no aggregate value. 'full' includes them and is for
   * debugging a specific run, not for standing collection.
   */
  detail?: 'summary' | 'full'
  /**
   * Validate each event against the frozen schema before recording, and report
   * violations. Default: false — this is a self-check for the runtime's own
   * development, not something a user's run should pay for per event.
   */
  validate?: boolean
}

/** Event types with no aggregate value, excluded unless `detail: 'full'`. */
export const HIGH_VOLUME_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text_delta',
  'thinking_delta',
])
