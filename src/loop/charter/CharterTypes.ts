/**
 * CharterTypes — the declarative contract a loop runs under (spec §3.1, D1).
 *
 * A charter is DATA. The kernel is its only interpreter. Everything the
 * business hand-writes (thresholds, routing, acceptance, wait policies)
 * lives here; everything intelligent lives in seat prompts. What gets
 * saved/reused/versioned across runs is exactly this object.
 */
import type { Ast } from '../expr/Expr.js'

/** Where an observable's value is collected from each round (spec §3.1). */
export type ObservableSource =
  | { from: 'judge'; key: string }              // judge return_result data field
  | { from: 'ledger'; file: string; path: string } // JSON pointer-ish dotted path
  | { from: 'meter'; name: string }

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

export type TripwireAction = {
  mode?: 'pivot' | 'finalize' | 'attention'
  escalate?: string
  stop?: boolean
}

export interface TripwireSpec {
  when: string
  then: TripwireAction
}

export type GateSpec =
  | { kind: 'schema'; files: string[] }
  | { kind: 'judge'; evidence: string[]; rubric: string }

export type SeatContext = 'lineage_round' | 'lineage_loop' | 'isolated'

export interface SeatSpec {
  /** D5/D6: worker defaults lineage_round, judge/pivoter isolated. */
  context: SeatContext
  prompt: string
  tools?: string[]
  budgetPerRound?: { usd?: number; turns?: number }
  /** Evidence whitelist for isolated seats (paths relative to stateRoot). */
  inputs?: string[]
}

export interface BudgetSpec {
  perRound?: { usd?: number; turns?: number }
  lifetime?: { rounds?: number; usd?: number; deadlineMs?: number }
}

export interface Charter {
  id: string
  version: number
  goal: string
  observables: ObservableSpec[]
  meters: MeterSpec[]
  tripwires: TripwireSpec[]
  gates: Record<string, GateSpec>
  seats: {
    worker: SeatSpec
    judge?: SeatSpec
    pivoter?: SeatSpec
  }
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
    /** All identifiers the expressions may reference (audit). */
    declaredIdentifiers: string[]
    frozenAt: number
  }
}
