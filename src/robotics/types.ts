import { randomUUID } from 'crypto'

// ── Domain taxonomy + experience schema ───────────────────────────────────────
// The experience-entry schema + domain/confidence taxonomy moved to neutral
// infra (infra/knowledge/types.ts) so ExperienceStore — reused by auto mode —
// no longer lives under robotics. Re-exported here under the historical names
// (KnowledgeDomain → RoboticsDomain, KNOWLEDGE_DOMAINS → ROBOTICS_DOMAINS) so
// every robotics call site is unchanged. See architecture-review §5.1 (#2b).
import {
  KNOWLEDGE_DOMAINS,
  KNOWLEDGE_CONFIDENCE_TIERS,
  makeExperienceId,
} from '../infra/knowledge/types.js'
import type {
  KnowledgeDomain,
  KnowledgeConfidenceTier,
  ExperienceOutcome,
  ExperienceEntry,
  ExperienceSearchQuery,
} from '../infra/knowledge/types.js'

export { KNOWLEDGE_CONFIDENCE_TIERS, makeExperienceId }
export type { KnowledgeConfidenceTier, ExperienceOutcome, ExperienceEntry, ExperienceSearchQuery }
/** Robotics domain taxonomy — the project's name for the neutral KnowledgeDomain. */
export type RoboticsDomain = KnowledgeDomain
export const ROBOTICS_DOMAINS: RoboticsDomain[] = KNOWLEDGE_DOMAINS

export type RoboticsAgentRole =
  | 'orchestrator' | 'paper_search' | 'experiment' | 'code' | 'analysis' | 'deployment'

export type KnowledgeScope = 'global' | 'robot' | 'code'

export const KNOWLEDGE_SCOPES: KnowledgeScope[] = ['global', 'robot', 'code']

// ── Principle Store ─────────────────────────────────────────────────────────
export type PrincipleAbstractionLevel =
  | 'physical'
  | 'system'
  | 'algorithmic'
  | 'statistical'
  | 'operational'

export const PRINCIPLE_ABSTRACTION_LEVELS: PrincipleAbstractionLevel[] = [
  'physical', 'system', 'algorithmic', 'statistical', 'operational',
]

export interface PrincipleEntry {
  id: string             // 'pr_<timestamp>_<uuid8>'
  schemaVersion: '1.0'
  createdAt: number
  updatedAt: number
  title: string          // ≤ 100 chars
  statement: string      // transferable mechanism / constraint
  mechanism: string      // why the principle holds
  firstPrinciplesSupport: string[]  // physics/math/CS/control-theory support
  domains: RoboticsDomain[]
  abstractionLevel: PrincipleAbstractionLevel
  preconditions: string[]
  applicabilityBounds: string[]
  nonApplicableWhen: string[]
  derivedFromExperienceIds: string[]
  anchoredByPhysicalAnchorIds: string[]
  evidenceRefs: string[]
  invalidatedAssumptions: string[]
  counterExamples: string[]
  confidenceTier: KnowledgeConfidenceTier
  observationCount: number
  contradictionCount: number
  promotionReason: 'confidence_threshold' | 'explicit_user_request'
  sourceExperienceId?: string
  lastVerifiedAt?: number
}

export interface PrincipleSearchQuery {
  domain?: RoboticsDomain
  abstractionLevel?: PrincipleAbstractionLevel
  experienceId?: string
  anchorId?: string
  keyword?: string
  limit?: number
}


export function makePrincipleId(): string {
  const ts = Date.now().toString(36)
  const uuid8 = randomUUID().replace(/-/g, '').slice(0, 8)
  return `pr_${ts}_${uuid8}`
}

// ── Physical Anchor Store ────────────────────────────────────────────────────
export interface PhysicalAnchorEntry {
  id: string             // 'pa_<timestamp>_<uuid8>'
  schemaVersion: '1.0'
  createdAt: number
  updatedAt: number
  domain: RoboticsDomain
  /** Scope controls where this anchor should be considered applicable. */
  scope: KnowledgeScope
  robot?: string
  title: string          // ≤ 80 chars
  /** Concrete physical/device fact the model should not infer away. */
  fact: string           // ≤ 800 chars
  /** Mechanism explaining why the fact matters, if known. */
  mechanism?: string     // ≤ 800 chars
  /** Operational implication for planning/debugging. */
  implication: string    // ≤ 800 chars
  tags: string[]
  confidenceTier: KnowledgeConfidenceTier
  evidenceRefs: string[]
  source?: string
  lastVerifiedAt?: number
  invalidates?: string[]
  /** Number of experiments whose evidence corroborated this fact. Defaults to 0. */
  observationCount?: number
  /** Number of experiments that observed this fact NOT to hold. Defaults to 0. */
  contradictionCount?: number
  /** Reviewed principles that cite this anchor as physical support (back-link). */
  principleIds?: string[]
}

