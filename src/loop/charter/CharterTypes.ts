/**
 * CharterTypes — the declarative contract a loop runs under (spec §3.1, D1).
 *
 * A charter is DATA. The kernel is its only interpreter. Everything the
 * business hand-writes (thresholds, routing, acceptance, wait policies)
 * lives here; everything intelligent lives in seat prompts. What gets
 * saved/reused/versioned across runs is exactly this object.
 */
import type { Ast } from '../expr/Expr.js'

/** Reserved kernel-produced observable; charters/plugins cannot redeclare it. */
export const PRODUCER_OK_OBSERVABLE = 'producer_ok' as const

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

export type ObservationFailurePolicy = 'skip' | 'false' | 'fail_stop'
export type ObjectiveFailurePolicy = 'skip_update' | 'fail_stop'

export interface MeterSpec {
  name: string
  /** `inc: 'every_round'` for iteration-style counters. */
  inc?: 'every_round'
  incWhen?: string
  resetWhen?: string
}

export interface ObservableConsumer {
  kind: 'meter' | 'tripwire' | 'health' | 'objective'
  id: string
  field: string
}

export interface ObservableObligation {
  source: 'judge' | 'kernel'
  outputKey: string
  consumers: ObservableConsumer[]
}

export interface FrozenSeatPlan {
  producer: 'worker'
  reviewers: Array<'judge'>
  pivoter?: 'pivoter'
  finalizer?: 'finalizer'
}

export type ArtifactCommitMode = 'append' | 'replace' | 'versioned'

export interface ArtifactSpec {
  id: string
  kind: 'json' | 'text' | 'workspace_diff' | 'external_ref'
  draftPath: string
  stream: string
  commitMode: ArtifactCommitMode
  requiredGates: string[]
}

export interface ProjectionBinding {
  id: string
  source: { kind: 'artifact_stream'; stream: string }
  reducer: 'builtin/artifact-view@1'
  mode: 'count' | 'latest' | 'window'
  /** Required for window; bounded to keep checkpoints independent of history size. */
  maxItems?: number
}

export type EffectObservationType = 'number' | 'string' | 'boolean'

export interface EffectObservationSpec {
  /** RFC 6901 JSON Pointer into {state, verdict?, data?} returned by inspect/reconcile. */
  pointer: string
  type: EffectObservationType
}

export type EffectRuleAction =
  | { act: 'harvest'; verdict: string }
  | { act: 'cancel_and_harvest'; verdict: string }
  | { act: 'continue_waiting' }
  | { act: 'escalate'; reason: string }

export interface EffectRule {
  when: string
  then: EffectRuleAction
  onAbsent: 'continue_waiting' | 'escalate' | 'fail_stop'
  onError: 'escalate' | 'fail_stop'
}

export interface EffectAdmissionSpec {
  /** Per-host process bound in v1; cross-host durable admission is a G5 concern. */
  maxConcurrentCalls: number
  /** Minimum start-to-start interval for calls to this adapter in one host process. */
  minIntervalMs?: number
}

export interface EffectBinding {
  adapter: string
  observations: Record<string, EffectObservationSpec>
  rules: EffectRule[]
  admission?: EffectAdmissionSpec
}

export interface FrozenEffectBinding extends EffectBinding {
  frozen: { ruleAsts: Ast[] }
}

export interface FrozenGateBinding {
  id: string
  kind: 'shape' | 'judge' | 'contract'
  /** Selects the trusted executor; Scenario bindings are dispatched via its registry entry. */
  handler: 'kernel' | 'scenario'
  gateIds: string[]
  retryProducer: 0 | 1
  executionRetry: 0 | 1
  feedback: 'messages' | 'generic'
}

