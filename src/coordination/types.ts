/**
 * Phase 3 coordination types.
 *
 * Covers the full lifecycle of a Design-of-Experiments campaign:
 *   Campaign (long-lived, disk-persisted) ≠ Conversation (short-lived, ephemeral)
 *
 * Key invariant: CampaignPhase is the only authoritative state. All context
 * injection (MetaAgentContextStore) and capsule generation (CapsuleBuilder)
 * are derived from it — never stored redundantly.
 */

// ── Design space primitives ───────────────────────────────────────────────────

export interface DesignVariable {
  name: string
  type: 'continuous' | 'integer' | 'discrete' | 'categorical'
  /** Required for continuous / integer */
  bounds?: [number, number]
  /** Required for discrete / categorical */
  values?: (string | number)[]
  unit?: string
  description?: string
}

export interface Objective {
  name: string
  direction: 'minimize' | 'maximize'
  unit?: string
  /** Used for weighted-sum scalarisation (optional) */
  weight?: number
}

export interface Constraint {
  name: string
  /** inequality: fn(vars) ≤ 0 | equality: fn(vars) = 0 */
  type: 'inequality' | 'equality'
  /** Natural-language or expression string; evaluated by tool or constraint tool */
  expression: string
}

export interface DesignSpace {
  variables: DesignVariable[]
  objectives: Objective[]
  constraints: Constraint[]
}

// ── Design point & evaluation result ─────────────────────────────────────────

export interface DesignPoint {
  /** Deterministic hash of variables — stable across re-runs with same inputs */
  id: string
  variables: Record<string, number | string>
}

export type FidelityLevel = 0 | 1 | 2 | 3 | 4

export interface EvaluationResult {
  designPoint: DesignPoint
  objectives: Record<string, number>
  constraintsSatisfied: Record<string, boolean>
  feasible: boolean
  fidelity: FidelityLevel
  /** Links back to Phase-1 ProvenanceTracker */
  provenanceId: string
  evaluatedBy: string
  durationMs: number
}

// ── Pareto analysis ───────────────────────────────────────────────────────────

export interface ParetoFront {
  /** True Pareto front: non-dominated feasible solutions */
  rank1: EvaluationResult[]
  /** Full ranked layers (rank1 = layer 0) */
  allRanks: EvaluationResult[][]
  /** Hypervolume indicator (null if no reference point set) */
  hypervolume: number | null
}

// ── Worker task protocol ──────────────────────────────────────────────────────

export interface WorkerTask {
  taskId: string
  campaignId: string
  workerId: string
  designPoints: DesignPoint[]
  fidelity: FidelityLevel
  capability: string
  objectives: Objective[]
  constraints: Constraint[]
  timeoutMs: number
}

// ── Campaign state machine ────────────────────────────────────────────────────

export type CampaignPhase =
  | 'IDLE'
  | 'SAMPLING'
  | 'EVALUATING_L0'
  | 'PARETO_READY_L0'
  | 'ESCALATING_L1'
  | 'PARETO_READY_L1'
  | 'ESCALATING_L2'
  | 'PARETO_READY_L2'
  | 'REPORTING'
  | 'DONE'
  | 'FAILED'

/** Enforced by CampaignStateStore.transitionPhase() */
export const VALID_TRANSITIONS: Record<CampaignPhase, CampaignPhase[]> = {
  IDLE:             ['SAMPLING',      'FAILED'],
  SAMPLING:         ['EVALUATING_L0', 'FAILED'],
  EVALUATING_L0:    ['PARETO_READY_L0',                               'FAILED'],
  PARETO_READY_L0:  ['ESCALATING_L1', 'REPORTING', 'DONE',            'FAILED'],
  ESCALATING_L1:    ['PARETO_READY_L1',                               'FAILED'],
  PARETO_READY_L1:  ['ESCALATING_L2', 'REPORTING', 'DONE',            'FAILED'],
  ESCALATING_L2:    ['PARETO_READY_L2',                               'FAILED'],
  PARETO_READY_L2:  ['REPORTING',     'DONE',                         'FAILED'],
  REPORTING:        ['DONE',                                           'FAILED'],
  DONE:             [],
  FAILED:           ['SAMPLING'],
}

