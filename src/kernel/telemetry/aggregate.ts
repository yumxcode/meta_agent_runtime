/**
 * TelemetryAggregator — turns an event stream into the numbers you actually ask
 * for.
 *
 * The raw stream answers "what happened, in order". The questions that matter
 * for an unattended runtime are all AGGREGATES over it — which tool fails most,
 * how often compaction fired and what it saved, how many retries and against
 * which status. Computing those at read time would mean every consumer
 * reimplements the same folds over a multi-megabyte JSONL file, and would make
 * the headline question ("which tool failed most last week") a scripting task
 * rather than a lookup.
 *
 * So the fold happens once, here, while the events go by, and lands as one
 * summary line per run.
 *
 * This class is deliberately pure bookkeeping: no I/O, no clock beyond the
 * timestamps it is handed, no failure modes. That makes it trivially testable,
 * which matters because a wrong counter is worse than no counter — it produces
 * confident answers that are false.
 */

import type { KernelEvent } from '../types/KernelEvent.js'
import type { TelemetrySummary } from './types.js'
import { EVENT_SCHEMA_VERSION } from '../events/schema.js'

export class TelemetryAggregator {
  private readonly startedAt: number
  private outcome: string | undefined
  private costUsd = 0
  private numTurns = 0
  private usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  }

  private readonly tools = new Map<string, { calls: number; errors: number }>()
  private readonly systemMessages = new Map<string, number>()
  private readonly retryByStatus = new Map<string, number>()
  private readonly denialsByTool = new Map<string, number>()

  private compactStarted = 0
  private compactCompleted = 0
  private compactFailed = 0
  private previousTokens = 0
  private summaryTokens = 0
  private apiRetries = 0

  /**
   * `tool_use` carries the name, `tool_result` carries it too — but only the
   * id is guaranteed to line them up. Keeping the map lets a result be
   * attributed even if a future event shape drops the redundant name.
   */
  private readonly toolNameById = new Map<string, string>()

  constructor(
    private readonly runId: string,
    private readonly sessionId: string,
    now: number = Date.now(),
  ) {
    this.startedAt = now
  }

  /** Fold one event into the running counters. */
  observe(event: KernelEvent): void {
    switch (event.type) {
      case 'tool_use': {
        this.toolNameById.set(event.id, event.name)
        this.bumpTool(event.name, 'calls')
        break
      }
      case 'tool_result': {
        // Prefer the id→name mapping: `toolName` on the result is the same
        // value today, and the map is what keeps this correct if that ever
        // stops being true.
        const name = this.toolNameById.get(event.id) ?? event.toolName
        if (event.isError) this.bumpTool(name, 'errors')
        break
      }
      case 'compact_start':
        this.compactStarted++
        break
      case 'compact_boundary':
        this.compactCompleted++
        this.previousTokens += event.compactMetadata.previousTokens
        this.summaryTokens += event.compactMetadata.summaryTokens
        break
      case 'compact_failed':
        this.compactFailed++
        break
      case 'api_retry': {
        this.apiRetries++
        // `null` means a transport-level failure with no HTTP status — a
        // distinct and interesting bucket, not a missing value to drop.
        const key = event.errorStatus === null ? 'network' : String(event.errorStatus)
        this.retryByStatus.set(key, (this.retryByStatus.get(key) ?? 0) + 1)
        break
      }
      case 'system_message':
        this.systemMessages.set(
          event.subtype,
          (this.systemMessages.get(event.subtype) ?? 0) + 1,
        )
        break
      case 'result': {
        this.outcome = event.subtype
        this.costUsd = event.costUsd
        this.numTurns = event.numTurns
        this.usage = { ...event.usage }
        for (const denial of event.permissionDenials ?? []) {
          this.denialsByTool.set(
            denial.toolName,
            (this.denialsByTool.get(denial.toolName) ?? 0) + 1,
          )
        }
        break
      }
      default:
        // text_delta / thinking_delta / tool_use_summary carry no aggregate
        // signal. Listed explicitly by omission rather than filtered upstream,
        // so adding an event type shows up here as a decision to make.
        break
    }
  }

  private bumpTool(name: string, field: 'calls' | 'errors'): void {
    const entry = this.tools.get(name) ?? { calls: 0, errors: 0 }
    entry[field]++
    this.tools.set(name, entry)
  }

  /** Snapshot the counters as the run's summary line. */
  build(now: number = Date.now()): TelemetrySummary {
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      ts: now,
      runId: this.runId,
      sessionId: this.sessionId,
      durationMs: Math.max(0, now - this.startedAt),
      ...(this.outcome !== undefined ? { outcome: this.outcome } : {}),
      costUsd: this.costUsd,
      numTurns: this.numTurns,
      usage: { ...this.usage },
      tools: Object.fromEntries(
        [...this.tools.entries()].map(([name, v]) => [name, { ...v }]),
      ),
      systemMessages: Object.fromEntries(this.systemMessages),
      compaction: {
        started: this.compactStarted,
        completed: this.compactCompleted,
        failed: this.compactFailed,
        previousTokens: this.previousTokens,
        summaryTokens: this.summaryTokens,
        // Guarded: a run with no compaction must report 0, not NaN — a NaN
        // here poisons every downstream average silently.
        ratio: this.previousTokens > 0 ? this.summaryTokens / this.previousTokens : 0,
      },
      apiRetries: {
        total: this.apiRetries,
        byStatus: Object.fromEntries(this.retryByStatus),
      },
      permissionDenials: Object.fromEntries(this.denialsByTool),
    }
  }
}

