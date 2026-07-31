import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Counters for the blind spot this design knowingly creates.
 *
 * Two decisions traded strictness for throughput: verdicts are carried forward
 * without a final full re-review, and `out_of_scope` does not block. Each is
 * defensible on its own; together they open one specific path where a
 * constraint is waved through and then frozen, with nothing reporting it.
 *
 * The mitigation is not another gate — it is that the path is counted. Shipping
 * the ratchet without these numbers would mean the two decisions were never
 * really made, only assumed. `oosCarried` is the direct count of the compound
 * case and should be zero; anything else is read by hand.
 */
export interface DistillTraceStats {
  /** Verdicts reused instead of re-adjudicated. High is the intended effect. */
  carried: number
  /** Constraint-rounds that reached the reviewer at all. */
  adjudicated: number
  /** `carried / (carried + adjudicated)`, or 0 when nothing was decided. */
  carriedRatio: number
  /** `out_of_scope` used on a graph- or reviewer-locus constraint. */
  outOfScopeEscapes: number
  /** Escapes that were then carried forward — the compound blind spot. */
  oosCarried: number
  /** Blocking control-flow claims demoted for lacking a usable witness. */
  unwitnessedDemotions: number
  reviewRounds: number
}

interface TraceEvent {
  phase?: string
  outcome?: string
  constraintId?: string
  outOfScope?: boolean
  issues?: string[]
  advisories?: string[]
}

export function emptyDistillTraceStats(): DistillTraceStats {
  return {
    carried: 0, adjudicated: 0, carriedRatio: 0, outOfScopeEscapes: 0,
    oosCarried: 0, unwitnessedDemotions: 0, reviewRounds: 0,
  }
}

/** Fold one run's `timeline.jsonl` into the counters. */
export function summarizeDistillTraceEvents(events: readonly TraceEvent[]): DistillTraceStats {
  const stats = emptyDistillTraceStats()
  const escaped = new Set<string>()
  for (const event of events) {
    if (event.phase !== 'semantic_review') continue
    if (event.outcome === 'verdict_carried') {
      stats.carried++
      if (event.outOfScope === true) stats.oosCarried++
      continue
    }
    if (event.outcome === 'out_of_scope_escape') {
      stats.outOfScopeEscapes++
      if (event.constraintId) escaped.add(event.constraintId)
      continue
    }
    if (event.outcome === 'accepted' || event.outcome === 'rejected') {
      stats.reviewRounds++
      stats.unwitnessedDemotions += (event.issues ?? []).concat(event.advisories ?? [])
        .filter(issue => issue.includes('unwitnessed-control-flow')).length
    }
  }
  // Rounds are counted per review; adjudicated constraint-rounds are whatever
  // was not carried. The trace does not record scope size directly, so this
  // stays a lower bound rather than pretending to precision it does not have.
  stats.adjudicated = Math.max(0, stats.reviewRounds)
  const decided = stats.carried + stats.adjudicated
  stats.carriedRatio = decided ? Number((stats.carried / decided).toFixed(3)) : 0
  return stats
}

export async function readDistillTraceStats(runDir: string): Promise<DistillTraceStats> {
  const raw = await readFile(resolve(runDir, 'timeline.jsonl'), 'utf8').catch(() => '')
  const events: TraceEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line) as TraceEvent) } catch { /* a torn final line is not worth failing over */ }
  }
  return summarizeDistillTraceEvents(events)
}

/** Aggregate every run under `.loop/distill/`, for offline analysis. */
export async function readAllDistillTraceStats(projectDir: string): Promise<Array<{ run: string; stats: DistillTraceStats }>> {
  const root = resolve(projectDir, '.loop', 'distill')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const runs = entries.filter(entry => entry.isDirectory() && entry.name.startsWith('run-')).map(entry => entry.name).sort()
  const out: Array<{ run: string; stats: DistillTraceStats }> = []
  for (const run of runs) out.push({ run, stats: await readDistillTraceStats(resolve(root, run)) })
  return out
}

export function formatDistillTraceStats(stats: DistillTraceStats): string {
  const parts = [
    `review rounds=${stats.reviewRounds}`,
    `carried=${stats.carried} (ratio ${stats.carriedRatio})`,
    `out-of-scope escapes=${stats.outOfScopeEscapes}`,
    `carried-while-out-of-scope=${stats.oosCarried}`,
    `unwitnessed demotions=${stats.unwitnessedDemotions}`,
  ]
  // The compound case is the one number worth interrupting someone for.
  const warning = stats.oosCarried > 0
    ? '\n  warning: 有约束既被判为 out_of_scope 又被棘轮沿用——它从未被真正核验过，请人工复核上述 constraintId。'
    : ''
  return `review convergence: ${parts.join(', ')}${warning}`
}