/** Human-readable phase labels used in capsule / status lines */
export const PHASE_LABELS: Record<CampaignPhase, string> = {
  IDLE:             'Idle',
  SAMPLING:         'Sampling design points',
  EVALUATING_L0:    'Running L0 evaluation (background)',
  PARETO_READY_L0:  'L0 complete — Pareto front ready',
  ESCALATING_L1:    'Running L1 escalation (background)',
  PARETO_READY_L1:  'L1 complete — Pareto front updated',
  ESCALATING_L2:    'Running L2 escalation (background)',
  PARETO_READY_L2:  'L2 complete — Pareto front updated',
  REPORTING:        'Generating report',
  DONE:             'Campaign complete',
  FAILED:           'Campaign failed',
}

/** Phases that require no user action (machine runs automatically) */
export const MACHINE_PHASES = new Set<CampaignPhase>([
  'SAMPLING', 'EVALUATING_L0', 'ESCALATING_L1', 'ESCALATING_L2', 'REPORTING',
])

/** Phases where the system waits for user input before continuing */
export const USER_CHECKPOINT_PHASES = new Set<CampaignPhase>([
  'PARETO_READY_L0', 'PARETO_READY_L1', 'PARETO_READY_L2',
])

// ── Persisted state (state.json) ──────────────────────────────────────────────

export interface PersistedCampaignState {
  schemaVersion: '1.0'
  campaignId: string
  projectName: string
  createdAt: string
  updatedAt: string

  phase: CampaignPhase
  designSpace: DesignSpace

  /** Design points generated by DOESampler */
  sampledPoints: DesignPoint[]

  /** task IDs currently in progress (write by Coordinator, clear by Monitor) */
  pendingTaskIds: string[]
  /** task IDs that completed successfully */
  completedTaskIds: string[]
  /** task IDs that failed */
  failedTaskIds: string[]

  /** Error description when phase === 'FAILED' */
  failureReason?: string
}

// ── Context capsule (capsule.json) ────────────────────────────────────────────

export interface CampaignContextCapsule {
  schemaVersion: '1.0'
  campaignId: string
  projectName: string
  phase: CampaignPhase
  generatedAt: string

  /**
   * Markdown block injected into the conversation context on resume.
   * Budget: < 500 tokens. Pre-computed, no LLM needed at inject time.
   */
  contextBlock: string

  /** Structured data for tool queries — NOT injected directly into context */
  structuredData: {
    totalPoints: number
    completedPoints: number
    failedPoints: number
    paretoFrontSize: number
    hypervolume: number | null
    /** e.g. { best_Q: { value: 48.3, unit: 'W', pointId: 'abc' } } */
    bestResults: Record<string, { value: number; unit: string; pointId: string }>
    /** Non-null when system is waiting for user decision */
    pendingDecision: string | null
    /** Non-null when workers are still running */
    estimatedMinutesRemaining: number | null
  }
}

// ── Session-level context store (active-context.metaagent) ───────────────────

export interface MetaAgentSessionContext {
  schemaVersion: '1.0'
  updatedAt: string
  /** All campaigns that are not DONE/FAILED */
  activeCampaigns: CampaignSummary[]
}

export interface CampaignSummary {
  campaignId: string
  projectName: string
  phase: CampaignPhase
  /**
   * Campaign plugin type — used by D10 to dispatch phase guidance to the
   * correct plugin via CampaignPluginRegistry.
   * Optional for backward compatibility with persisted DOE context files.
   */
  pluginType?: string
  /** The pre-computed contextBlock from capsule.json */
  contextBlock: string
}