export interface PhysicalAnchorSearchQuery {
  domain?: RoboticsDomain
  scope?: KnowledgeScope
  robot?: string
  tags?: string[]
  keyword?: string
  limit?: number
}

export function makePhysicalAnchorId(): string {
  const ts = Date.now().toString(36)
  const uuid8 = randomUUID().replace(/-/g, '').slice(0, 8)
  return `pa_${ts}_${uuid8}`
}

// ── Experiment types ──────────────────────────────────────────────────────────
export interface ExperimentSpec {
  title: string
  hypothesis: string
  environment: string
  procedure: string
  successCriteria: string
  maxTurns?: number      // default 60
  timeoutMs?: number     // default 30 min
}

export interface ExperimentSummary {
  specTitle: string
  outcome: 'success' | 'partial' | 'failure' | 'timeout'
  metrics: Record<string, number | string>
  keyFindings: string[]
  failureAnalysis?: string
  nextSuggestions: string[]
  /** Pending ID returned by experience_write; becomes an ExperienceStore ID only after review approval. */
  pendingExperienceId?: string
  branchName?: string    // git branch with experiment code
  durationMs: number
  turnsUsed: number
}

// ── Hardware Profile ──────────────────────────────────────────────────────────
export interface HardwareProfileData {
  schemaVersion: '1.0'
  name: string
  platform: string
  compute: string
  os?: string
  actuators?: string
  sensors?: string
  safetyLimits: Record<string, string | number>
  knownIssues?: string[]
  notes?: string
  updatedAt: number
}

// ── Git state (used in ProjectStore) ─────────────────────────────────────────
// Git worktree state now lives in neutral infra (GitWorkspaceManager moved out
// of robotics/ — see architecture-review-2026-06-18.md §1.2). Imported for local
// use below (RoboticsProjectState.git) and re-exported under the original name
// so existing robotics references keep working unchanged.
import type { GitWorkspaceState } from '../infra/git/types.js'
export type { GitWorkspaceState as RoboticsGitState }
type RoboticsGitState = GitWorkspaceState

// ── Active sub-agent record ───────────────────────────────────────────────────
export interface ActiveSubAgentRecord {
  taskId: string
  role: RoboticsAgentRole
  title: string
  branchName?: string
  worktreePath?: string
  spawnedAt: number
  lastCheckpointAt?: number
  /**
   * Why this sub-agent was dispatched (one sentence).
   * Stored so R3 can remind the orchestrator of the causal context.
   */
  purpose?: string
  /**
   * What the orchestrator (main agent) will do once this task completes.
   * Required for experiment_dispatch — prevents orphan tasks with no result handling.
   * Displayed in R3 every turn so the agent never forgets its commitment.
   */
  on_complete?: string
}

// ── Agent orchestration mode ──────────────────────────────────────────────────
/**
 * single — main agent handles everything directly; no sub-agent dispatch.
 *          R1 omits multi-agent roles and Git coordination protocol.
 * multi  — full multi-agent orchestration; experiment_dispatch, paper_search,
 *          Git worktree isolation, and noise-isolation protocol all active.
 *
 * Classified by flash model on first submit() using task context + AGENT.md signals.
 * Persisted in project state so resumed sessions keep the same mode.
 */
export type RoboticsAgentMode = 'single' | 'multi'

// ── Project state (persisted) ─────────────────────────────────────────────────
export interface RoboticsProjectState {
  schemaVersion: '1.0'
  sessionId: string
  projectDir: string
  robot?: string
  createdAt: number
  lastActiveAt: number
  currentPhase?: string
  progressNotes: string[]
  activeSubAgentTasks: ActiveSubAgentRecord[]
  completedSubAgentTaskIds: string[]
  git: RoboticsGitState
  /** Classified on first submit; persisted so resumed sessions stay in same mode. */
  agentMode?: RoboticsAgentMode
  /**
   * User-set star flag.  Starred sessions are exempt from 7-day auto-purge.
   * Defaults to false (not starred).
   */
  starred?: boolean
  /**
   * User-defined labels for grouping and filtering sessions.
   * e.g. ['go2', 'mpc', 'sprint-3']
   */
  tags?: string[]
}

// ── Project summary (for session listing) ────────────────────────────────────
export interface RoboticsProjectSummary {
  projectDir: string
  sessionId: string
  robot?: string
  createdAt: number
  lastActiveAt: number
  starred: boolean
  tags: string[]
  currentPhase?: string
  agentMode?: RoboticsAgentMode
  /** Age in days since last activity. */
  idleDays: number
}
