/**
 * loop/types — shared types + instance directory layout (spec §3.3).
 *
 * The instance dir is the ONLY durable home of a loop: charter snapshot,
 * ledgers, drafts, inbox, reports. Every process (CLI, daemon, tick child)
 * finds the same world here; none of them may assume another process exists.
 */
import { join, resolve } from 'path'

export type LoopInstanceId = string
export type RoundMode = 'normal' | 'pivot' | 'finalize' | 'attention'

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
}

/** One audited round — the append-only spine of the loop (ledger/rounds.jsonl). */
export interface RoundEntry {
  round: number
  mode: RoundMode
  /** Observables collected for METER/ROUTE this round. */
  observables: Record<string, number | boolean | string>
  /** Meter values AFTER this round's METER step. */
  meters: Record<string, number>
  /** Route decision taken (tripwire action or 'continue'). */
  route: string
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
  effectKey: string
  waitName: string
  startedAt: number
  costUsdSoFar: number
  seatSummaries: Record<string, string>
  correctiveRetries: number
  /** Submit-segment worker summary — the lineage digest the harvest carries. */
  submitSummary: string
  createdAt: number
}
