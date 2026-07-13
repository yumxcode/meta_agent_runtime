/**
 * CharterTypes — the declarative contract a loop runs under (spec §3.1, D1).
 *
 * A charter is DATA. The kernel is its only interpreter. Everything the
 * business hand-writes (thresholds, routing, acceptance, wait policies)
 * lives here; everything intelligent lives in seat prompts. What gets
 * saved/reused/versioned across runs is exactly this object.
 */
import type { Ast } from '../expr/Expr.js'

/**
 * Where an observable's value is collected from each round (spec §3.1).
 *
 * ONLY `judge` is wired: `collectObservables` reads the value from the judge's
 * return_result `data[key]`. Other sources (ledger/meter) were declared but never
 * implemented, so they are NOT part of the contract — a charter that uses them
 * would silently produce an unpopulated observable (dead tripwires/meters). If a
 * new source is ever added, wire it in `collectObservables`, extend this union,
 * AND allow it in `validateCharter` together — the validator is the source of
 * truth for what the kernel can actually honor.
 *
 * `key` may be one of the kernel's core judge keys (JUDGE_CORE_KEYS in Seats.ts)
 * or a charter-invented extra key: every declared key is INJECTED into the
 * JUDGE_CONTRACT the kernel appends to the judge prompt, so the judge is always
 * required to emit it. The kernel — not the charter prompt — owns the judge's
 * output schema; the charter's judge rubric defines the SEMANTICS of extra keys.
 */
export type ObservableSource =
  | { from: 'judge'; key: string }              // judge return_result data field

export interface ObservableSpec {
  name: string
  source: ObservableSource
}

export interface MeterSpec {
  name: string
  /** `inc: 'every_round'` for iteration-style counters. */
  inc?: 'every_round'
  incWhen?: string
  resetWhen?: string
}

/**
 * Tripwire action — a discriminated union so that meaningless combinations are
 * UNREPRESENTABLE (v3 redesign). Exactly three actions exist, each mapping to
 * exactly one kernel behavior at ROUTE:
 *
 *   pivot    — schedule the NEXT round as a pivot round (one-shot directive;
 *              the pivoter seat runs and its directive is injected into the
 *              worker capsule). Requires seats.pivoter (validated).
 *   finalize — end the loop gracefully: optional finalizer seat writes the
 *              narrative, final_report.md is rendered, instance → done.
 *   escalate — pause for a human: attention_report.md is rendered, wakes are
 *              cancelled, instance → paused_attention. `onResume.resetMeters`
 *              names the meters reset when a human re-arms (defaults to the
 *              meters referenced by the fired tripwire's expression, so the
 *              same tripwire cannot re-fire instantly after resume).
 *
 * Termination is owned by the kernel two ways regardless of tripwires:
 * lifetime-budget exhaustion and judge acceptance (goal_satisfied) both
 * finalize. Tripwires own everything situational.
 */
export type TripwireAction =
  | { act: 'pivot' }
  | { act: 'finalize'; reason?: string }
  | { act: 'escalate'; reason: string; onResume?: { resetMeters: string[] } }

/**
 * Pre-v3 action shape ({mode?, escalate?, stop?}). Accepted ONLY through
 * `normalizeCharter` (create/load-time migration); the kernel never sees it.
 */
export interface LegacyTripwireAction {
  mode?: 'pivot' | 'finalize' | 'attention'
  escalate?: string
  stop?: boolean
}

export interface TripwireSpec {
  when: string
  then: TripwireAction
}

export type ShapeSpec =
  | {
      type: 'object'
      required?: string[]
      properties?: Record<string, ShapeSpec>
      additionalProperties?: boolean
    }
  | { type: 'array'; minItems?: number; items?: ShapeSpec }
  | { type: 'string'; minLength?: number; enum?: string[] }
  | { type: 'number'; minimum?: number; maximum?: number }
  | { type: 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'null' }

export type GateSpec =
  | { kind: 'schema'; files: string[]; /** Optional only for loading legacy frozen charters. */ spec?: ShapeSpec }
  | { kind: 'judge'; evidence: string[]; rubric: string }

export type SeatContext = 'lineage_round' | 'lineage_loop' | 'isolated'

export interface SeatSpec {
  /** D5/D6: worker defaults lineage_round, judge/pivoter isolated. */
  context: SeatContext
  prompt: string
  tools?: string[]
  /**
   * Per-SEGMENT circuit breakers for a seat call. `wallclockMin` sets the seat's
   * wall-clock cap in minutes (default 30). A research submit segment (read +
   * design + implement + submit) can need more; the long wait BETWEEN segments
   * is free because the process is dead while parked.
   */
  budgetPerRound?: { usd?: number; turns?: number; wallclockMin?: number }
  /** Evidence whitelist for isolated seats (paths relative to stateRoot). */
  inputs?: string[]
}

export interface BudgetSpec {
  perRound?: { usd?: number }
  lifetime?: { rounds?: number; usd?: number; deadlineMs?: number }
}

export interface Charter {
  id: string
  version: number
  goal: string
  /** Optimization direction for judge.data.metric. Default max for legacy charters. */
  metric?: { direction: 'max' | 'min' }
  observables: ObservableSpec[]
  meters: MeterSpec[]
  tripwires: TripwireSpec[]
  gates: Record<string, GateSpec>
  seats: {
    worker: SeatSpec
    judge?: SeatSpec
    pivoter?: SeatSpec
    /** Runs ONCE on graceful finalize to write the report's narrative section. */
    finalizer?: SeatSpec
  }
  /**
   * Health rule for progress.status on continue rounds: staleWhen true → 'stale',
   * else 'healthy'. Absent: falls back to the `stale_count > 0` convention when a
   * meter named stale_count exists, else always 'healthy'.
   */
  health?: { staleWhen: string }
  budgets?: BudgetSpec
  /** repo write scope for the worker seat (D8); empty = state-only loop. */
  writeScope?: string[]
  /** Cadence of the next-round timer, ms after a round ends. Default 0 = immediate. */
  roundIntervalMs?: number
}

/** Charter after create-time freezing: every expression parsed to an AST. */
export interface FrozenCharter extends Charter {
  frozen: {
    meterAsts: Record<string, { incWhen?: Ast; resetWhen?: Ast }>
    tripwireAsts: Ast[]
    /** Parsed charter.health.staleWhen, when declared. */
    healthAst?: Ast
    /** All identifiers the expressions may reference (audit). */
    declaredIdentifiers: string[]
    frozenAt: number
  }
}