/**
 * Fold a set of run summaries into the cross-run view.
 *
 * This is the "last week's 200 runs" query, implemented once here so that
 * answering it does not require anyone to write the fold themselves.
 */
export interface TelemetryRollup {
  runs: number
  totalCostUsd: number
  totalTurns: number
  outcomes: Record<string, number>
  /** Per tool, across all runs, sorted by error count descending. */
  toolFailures: { name: string; calls: number; errors: number; errorRate: number }[]
  compaction: { runsWithCompaction: number; averageRatio: number }
  apiRetries: { total: number; byStatus: Record<string, number> }
}

export function rollupSummaries(summaries: readonly TelemetrySummary[]): TelemetryRollup {
  const outcomes: Record<string, number> = {}
  const tools = new Map<string, { calls: number; errors: number }>()
  const byStatus: Record<string, number> = {}
  let totalCostUsd = 0
  let totalTurns = 0
  let retries = 0
  let runsWithCompaction = 0
  let ratioSum = 0

  for (const s of summaries) {
    totalCostUsd += s.costUsd
    totalTurns += s.numTurns
    if (s.outcome) outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1
    for (const [name, v] of Object.entries(s.tools)) {
      const entry = tools.get(name) ?? { calls: 0, errors: 0 }
      entry.calls += v.calls
      entry.errors += v.errors
      tools.set(name, entry)
    }
    retries += s.apiRetries.total
    for (const [status, n] of Object.entries(s.apiRetries.byStatus)) {
      byStatus[status] = (byStatus[status] ?? 0) + n
    }
    if (s.compaction.completed > 0) {
      runsWithCompaction++
      ratioSum += s.compaction.ratio
    }
  }

  return {
    runs: summaries.length,
    totalCostUsd,
    totalTurns,
    outcomes,
    toolFailures: [...tools.entries()]
      .map(([name, v]) => ({
        name,
        calls: v.calls,
        errors: v.errors,
        errorRate: v.calls > 0 ? v.errors / v.calls : 0,
      }))
      // Errors first, then rate — a tool that failed 40 times matters more than
      // one that failed its only call, and sorting by rate alone inverts that.
      .sort((a, b) => b.errors - a.errors || b.errorRate - a.errorRate),
    compaction: {
      runsWithCompaction,
      averageRatio: runsWithCompaction > 0 ? ratioSum / runsWithCompaction : 0,
    },
    apiRetries: { total: retries, byStatus },
  }
}
