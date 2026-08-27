import { z } from 'zod'

export const TRAJECTORY_LINE_SCHEMA_VERSION = 'trajectory-line-1.0' as const
/**
 * Semver for the tagged item payload union, governed independently of the envelope.
 *
 * 1.2.0 — additive: knowledge items gained the five retrieval/injection states
 * and injection provenance fields. Existing producers stay valid.
 */
export const TRAJECTORY_ITEM_SCHEMA_VERSION = '1.3.0' as const

export const TrajectorySubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: z.string().min(1) }),
  z.object({
    kind: z.literal('graph_instance'),
    workspaceId: z.string().min(1),
    instanceId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('subagent'),
    taskId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
])

export type TrajectorySubject = z.infer<typeof TrajectorySubjectSchema>

const itemBase = z.object({ type: z.string().min(1) })

export const TrajectoryMetaItemSchema = itemBase.extend({
  type: z.literal('trajectory_meta'),
  subject: TrajectorySubjectSchema,
  mode: z.string().min(1),
  createdAt: z.number(),
  rootTrajectoryId: z.string().uuid().optional(),
  parentTrajectoryId: z.string().uuid().optional(),
  workspace: z.string().optional(),
  workspaceId: z.string().optional(),
  provider: z.string().optional(),
  cliVersion: z.string().optional(),
  gitBase: z.string().optional(),
  source: z.string().optional(),
}).passthrough()

/**
 * The workspace's git starting point for one run (G1-1).
 *
 * Recorded per run rather than per trajectory because a long session commits as
 * it goes: a session-level base only describes the start of the first run, and
 * every later run would need the whole history replayed to reach its own
 * starting point.
 *
 * `dirty` and `untracked` are the honesty fields. A bare commit sha claims the
 * commit describes the starting state; when either flag is set it does not, and
 * a restore from that sha alone would begin somewhere the run never was.
 */
export const GitBaseSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  branch: z.string().min(1).optional(),
  dirty: z.boolean(),
  untracked: z.boolean(),
}).strict()

export const RunStartedItemSchema = itemBase.extend({
  type: z.literal('run_started'),
  reason: z.string(),
  budget: z.record(z.string(), z.unknown()).optional(),
  /**
   * Absent when the workspace is not a git repository, or when the probe failed
   * — an absent base honestly means "unknown starting point". It is never
   * partially filled, because a half-filled base reads as usable.
   */
  gitBase: GitBaseSchema.optional(),
}).passthrough()

export const RunResultItemSchema = itemBase.extend({
  type: z.literal('run_result'),
  outcome: z.string(),
  isError: z.boolean(),
  stopReason: z.string().nullable().optional(),
  usage: z.record(z.string(), z.number()).optional(),
  costUsd: z.number().optional(),
  durationMs: z.number().optional(),
  resultSummary: z.string().optional(),
}).passthrough()

export const TurnContextItemSchema = itemBase.extend({
  type: z.literal('turn_context'),
  model: z.string(),
  provider: z.string().optional(),
  approvalPolicy: z.string().optional(),
  sandboxMode: z.string().optional(),
  tools: z.array(z.object({ name: z.string(), schemaHash: z.string() })),
  budgetRemaining: z.record(z.string(), z.number()).optional(),
  policyVersion: z.string().optional(),
}).passthrough()

export const MessageItemSchema = itemBase.extend({
  type: z.literal('message'),
  message: z.record(z.string(), z.unknown()),
}).passthrough()

