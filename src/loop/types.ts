/**
 * loop/types — shared types + instance directory layout (spec §3.3).
 *
 * The instance dir is the ONLY durable home of a loop: charter snapshot,
 * ledgers, drafts, inbox, reports. Every process (CLI, daemon, tick child)
 * finds the same world here; none of them may assume another process exists.
 */
import { join, resolve } from 'path'

export type LoopInstanceId = string

/**
 * How a round runs. Exactly two modes exist (v3): 'pivot' rounds run the
 * pivoter seat first and inject its directive into the worker capsule;
 * 'normal' rounds don't. Termination is NOT a mode — it is a route action
 * (see RouteDecision). Pre-v3 ledgers may contain 'finalize'/'attention';
 * `normalizeRoundMode` maps them to 'normal' on read.
 */
export type RoundMode = 'normal' | 'pivot'

/** Read-tolerance for pre-v3 persisted modes. */
export function normalizeRoundMode(mode: unknown): RoundMode {
  return mode === 'pivot' ? 'pivot' : 'normal'
}

/**
 * The ROUTE decision of a round — structured, no string grammar.
 *   continue — schedule the next round
 *   pivot    — schedule the next round as a pivot round (nextRoundMode)
 *   finalize — end the loop (cause: accepted | budget | tripwire)
 *   escalate — pause for a human (always from a tripwire)
 */
export interface RouteDecision {
  kind: 'continue' | 'pivot' | 'finalize' | 'escalate'
  /** What triggered a non-continue kind. */
  cause?: 'accepted' | 'budget' | 'tripwire'
  /** Set when cause is 'tripwire' (index into charter.tripwires). */
  tripwireIndex?: number
  /** Human-readable reason (tripwire action reason, 'goal_satisfied', 'budget'…). */
  reason?: string
}

/** Render a route for reports/CLI/capsule digests. Tolerates pre-v3 strings. */
export function renderRoute(route: RouteDecision | string): string {
  if (typeof route === 'string') return route
  const label = route.reason ?? (route.cause === 'accepted' || route.cause === 'budget' ? route.cause : undefined)
  const tw = route.tripwireIndex !== undefined ? `#tw${route.tripwireIndex}` : ''
  return `${route.kind}${label ? `:${label}` : ''}${tw}`
}

/**
 * progress.json status — a TOTAL function of the round's RouteDecision (plus
 * the health rule on continue). Every value has exactly one producer:
 *   healthy | stale    — route=continue (health rule)
 *   pivot_scheduled    — route=pivot (next round will run the pivoter)
 *   paused_attention   — route=escalate (mirrors the instance status: same fact)
 *   completed          — route=finalize (the ONLY status a terminated-ok loop shows)
 */
export type ProgressStatus = 'healthy' | 'stale' | 'pivot_scheduled' | 'paused_attention' | 'completed'

export type LoopInstanceStatus =
  | 'idle'              // between rounds, wake scheduled
  | 'running'           // a tick process holds the claim
  | 'waiting'           // external effect pending (M2)
  | 'paused_attention'  // escalated, needs human ack
  | 'done'
  | 'failed'

export interface LoopInstanceRecord {
  schemaVersion: '1.0'
  instanceId: LoopInstanceId
  charterId: string
  charterVersion: number
  /** SHA-256 of the frozen charter snapshot (drift detection). */
  charterHash: string
  /** Workspace the loop operates on (absolute). */
  projectDir: string
  status: LoopInstanceStatus
  createdAt: number
  updatedAt: number
  /** Set when status is terminal or paused — surfaced by `loop list`. */
  statusReason?: string
  /**
   * Set when status is paused_attention: which tripwire escalated. Consumed by
   * re-arm (migrate) to reset the offending meters so the same tripwire cannot
   * re-fire instantly after a human ack. Cleared on re-arm.
   */
  lastEscalation?: { tripwireIndex: number; reason: string; at: number }
}

/** One audited round — the append-only spine of the loop (ledger/rounds.jsonl). */
export interface RoundEntry {
  round: number
  mode: RoundMode
  /** Observables collected for METER/ROUTE this round. */
  observables: Record<string, number | boolean | string>
  /** Meter values AFTER this round's METER step. */
  meters: Record<string, number>
  /** Route decision taken at ROUTE (pre-v3 ledgers hold strings; render via renderRoute). */
  route: RouteDecision
  /** Corrective retries consumed this round (0 or 1 in M1). */
  correctiveRetries: number
  costUsd: number
  seatSummaries: Record<string, string>
  startedAt: number
  finishedAt: number
}

// ── Instance directory layout ─────────────────────────────────────────────────

export interface InstancePaths {
  root: string
  instanceJson: string
  frozenCharter: string
  ledgerDir: string
  roundsJsonl: string
  findingsJsonl: string
  directionsJson: string
  progressJson: string
  effectsJsonl: string
  /** Persisted mid-round state while an external effect is pending (M2). */
  pendingRoundJson: string
  draftsDir: string
  inboxDir: string
  processedDir: string
  eventsDir: string
  /** Consumed event files are archived here (idempotent ingestion). */
  eventsProcessedDir: string
  reportsDir: string
  capsuleJson: string
}

/** `<taskDir>/.loop/<instanceId>/…` — everything a loop owns lives under here. */
export function instancePaths(taskDir: string, instanceId: LoopInstanceId): InstancePaths {
  const root = join(resolve(taskDir), '.loop', instanceId)
  const ledgerDir = join(root, 'ledger')
  return {
    root,
    instanceJson: join(root, 'instance.json'),
    frozenCharter: join(root, 'charter.frozen.json'),
    ledgerDir,
    roundsJsonl: join(ledgerDir, 'rounds.jsonl'),
    findingsJsonl: join(ledgerDir, 'findings.jsonl'),
    directionsJson: join(ledgerDir, 'directions.json'),
    progressJson: join(ledgerDir, 'progress.json'),
    effectsJsonl: join(ledgerDir, 'effects.jsonl'),
    pendingRoundJson: join(ledgerDir, 'pending_round.json'),
    draftsDir: join(root, 'drafts'),
    inboxDir: join(root, 'inbox'),
    processedDir: join(root, 'inbox', 'processed'),
    eventsDir: join(root, 'events'),
    eventsProcessedDir: join(root, 'events', 'processed'),
    reportsDir: join(root, 'reports'),
    capsuleJson: join(root, 'capsule.json'),
  }
}

/** Mid-round state persisted between the submit and harvest segments (M2). */
export interface PendingRound {
  round: number
  mode: RoundMode
  /**
   * 'effect'     — waiting on an external side-effect (probe/event; effectKey set).
   * 'self_timer' — the worker parked itself via the timer tool; no effect ledger,
   *                just a timer wake that resumes it at `fireAt`.
   * Absent = 'effect' (back-compat with pre-self_timer instances).
   */
  kind?: 'effect' | 'self_timer'
  /** Effect wait only. */
  effectKey?: string
  waitName?: string
  /** self_timer only: why the worker parked, and when the timer resumes it. */
  reason?: string
  fireAt?: number
  startedAt: number
  costUsdSoFar: number
  seatSummaries: Record<string, string>
  correctiveRetries: number
  /** Submit-segment worker summary — the lineage digest the harvest carries. */
  submitSummary: string
  createdAt: number
}
