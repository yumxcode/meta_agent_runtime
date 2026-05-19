import { randomUUID } from 'crypto'

// ── Domain taxonomy ───────────────────────────────────────────────────────────
export type RoboticsDomain =
  | 'motion_planning' | 'perception' | 'manipulation' | 'locomotion'
  | 'navigation' | 'simulation' | 'hardware_interface' | 'deployment'
  | 'calibration' | 'general'

export const ROBOTICS_DOMAINS: RoboticsDomain[] = [
  'motion_planning', 'perception', 'manipulation', 'locomotion',
  'navigation', 'simulation', 'hardware_interface', 'deployment',
  'calibration', 'general',
]

export type RoboticsAgentRole =
  | 'orchestrator' | 'paper_search' | 'experiment' | 'code' | 'analysis' | 'deployment'

// ── Experience Store ──────────────────────────────────────────────────────────
export interface ExperienceOutcome {
  success: boolean
  summary: string        // ≤ 200 chars, shown in index
  failureReason?: string
  workarounds?: string[]
}

export interface ExperienceEntry {
  id: string             // 'exp_<timestamp>_<uuid8>'
  schemaVersion: '1.0'
  createdAt: number
  updatedAt: number
  domain: RoboticsDomain
  algorithm?: string
  tags: string[]
  robot?: string
  difficulty: 'low' | 'medium' | 'high'
  title: string          // ≤ 80 chars
  problem: string        // ≤ 500 chars
  solution: string       // ≤ 800 chars
  outcome: ExperienceOutcome
  metrics?: Record<string, number | string>
  sourceTaskId?: string
  sourceSessionId?: string
  relatedPapers?: string[]
  fullReport?: string    // Markdown, loaded on demand only
}

export interface ExperienceSearchQuery {
  domain?: RoboticsDomain
  tags?: string[]
  algorithm?: string
  robot?: string
  keyword?: string       // searches title + problem + solution
  successOnly?: boolean
  limit?: number         // default 10, max 20
}

export function makeExperienceId(): string {
  const ts = Date.now().toString(36)
  const uuid8 = randomUUID().replace(/-/g, '').slice(0, 8)
  return `exp_${ts}_${uuid8}`
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
  experienceId?: string  // ID written to ExperienceStore
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
export interface RoboticsGitState {
  enabled: boolean
  mainBranch: string
  subAgentBranches: Record<string, string>   // taskId → branchName
  forkPoints: Record<string, string>          // taskId → commitHash
}

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
 * Classified by Haiku on first submit() using task context + AGENT.md signals.
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
}
