/**
 * Verdict — the unified verdict the auto_orch loop and graph both consume.
 *
 * Today drift and verify each return their own shape (DriftVerdict / VerifyVerdict)
 * and the kernel acts on each with bespoke branches. For orchestration we need a
 * SINGLE verdict type that:
 *   • a phase hook / role agent can return, and
 *   • an edge condition in the plan graph can branch on.
 *
 * The action set is deliberately tiny and closed — the same five things the loop
 * can already do — so a verdict can never ask the engine to do something
 * un-auditable:
 *   • continue — nothing to do, proceed;
 *   • inject   — append meta guidance, then proceed (drift correction style);
 *   • reject   — the executor's "done" is rejected; re-injects unfinished items;
 *   • branch   — node finished with a labelled outcome the graph routes on;
 *   • done     — this node/role is satisfied; the orchestrator may advance/stop;
 *   • abort    — terminate the run; clean by default, failed when data.failed=true or label='error'/'failed'.
 *
 * `label` is the routing key for `branch` (and may annotate any verdict); it is
 * how a node's outcome selects an outgoing edge (e.g. 'pass' vs 'fail').
 */

/** The closed set of actions a verdict can request. */
export type VerdictAction = 'continue' | 'inject' | 'reject' | 'branch' | 'done' | 'abort'

/** A unified, engine-agnostic verdict. */
export interface OrchVerdict {
  /** What the engine should do with this verdict. */
  action: VerdictAction
  /** Routing key for `branch` edges; may annotate any verdict for observability. */
  label?: string
  /** Meta messages to inject (used by `inject` / `reject`). */
  messages?: string[]
  /** Evidence the producer cites (file:line, command + exit code, …). */
  evidence?: string[]
  /** Free-text note; never load-bearing for engine decisions. */
  note?: string
  /**
   * True when the producer did NOT actually run (missing inputs, spawn/timeout,
   * internal error). The engine treats a skipped verdict as fail-open `continue`.
   */
  skipped?: boolean
  /** Opaque producer payload, surfaced to observability only. */
  data?: Record<string, unknown>
}

/** A `continue` verdict — the fail-open / no-op default. */
export function continueVerdict(note?: string): OrchVerdict {
  return { action: 'continue', note }
}

/**
 * A `skipped` verdict — the gate did not actually run (unavailable / unparsable).
 * Flagged so the host can observe it; `gateKind` lets PlanRunner decide whether
 * the skip must fail-closed (verify / review gates) or may continue (advisory
 * drift). Defaults to no kind, which PlanRunner treats as fail-closed.
 */
export function skippedVerdict(note?: string, gateKind?: string): OrchVerdict {
  return { action: 'continue', skipped: true, note, data: gateKind ? { gateKind } : undefined }
}

// ── Adapters from the legacy gate verdicts ─────────────────────────────────────
// These let the existing drift/verify agents plug into the orchestration engine
// without rewriting them: their DriftVerdict / VerifyVerdict map onto OrchVerdict.

/** Minimal shape of a drift verdict (avoids importing the kernel gate type). */
export interface DriftVerdictLike {
  drifted: boolean
  severity?: 'minor' | 'major'
  corrective: string[]
  note?: string
  skipped?: boolean
}

/** Minimal shape of a verify verdict. */
export interface VerifyVerdictLike {
  done: boolean
  unfinished: string[]
  evidence?: string[]
  note?: string
  skipped?: boolean
}

/** Map a drift verdict onto the unified verdict. */
export function fromDrift(v: DriftVerdictLike): OrchVerdict {
  if (v.skipped) return skippedVerdict(v.note, 'drift')
  if (!v.drifted) return continueVerdict(v.note)
  return {
    action: 'inject',
    label: v.severity === 'major' ? 'drift_major' : 'drift_minor',
    messages: v.corrective,
    note: v.note,
  }
}

/** Map a verify verdict onto the unified verdict. */
export function fromVerify(v: VerifyVerdictLike): OrchVerdict {
  if (v.skipped) return skippedVerdict(v.note, 'verify')
  if (v.done) return { action: 'done', label: 'pass', evidence: v.evidence, note: v.note }
  return {
    action: 'reject',
    label: 'fail',
    messages: v.unfinished,
    evidence: v.evidence,
    note: v.note,
  }
}
