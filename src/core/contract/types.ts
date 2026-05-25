/**
 * TaskContract — immutable goal anchor for long-running tasks.
 *
 * Created when a task becomes long-running (campaign launch, sub-agent spawn,
 * or explicit user request spanning multiple sessions).  Injected into every
 * subsequent prompt turn above volatile context so the model always has access
 * to the original user intent, non-goals, acceptance criteria, and the
 * user-approved decision log.
 *
 * The contract is updated ONLY through explicit transitions:
 *   - User changes the primary goal
 *   - User approves an escalation or a key decision
 *   - A blocker is discovered
 *   - An acceptance criterion is satisfied or failed
 *
 * It is deliberately NOT updated by LLM-generated summaries — compaction cannot
 * rewrite the task contract.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core types
// ─────────────────────────────────────────────────────────────────────────────

export interface UserDecision {
  /** ISO 8601 timestamp */
  at: string
  /** What was decided */
  decision: string
  /** Provenance ID or other external evidence reference, if applicable */
  evidence?: string
}

export interface AcceptanceCriterion {
  id: string
  description: string
  /** 'unknown' until explicitly checked */
  status: 'pass' | 'fail' | 'unknown'
  /** ISO 8601 timestamp when last evaluated */
  evaluatedAt?: string
  /** Provenance IDs or other evidence */
  evidenceRefs?: string[]
}

export interface TaskContract {
  /** Schema version for forward-compatible deserialization */
  schemaVersion: '1.0'
  /** Stable identifier — format: `contract-{uuid8}` */
  contractId: string
  /** Parent session that created this contract */
  sessionId: string
  /** ISO 8601 creation timestamp */
  createdAt: string
  /** ISO 8601 last-updated timestamp */
  updatedAt: string

  // ── Goal ──────────────────────────────────────────────────────────────────
  /**
   * The primary user goal — verbatim or closely paraphrased from the original
   * request.  Must not be shortened by compaction.
   */
  primaryGoal: string
  /** Things the task explicitly does NOT cover */
  nonGoals: string[]
  /** Hard constraints the solution must satisfy */
  constraints: string[]

  // ── Success definition ────────────────────────────────────────────────────
  /** Machine-checkable acceptance criteria */
  acceptanceCriteria: AcceptanceCriterion[]

  // ── Decision log ──────────────────────────────────────────────────────────
  /**
   * Append-only log of user-approved decisions.
   * Only the main agent (with user confirmation) may append to this list.
   */
  userApprovedDecisions: UserDecision[]

  // ── Current plan ──────────────────────────────────────────────────────────
  /** High-level step plan tied back to the primary goal */
  currentPlan: string[]
  /** Known questions that must be resolved before the task can complete */
  openQuestions: string[]

  // ── Associated IDs ────────────────────────────────────────────────────────
  /** Campaign ID if this contract was created for a DOE campaign */
  campaignId?: string
  /** Sub-agent task IDs spawned under this contract */
  subAgentTaskIds?: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory helpers
// ─────────────────────────────────────────────────────────────────────────────

export function makeContractId(): string {
  const uuid8 = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  return `contract-${uuid8}`
}

export function createTaskContract(
  sessionId: string,
  primaryGoal: string,
  opts: {
    nonGoals?: string[]
    constraints?: string[]
    acceptanceCriteria?: Array<{ id: string; description: string }>
    currentPlan?: string[]
    openQuestions?: string[]
    campaignId?: string
  } = {},
): TaskContract {
  const now = new Date().toISOString()
  return {
    schemaVersion: '1.0',
    contractId: makeContractId(),
    sessionId,
    createdAt: now,
    updatedAt: now,
    primaryGoal,
    nonGoals: opts.nonGoals ?? [],
    constraints: opts.constraints ?? [],
    acceptanceCriteria: (opts.acceptanceCriteria ?? []).map(c => ({
      ...c,
      status: 'unknown' as const,
    })),
    userApprovedDecisions: [],
    currentPlan: opts.currentPlan ?? [],
    openQuestions: opts.openQuestions ?? [],
    campaignId: opts.campaignId,
    subAgentTaskIds: [],
  }
}