export const ToolOutcomeItemSchema = itemBase.extend({
  type: z.literal('tool_outcome'),
  toolUseId: z.string(),
  toolName: z.string(),
  input: z.unknown().optional(),
  durationMs: z.number().nonnegative(),
  isError: z.boolean(),
  outputSummary: z.string(),
  outputHash: z.string(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
  timedOut: z.boolean().optional(),
  aborted: z.boolean().optional(),
}).passthrough()

export const TurnDiffItemSchema = itemBase.extend({
  type: z.literal('turn_diff'),
  filesChanged: z.number().int().nonnegative(),
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
  files: z.array(z.object({
    path: z.string(),
    status: z.string(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    contentHash: z.string().optional(),
  })),
}).passthrough()

export const ApprovalItemSchema = itemBase.extend({
  type: z.literal('approval'),
  toolUseId: z.string(),
  toolName: z.string(),
  decision: z.enum(['allow', 'deny', 'redirect']),
  decidedBy: z.enum(['builtin_rule', 'hook', 'human', 'policy', 'unknown']),
  reason: z.string().optional(),
}).passthrough()

export const CompactionItemSchema = itemBase.extend({
  type: z.literal('compaction'),
  previousTokens: z.number().nonnegative(),
  summaryTokens: z.number().nonnegative(),
  replacementHistory: z.array(z.record(z.string(), z.unknown())),
  windowId: z.string().optional(),
}).passthrough()

export const SubagentItemSchema = itemBase.extend({
  type: z.literal('subagent'),
  action: z.enum(['spawned', 'started', 'completed', 'failed', 'cancelled']),
  taskId: z.string(),
  childTrajectoryId: z.string().uuid().optional(),
  worktree: z.string().optional(),
  usage: z.record(z.string(), z.number()).optional(),
}).passthrough()

export const PhaseItemSchema = itemBase.extend({
  type: z.literal('phase'),
  domain: z.string(),
  action: z.string(),
  phaseId: z.string().optional(),
  nodeId: z.string().optional(),
  activationId: z.string().optional(),
  journalSequence: z.number().int().positive().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

export const JobItemSchema = itemBase.extend({
  type: z.literal('job'),
  action: z.enum(['created', 'queued', 'running', 'progress', 'completed', 'failed', 'cancelled']),
  jobId: z.string(),
  toolUseId: z.string().optional(),
  progress: z.number().optional(),
  summary: z.string().optional(),
}).passthrough()

/**
 * One entry that actually reached the model's context.
 *
 * Injection provenance exists so a later analysis can ask "was this run exposed
 * to that entry, at which version" — it records EXPOSURE, never causation. A
 * causal claim ("this entry helped") additionally needs randomised assignment
 * or ablation, because several entries are injected together and the selector
 * itself picks by task difficulty.
 */
export const InjectedKnowledgeEntrySchema = z.object({
  entryId: z.string().min(1),
  /** Content hash of the rendered entry, so a later rewrite is distinguishable. */
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  versionChain: z.array(z.string().min(1)).max(8).default([]),
  /** Origin TaskCase, used to keep evaluation splits free of lineage leakage. */
  sourceCaseId: z.string().min(1).optional(),
  selectorVersion: z.string().min(1),
  queryHash: z.string().min(1),
  /** Present only when the selector assigned probabilistically (A/B, bandit). */
  assignmentProbability: z.number().min(0).max(1).optional(),
  slot: z.number().int().nonnegative().default(0),
  order: z.number().int().nonnegative().default(0),
  targetRunId: z.string().min(1).optional(),
  targetTurnId: z.string().min(1).optional(),
}).strict()

/**
 * A candidate that was recalled but did not make it into the context.
 *
 * Only id/hash/reason code — never the body. These rows exist to support
 * counterfactual ablation, not to duplicate knowledge content into trajectories.
 */
export const ExcludedKnowledgeCandidateSchema = z.object({
  entryId: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  reasonCode: z.string().min(1).max(64),
}).strict()

export const KnowledgeItemSchema = itemBase.extend({
  type: z.literal('knowledge'),
  kind: z.enum(['experience', 'principle', 'anchor']),
  /**
   * Retrieval and injection are five distinct states, not one. Collapsing them
   * into `recalled` loses exactly the distinction attribution needs: recalling
   * ten entries and injecting three is not the same event.
   *
   *   recalled → eligible → selected → rendered → injected
   */
  action: z.enum([
    'recalled', 'proposed', 'approved', 'rejected', 'written', 'deleted',
    'eligible', 'selected', 'rendered', 'injected',
  ]),
  entryIds: z.array(z.string()).default([]),
  query: z.string().optional(),
  pendingId: z.string().optional(),
  operation: z.enum(['recall', 'write', 'delete', 'promote', 'inject']).optional(),
  /** Populated on `injected`; the authoritative record of what the model saw. */
  injected: z.array(InjectedKnowledgeEntrySchema).max(32).optional(),
  excludedCandidates: z.array(ExcludedKnowledgeCandidateSchema).max(64).optional(),
  /** Hash of the assembled context, so injection can be reconciled after the fact. */
  contextHash: z.string().min(1).optional(),
  tokenCost: z.number().int().nonnegative().optional(),
}).passthrough()

export const StateCheckpointItemSchema = itemBase.extend({
  type: z.literal('state_checkpoint'),
  mode: z.string(),
  stateSchemaVersion: z.string(),
  revision: z.number().int().nonnegative().optional(),
  contentHash: z.string(),
  storeRef: z.string(),
}).passthrough()

export const EvaluationItemSchema = itemBase.extend({
  type: z.literal('evaluation'),
  evaluator: z.string(),
  verdict: z.string(),
  score: z.number().optional(),
  metrics: z.record(z.string(), z.number()).optional(),
  evidenceOrdinals: z.array(z.number().int().positive()).optional(),
  artifactHash: z.string().optional(),
}).passthrough()

export const TrajectoryItemSchema = z.discriminatedUnion('type', [
  TrajectoryMetaItemSchema,
  RunStartedItemSchema,
  RunResultItemSchema,
  TurnContextItemSchema,
  MessageItemSchema,
  ToolOutcomeItemSchema,
  TurnDiffItemSchema,
  ApprovalItemSchema,
  CompactionItemSchema,
  SubagentItemSchema,
  PhaseItemSchema,
  JobItemSchema,
  KnowledgeItemSchema,
  StateCheckpointItemSchema,
  EvaluationItemSchema,
])

export type TrajectoryItem = z.infer<typeof TrajectoryItemSchema>
export type TrajectoryMetaItem = z.infer<typeof TrajectoryMetaItemSchema>

export const TrajectoryEnvelopeSchema = z.object({
  schemaVersion: z.literal(TRAJECTORY_LINE_SCHEMA_VERSION),
  ts: z.number(),
  ordinal: z.number().int().positive(),
  trajectoryId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  turnId: z.string().uuid().optional(),
  item: z.object({ type: z.string().min(1) }).passthrough(),
})

export const TrajectoryLineSchema = TrajectoryEnvelopeSchema.extend({
  item: TrajectoryItemSchema,
})

export type TrajectoryLine = z.infer<typeof TrajectoryLineSchema>

/**
 * Forward-compatible audit representation. Unknown item variants keep their
 * exact JSON line for inspection/reindex cursors, but are never fed to recovery
 * projectors until the running binary understands their schema.
 */
export interface PreservedTrajectoryLine {
  schemaVersion: typeof TRAJECTORY_LINE_SCHEMA_VERSION
  ts: number
  ordinal: number
  trajectoryId: string
  runId?: string
  turnId?: string
  item: TrajectoryItem | ({ type: string } & Record<string, unknown>)
  knownItem: boolean
  rawLine: string
}

export interface RecordContext {
  runId?: string
  turnId?: string
  ts?: number
}

export interface TrajectoryDescriptor {
  subject: TrajectorySubject
  mode: string
  rootTrajectoryId?: string
  parentTrajectoryId?: string
  workspace?: string
  workspaceId?: string
  provider?: string
  cliVersion?: string
  gitBase?: string
  source?: string
}

export interface TrajectoryIndexEntry {
  trajectoryId: string
  subject: TrajectorySubject
  mode: string
  createdAt: number
  lastActivity: number
  lastOrdinal: number
  workspace?: string
  workspaceId?: string
  rootTrajectoryId?: string
  parentTrajectoryId?: string
  title?: string
  firstPrompt?: string
  lastOutcome?: string
  toolCalls: number
  toolErrors: number
  runs: number
  totalCostUsd: number
}