export interface FrozenExecutionPlan {
  seats: FrozenSeatPlan
  gates: FrozenGateBinding[]
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
  /** Legacy charters default both policies to false during normalization. */
  onAbsent?: ObservationFailurePolicy
  onError?: ObservationFailurePolicy
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
  /** Skills that must exist before an instance can be created. The loop base
   * injects the read-only `skill` loader; these names are capability
   * requirements, not prompt hints. */
  skills?: string[]
  tools?: string[]
  /** Host-owned capabilities explicitly authorized by the reviewed Charter.
   * They are implemented as constrained tools and never widen bash/write_file. */
  capabilities?: {
    vcsPublish?: {
      /** Fixed git remote. Defaults to origin. */
      remote?: string
    }
  }
  /** Host paths the workflow requires. This field never grants access: create
   * succeeds only when the operator already granted a containing path through
   * `sandbox.writeAllowPaths`. */
  hostRequirements?: {
    writePaths?: string[]
    /** Host-wide resources used by the worker segment. This coordinates use;
     * it does not grant filesystem or network capabilities. */
    resources?: HostResourceSpec[]
  }
  /**
   * Per-SEGMENT circuit breakers for a seat call. `wallclockMin` sets the seat's
   * wall-clock cap in minutes (default 30). A research submit segment (read +
   * design + implement + submit) can need more; the long wait BETWEEN segments
   * is free because the process is dead while parked.
   */
  budgetPerRound?: { usd?: number; turns?: number; wallclockMin?: number }
  /** Evidence whitelist for isolated seats. Plain paths are relative to the
   * instance state root. `workspace:<relative-path>` is an explicitly reviewed,
   * read-only, symlink-safe reference to a file in the project workspace. No
   * directory convention or project-specific history layout is assumed. */
  inputs?: string[]
}

export interface HostResourceSpec {
  id: string
  mode: 'exclusive' | 'shared'
  /** Required for useful shared admission; defaults to one. */
  maxConcurrent?: number
}

export interface WaitPolicySpec {
  /** Bounds semantic self-timer polling inside one round. Segment wallclock and
   * lifetime round budgets do not advance while a process is parked, so these
   * limits are independently required for deterministic liveness. */
  selfTimer?: {
    /** Number of timer parks allowed before the next wake becomes final harvest. */
    maxParksPerRound: number
    /** Absolute submit-to-final-harvest elapsed limit for one round. */
    maxRoundElapsedMin: number
  }
}

export interface BudgetSpec {
  perRound?: { usd?: number }
  lifetime?: { rounds?: number; usd?: number; deadlineMs?: number }
}

export interface Charter {
  id: string
  version: number
  goal: string
  /** Built-in or plugin Scenario registry identity. Legacy omission resolves to builtin/research@1. */
  scenario?: string
  /** Proposal streams and their required Gate bindings. Defaults come from the selected Scenario. */
  artifacts?: Record<string, ArtifactSpec>
  /** Complete ordered Gate execution policy. Defaults are frozen at instantiation. */
  gateBindings?: FrozenGateBinding[]
  /** Typed, deterministic bounded views over committed Artifact streams. */
  projections?: ProjectionBinding[]
  /** Deterministic external-effect contracts, selected by binding ID at wait time. */
  effects?: Record<string, EffectBinding>
  /** Optimization direction for judge.data.metric. Default max for legacy charters. */
  metric?: {
    direction: 'max' | 'min'
    onAbsent?: ObjectiveFailurePolicy
    onError?: ObjectiveFailurePolicy
    onNull?: ObjectiveFailurePolicy
  }
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
  health?: {
    staleWhen: string
    /** Legacy charters default both policies to false during normalization. */
    onAbsent?: ObservationFailurePolicy
    onError?: ObservationFailurePolicy
  }
  budgets?: BudgetSpec
  /** Deterministic bounds for between-segment waits. Safe defaults are applied
   * at runtime for legacy charters that omit this field. */
  waitPolicy?: WaitPolicySpec
  /** repo write scope for the worker seat (D8); empty = state-only loop. */
  writeScope?: string[]
  /** Cadence of the next-round timer, ms after a round ends. Default 0 = immediate. */
  roundIntervalMs?: number
}

/** Charter after create-time freezing: every expression parsed to an AST. */
export interface FrozenCharter extends Charter {
  scenario: string
  artifacts: Record<string, ArtifactSpec>
  gateBindings: FrozenGateBinding[]
  projections: ProjectionBinding[]
  effects: Record<string, FrozenEffectBinding>
  frozen: {
    meterAsts: Record<string, { incWhen?: Ast; resetWhen?: Ast }>
    tripwireAsts: Ast[]
    /** Parsed charter.health.staleWhen, when declared. */
    healthAst?: Ast
    /** All identifiers the expressions may reference (audit). */
    declaredIdentifiers: string[]
    /** Producer-to-consumer dependency graph, rebuilt in memory for legacy snapshots. */
    observableObligations: Record<string, ObservableObligation>
    /** Fixed-role, bounded-retry plan; never an arbitrary step graph. */
    executionPlan: FrozenExecutionPlan
    frozenAt: number
  }
}
