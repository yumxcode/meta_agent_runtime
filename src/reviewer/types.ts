import { z } from 'zod'

export const LearningMomentKindSchema = z.enum([
  'expectation_mismatch',
  'repeated_failure',
  'reviewer_correction',
  'human_correction',
  'breakthrough',
  'contradiction',
  'transferable_pattern',
])

export const ExperienceCategorySchema = z.enum([
  'diagnosis',
  'strategy_selection',
  'procedure',
  'verification',
  'recovery',
  'tool_usage',
  'calibration',
])

export const EvidenceRoleSchema = z.enum([
  'context',
  'expectation',
  'action',
  'outcome',
  'feedback',
  'correction',
  'verification',
  'contradiction',
])

export const EvidenceRefSchema = z.object({
  trajectoryId: z.string().uuid(),
  ordinal: z.number().int().positive(),
  itemType: z.string().min(1),
  journalSequence: z.number().int().positive().optional(),
  artifactHash: z.string().min(1).optional(),
  role: EvidenceRoleSchema,
}).strict()

export const LearningMomentSchema = z.object({
  schemaVersion: z.literal('learning-moment-1.0'),
  id: z.string().min(1),
  kind: LearningMomentKindSchema,
  context: z.object({
    taskSummary: z.string().min(1).max(2_000),
    taskFamily: z.string().min(1).max(160).optional(),
    workspaceId: z.string().min(1).optional(),
    graphHash: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    relevantState: z.array(z.string().min(1).max(500)).max(12),
  }).strict(),
  expectation: z.object({
    statement: z.string().min(1).max(2_000),
    source: z.enum(['agent_explicit', 'task_contract', 'action_implied', 'reviewer_inferred']),
    confidence: z.enum(['high', 'medium', 'low']),
  }).strict().optional(),
  action: z.string().min(1).max(2_000),
  observedOutcome: z.string().min(1).max(2_000),
  feedback: z.string().min(1).max(2_000).optional(),
  correction: z.string().min(1).max(2_000).optional(),
  correctedOutcome: z.string().min(1).max(2_000).optional(),
  transferableHint: z.string().min(1).max(1_000).optional(),
  evidence: z.array(EvidenceRefSchema).min(2).max(24),
}).strict()

const ImpactLevelSchema = z.enum(['none', 'low', 'medium', 'high'])

export const ExperienceDraftSchema = z.object({
  title: z.string().min(1).max(160),
  category: ExperienceCategorySchema,
  applicability: z.object({
    context: z.string().min(1).max(2_000),
    cues: z.array(z.string().min(1).max(500)).min(1).max(12),
    prerequisites: z.array(z.string().min(1).max(500)).max(12),
    excludes: z.array(z.string().min(1).max(500)).min(1).max(12),
  }).strict(),
  policyDelta: z.object({
    previousApproach: z.string().min(1).max(2_000).optional(),
    recommendedAction: z.string().min(1).max(2_000),
    avoidAction: z.string().min(1).max(2_000).optional(),
    expectedEffect: z.string().min(1).max(2_000),
  }).strict(),
  mechanism: z.string().min(1).max(2_000),
  verification: z.object({
    checks: z.array(z.string().min(1).max(500)).min(1).max(12),
    successSignals: z.array(z.string().min(1).max(500)).min(1).max(12),
    failureSignals: z.array(z.string().min(1).max(500)).min(1).max(12),
  }).strict(),
  impact: z.object({
    reliability: ImpactLevelSchema,
    stability: ImpactLevelSchema,
    effectiveness: ImpactLevelSchema,
    rationale: z.array(z.string().min(1).max(500)).min(1).max(12),
    observedMetrics: z.record(z.string(), z.number()).optional(),
  }).strict(),
}).strict()

export const LearningProposalSchema = z.object({
  schemaVersion: z.literal('learning-proposal-1.0'),
  id: z.string().regex(/^proposal_[a-f0-9]{24}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.number(),
  source: z.object({
    reviewerRunId: z.string().min(1),
    windowId: z.string().min(1),
    windowHash: z.string().regex(/^[a-f0-9]{64}$/),
    proposalIndex: z.number().int().nonnegative().max(2),
    trigger: z.string().min(1),
    trajectoryIds: z.array(z.string().uuid()).min(1),
    analyzerId: z.string().min(1),
    /** Present for task-level Reviewer mode proposals; absent on legacy windows. */
    caseId: z.string().regex(/^case_[a-f0-9]{24}$/).optional(),
    taskReviewId: z.string().regex(/^task_review_[a-f0-9]{24}$/).optional(),
    findingId: z.string().regex(/^finding_[a-f0-9]{24}$/).optional(),
  }).strict(),
  moment: LearningMomentSchema,
  experienceDraft: ExperienceDraftSchema,
  review: z.object({
    decision: z.enum(['approved', 'rejected']),
    reviewedAt: z.number(),
    reviewedBy: z.literal('human'),
    note: z.string().max(2_000).optional(),
  }).strict().optional(),
}).strict().superRefine((proposal, ctx) => {
  if (proposal.status === 'pending' && proposal.review !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'pending proposal cannot contain a review decision', path: ['review'] })
  }
  if (proposal.status !== 'pending' && proposal.review?.decision !== proposal.status) {
    ctx.addIssue({
      code: 'custom',
      message: `${proposal.status} proposal must contain the matching human review decision`,
      path: ['review'],
    })
  }
})

export const ExperienceCandidateSchema = z.object({
  schemaVersion: z.literal('experience-candidate-1.0'),
  id: z.string().regex(/^candidate_[a-f0-9]{24}$/),
  proposalId: z.string().regex(/^proposal_[a-f0-9]{24}$/),
  revision: z.number().int().positive(),
  status: z.literal('approved'),
  approvedAt: z.number(),
  approvedBy: z.literal('human'),
  reviewNote: z.string().max(2_000).optional(),
  title: z.string().min(1).max(160),
  category: ExperienceCategorySchema,
  applicability: ExperienceDraftSchema.shape.applicability,
  policyDelta: ExperienceDraftSchema.shape.policyDelta,
  mechanism: z.string().min(1).max(2_000),
  verification: ExperienceDraftSchema.shape.verification,
  impact: ExperienceDraftSchema.shape.impact,
  evidence: z.object({
    supportingMomentIds: z.array(z.string().min(1)).min(1),
    contradictingMomentIds: z.array(z.string().min(1)),
    independentTrajectories: z.number().int().positive(),
    independentWorkspaces: z.number().int().nonnegative(),
  }).strict(),
  confidence: z.enum(['hypothesis', 'observed', 'reproduced']),
}).strict()

/** Model boundary: evidence ordinals are hydrated and verified by the host. */
export const ModelLearningProposalSchema = z.object({
  moment: z.object({
    kind: LearningMomentKindSchema,
    taskSummary: z.string().min(1).max(2_000),
    taskFamily: z.string().min(1).max(160).optional(),
    relevantState: z.array(z.string().min(1).max(500)).max(12).default([]),
    expectation: z.object({
      statement: z.string().min(1).max(2_000),
      source: z.enum(['agent_explicit', 'task_contract', 'action_implied', 'reviewer_inferred']),
      confidence: z.enum(['high', 'medium', 'low']),
    }).strict().optional(),
    action: z.string().min(1).max(2_000),
    observedOutcome: z.string().min(1).max(2_000),
    feedback: z.string().min(1).max(2_000).optional(),
    correction: z.string().min(1).max(2_000).optional(),
    correctedOutcome: z.string().min(1).max(2_000).optional(),
    transferableHint: z.string().min(1).max(1_000).optional(),
    evidence: z.array(z.object({
      ordinal: z.number().int().positive(),
      role: EvidenceRoleSchema,
    }).strict()).min(2).max(24),
  }).strict(),
  experienceDraft: ExperienceDraftSchema,
}).strict()

export const ModelLearningReviewSchema = z.object({
  proposals: z.array(ModelLearningProposalSchema).max(3),
  noLearningReason: z.string().min(1).max(2_000).optional(),
}).strict().refine(value => value.proposals.length > 0 || Boolean(value.noLearningReason), {
  message: 'review must contain proposals or a noLearningReason',
})

// ── Task-level Reviewer mode ────────────────────────────────────────────────

export const ModelTaskEvidencePointerSchema = z.object({
  trajectoryId: z.string().uuid(),
  ordinal: z.number().int().positive(),
}).strict()

export const TaskEvidenceRefSchema = ModelTaskEvidencePointerSchema.extend({
  itemType: z.string().min(1),
}).strict()

const TaskClaimSchema = z.object({
  statement: z.string().min(1).max(2_000),
  epistemicStatus: z.enum(['observed', 'inferred', 'unknown']),
  evidence: z.array(TaskEvidenceRefSchema).max(16),
}).strict().superRefine((claim, ctx) => {
  if (claim.epistemicStatus !== 'unknown' && claim.evidence.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'observed and inferred claims require evidence', path: ['evidence'] })
  }
})

const ModelTaskClaimSchema = z.object({
  statement: z.string().min(1).max(2_000),
  epistemicStatus: z.enum(['observed', 'inferred', 'unknown']),
  evidence: z.array(ModelTaskEvidencePointerSchema).max(16),
}).strict()

const TaskDecisionSchema = z.object({
  decision: z.string().min(1).max(2_000),
  rationale: z.string().min(1).max(2_000),
  alternativesConsidered: z.array(z.string().min(1).max(1_000)).max(8),
  outcome: z.string().min(1).max(2_000),
  evidence: z.array(TaskEvidenceRefSchema).min(1).max(16),
}).strict()

const ModelTaskDecisionSchema = z.object({
  decision: z.string().min(1).max(2_000),
  rationale: z.string().min(1).max(2_000),
  alternativesConsidered: z.array(z.string().min(1).max(1_000)).max(8),
  outcome: z.string().min(1).max(2_000),
  evidence: z.array(ModelTaskEvidencePointerSchema).min(1).max(16),
}).strict()

const TaskCriterionCheckSchema = z.object({
  criterion: z.string().min(1).max(1_000),
  status: z.enum(['met', 'partially_met', 'not_met', 'unknown']),
  rationale: z.string().min(1).max(2_000),
  evidence: z.array(TaskEvidenceRefSchema).max(16),
}).strict().superRefine((criterion, ctx) => {
  if (criterion.status !== 'unknown' && criterion.evidence.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'non-unknown criterion checks require evidence', path: ['evidence'] })
  }
})

const ModelTaskCriterionCheckSchema = z.object({
  criterion: z.string().min(1).max(1_000),
  status: z.enum(['met', 'partially_met', 'not_met', 'unknown']),
  rationale: z.string().min(1).max(2_000),
  evidence: z.array(ModelTaskEvidencePointerSchema).max(16),
}).strict()

export const TaskAssessmentRatingSchema = z.enum(['strong', 'adequate', 'weak', 'unknown'])

const TaskAssessmentDimensionSchema = z.object({
  rating: TaskAssessmentRatingSchema,
  rationale: z.string().min(1).max(2_000),
  evidence: z.array(TaskEvidenceRefSchema).max(16),
}).strict().superRefine((dimension, ctx) => {
  if (dimension.rating !== 'unknown' && dimension.evidence.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'rated assessment dimensions require evidence', path: ['evidence'] })
  }
})

const ModelTaskAssessmentDimensionSchema = z.object({
  rating: TaskAssessmentRatingSchema,
  rationale: z.string().min(1).max(2_000),
  evidence: z.array(ModelTaskEvidencePointerSchema).max(16),
}).strict()

/** @deprecated Categories used by task-review-1.0 domain-oriented findings. */
export const LegacyTaskFindingCategorySchema = z.enum([
  'success_strategy',
  'outcome_gap',
  'decision_gap',
  'process_fragility',
  'efficiency_opportunity',
  'local_hygiene',
  'evidence_gap',
])

/**
 * Task-review-2.0 findings describe the Agent's problem-solving method. Domain
 * facts may support them as evidence, but are not themselves reviewer output.
 */
export const TaskFindingCategorySchema = z.enum([
  'solution_strategy',
  'path_selection',
  'success_criteria',
  'completion_integrity',
  'information_management',
  'long_horizon_control',
  'verification_strategy',
  'efficiency_strategy',
])

export const TaskFindingSignificanceSchema = z.enum(['critical', 'major', 'minor', 'observation'])

const TaskFindingBodySchema = z.object({
  category: TaskFindingCategorySchema,
  significance: TaskFindingSignificanceSchema,
  abstractionLevel: z.enum(['task_specific', 'task_family', 'cross_task']),
  summary: z.string().min(1).max(2_000),
  mechanism: z.string().min(1).max(2_000),
  recommendation: z.string().min(1).max(2_000),
  expectedImpact: z.string().min(1).max(2_000),
  candidateEligible: z.boolean(),
})

export const TaskFindingSchema = TaskFindingBodySchema.extend({
  id: z.string().regex(/^finding_[a-f0-9]{24}$/),
  evidence: z.array(TaskEvidenceRefSchema).min(1).max(24),
}).strict()

const ModelTaskFindingSchema = TaskFindingBodySchema.extend({
  evidence: z.array(ModelTaskEvidencePointerSchema).min(1).max(24),
}).strict()

const LegacyTaskFindingSchema = z.object({
  id: z.string().regex(/^finding_[a-f0-9]{24}$/),
  category: LegacyTaskFindingCategorySchema,
  significance: TaskFindingSignificanceSchema,
  summary: z.string().min(1).max(2_000),
  mechanism: z.string().min(1).max(2_000),
  recommendation: z.string().min(1).max(2_000),
  expectedImpact: z.string().min(1).max(2_000),
  candidateEligible: z.boolean(),
  evidence: z.array(TaskEvidenceRefSchema).min(1).max(24),
}).strict()

const ModelSolutionPhaseSchema = z.object({
  phase: z.string().min(1).max(300),
  objective: z.string().min(1).max(1_000),
  strategy: z.string().min(1).max(2_000),
  outcome: z.string().min(1).max(2_000),
  evidence: z.array(ModelTaskEvidencePointerSchema).min(1).max(16),
}).strict()

const SolutionPhaseSchema = ModelSolutionPhaseSchema.extend({
  evidence: z.array(TaskEvidenceRefSchema).min(1).max(16),
}).strict()

const ModelProcessAuditDimensionSchema = <T extends z.ZodTypeAny>(verdict: T) => z.object({
  verdict,
  rationale: z.string().min(1).max(3_000),
  evidence: z.array(ModelTaskEvidencePointerSchema).max(24),
}).strict()

const ProcessAuditDimensionSchema = <T extends z.ZodTypeAny>(verdict: T) => z.object({
  verdict,
  rationale: z.string().min(1).max(3_000),
  evidence: z.array(TaskEvidenceRefSchema).max(24),
}).strict()

const LongHorizonIssueTypeSchema = z.enum([
  'information_omission',
  'memory_loss',
  'noise_accumulation',
  'goal_drift',
])

const LongHorizonIssueStatusSchema = z.enum(['observed', 'suspected', 'not_observed', 'unknown'])

const ModelLongHorizonIssueSchema = z.object({
  type: LongHorizonIssueTypeSchema,
  status: LongHorizonIssueStatusSchema,
  summary: z.string().min(1).max(2_000),
  evidence: z.array(ModelTaskEvidencePointerSchema).max(16),
}).strict()

const LongHorizonIssueSchema = ModelLongHorizonIssueSchema.extend({
  evidence: z.array(TaskEvidenceRefSchema).max(16),
}).strict()

const ModelProcessAuditSchema = z.object({
  solutionPath: z.object({
    summary: z.string().min(1).max(3_000),
    phases: z.array(ModelSolutionPhaseSchema).min(1).max(16),
  }).strict(),
  pathQuality: ModelProcessAuditDimensionSchema(
    z.enum(['optimal', 'reasonable', 'suboptimal', 'misdirected', 'unknown']),
  ).extend({
    betterPath: z.array(z.string().min(1).max(1_000)).max(12),
  }).strict(),
  successCriteriaQuality: ModelProcessAuditDimensionSchema(
    z.enum(['appropriate', 'partially_appropriate', 'inappropriate', 'unknown']),
  ).extend({
    missingCriteria: z.array(z.string().min(1).max(1_000)).max(12),
    misleadingCriteria: z.array(z.string().min(1).max(1_000)).max(12),
  }).strict(),
  completionIntegrity: ModelProcessAuditDimensionSchema(
    z.enum(['well_supported', 'overclaimed', 'underclaimed', 'honest_uncertainty', 'unknown']),
  ).extend({
    unsupportedClaims: z.array(z.string().min(1).max(1_000)).max(12),
    unresolvedIssues: z.array(z.string().min(1).max(1_000)).max(12),
  }).strict(),
  informationAdequacy: ModelProcessAuditDimensionSchema(
    z.enum(['sufficient', 'partially_sufficient', 'insufficient', 'unknown']),
  ).extend({
    notAvailableToAgent: z.array(z.string().min(1).max(1_000)).max(12),
    availableButNotSought: z.array(z.string().min(1).max(1_000)).max(12),
    reviewerVisibilityGaps: z.array(z.string().min(1).max(1_000)).max(12),
  }).strict(),
  longHorizonControl: ModelProcessAuditDimensionSchema(
    z.enum(['controlled', 'degraded', 'failed', 'not_applicable', 'unknown']),
  ).extend({
    continuityMechanisms: z.array(z.string().min(1).max(1_000)).max(12),
    issues: z.array(ModelLongHorizonIssueSchema).max(12),
  }).strict(),
}).strict().superRefine((audit, ctx) => {
  addProcessAuditEvidenceIssues(audit, ctx)
})

const ProcessAuditSchema = z.object({
  solutionPath: z.object({
    summary: z.string().min(1).max(3_000),
    phases: z.array(SolutionPhaseSchema).min(1).max(16),
  }).strict(),
  pathQuality: ProcessAuditDimensionSchema(
    z.enum(['optimal', 'reasonable', 'suboptimal', 'misdirected', 'unknown']),
  ).extend({
    betterPath: z.array(z.string().min(1).max(1_000)).max(12),
  }).strict(),
  successCriteriaQuality: ProcessAuditDimensionSchema(
    z.enum(['appropriate', 'partially_appropriate', 'inappropriate', 'unknown']),
  ).extend({
    missingCriteria: z.array(z.string().min(1).max(1_000)).max(12),
    misleadingCriteria: z.array(z.string().min(1).max(1_000)).max(12),
  }).strict(),
  completionIntegrity: ProcessAuditDimensionSchema(
    z.enum(['well_supported', 'overclaimed', 'underclaimed', 'honest_uncertainty', 'unknown']),
  ).extend({
    unsupportedClaims: z.array(z.string().min(1).max(1_000)).max(12),
    unresolvedIssues: z.array(z.string().min(1).max(1_000)).max(12),
  }).strict(),
  informationAdequacy: ProcessAuditDimensionSchema(
    z.enum(['sufficient', 'partially_sufficient', 'insufficient', 'unknown']),
  ).extend({
    notAvailableToAgent: z.array(z.string().min(1).max(1_000)).max(12),
    availableButNotSought: z.array(z.string().min(1).max(1_000)).max(12),
    reviewerVisibilityGaps: z.array(z.string().min(1).max(1_000)).max(12),
  }).strict(),
  longHorizonControl: ProcessAuditDimensionSchema(
    z.enum(['controlled', 'degraded', 'failed', 'not_applicable', 'unknown']),
  ).extend({
    continuityMechanisms: z.array(z.string().min(1).max(1_000)).max(12),
    issues: z.array(LongHorizonIssueSchema).max(12),
  }).strict(),
}).strict().superRefine((audit, ctx) => {
  addProcessAuditEvidenceIssues(audit, ctx)
})

function addProcessAuditEvidenceIssues(
  audit: {
    pathQuality: { verdict: string; evidence: readonly unknown[] }
    successCriteriaQuality: { verdict: string; evidence: readonly unknown[] }
    completionIntegrity: { verdict: string; evidence: readonly unknown[] }
    informationAdequacy: { verdict: string; evidence: readonly unknown[] }
    longHorizonControl: {
      verdict: string
      evidence: readonly unknown[]
      issues: readonly { status: string; evidence: readonly unknown[] }[]
    }
  },
  ctx: z.RefinementCtx,
): void {
  for (const [name, dimension] of Object.entries({
    pathQuality: audit.pathQuality,
    successCriteriaQuality: audit.successCriteriaQuality,
    completionIntegrity: audit.completionIntegrity,
    informationAdequacy: audit.informationAdequacy,
    longHorizonControl: audit.longHorizonControl,
  })) {
    if (dimension.verdict !== 'unknown' && dimension.evidence.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'non-unknown process audit verdicts require evidence',
        path: [name, 'evidence'],
      })
    }
  }
  for (const [index, issue] of audit.longHorizonControl.issues.entries()) {
    if ((issue.status === 'observed' || issue.status === 'suspected') && issue.evidence.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'observed or suspected long-horizon issues require evidence',
        path: ['longHorizonControl', 'issues', index, 'evidence'],
      })
    }
  }
}

const ModelTaskLearningMomentSchema = ModelLearningProposalSchema.shape.moment.extend({
  evidence: z.array(ModelTaskEvidencePointerSchema.extend({
    role: EvidenceRoleSchema,
  }).strict()).min(2).max(24),
}).strict()

export const ModelTaskLearningProposalSchema = z.object({
  findingIndex: z.number().int().nonnegative(),
  moment: ModelTaskLearningMomentSchema,
  experienceDraft: ExperienceDraftSchema,
}).strict()

const ModelTaskReviewBodySchema = z.object({
  task: z.object({
    goal: z.string().min(1).max(3_000),
    constraints: z.array(z.string().min(1).max(1_000)).max(16),
    successCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(16),
  }).strict(),
  observations: z.array(ModelTaskClaimSchema).min(1).max(24),
  decisions: z.array(ModelTaskDecisionSchema).max(24),
  outcome: z.object({
    verdict: z.enum(['solved', 'partial', 'failed', 'unknown']),
    summary: z.string().min(1).max(3_000),
    criteria: z.array(ModelTaskCriterionCheckSchema).min(1).max(16),
  }).strict(),
  assessment: z.object({
    effectiveness: ModelTaskAssessmentDimensionSchema,
    reliability: ModelTaskAssessmentDimensionSchema,
    stability: ModelTaskAssessmentDimensionSchema,
    efficiency: ModelTaskAssessmentDimensionSchema,
  }).strict(),
  processAudit: ModelProcessAuditSchema,
  methodologyFindings: z.array(ModelTaskFindingSchema).max(16),
})

/**
 * First-stage envelope: the TaskReview body stays strict, while proposal
 * candidates are isolated so one malformed optional candidate cannot discard
 * an otherwise valid retrospective.
 */
export const ModelTaskReviewEnvelopeSchema = ModelTaskReviewBodySchema.extend({
  proposalCandidates: z.array(z.unknown()).max(3),
  noProposalReason: z.string().min(1).max(2_000).optional(),
}).strict()

/** Strict structured output after candidates have been normalized and checked individually. */
export const ModelTaskReviewSchema = ModelTaskReviewBodySchema.extend({
  proposalCandidates: z.array(ModelTaskLearningProposalSchema).max(3),
  noProposalReason: z.string().min(1).max(2_000).optional(),
}).strict().superRefine((review, ctx) => {
  if (review.proposalCandidates.length === 0 && !review.noProposalReason) {
    ctx.addIssue({ code: 'custom', message: 'noProposalReason is required when no proposal candidate is emitted' })
  }
  for (const [index, proposal] of review.proposalCandidates.entries()) {
    if (proposal.findingIndex >= review.methodologyFindings.length) {
      ctx.addIssue({
        code: 'custom',
        message: `proposal candidate ${index} references missing finding ${proposal.findingIndex}`,
        path: ['proposalCandidates', index, 'findingIndex'],
      })
    }
  }
})

const TaskReviewCommonBodySchema = z.object({
  id: z.string().regex(/^task_review_[a-f0-9]{24}$/),
  caseId: z.string().regex(/^case_[a-f0-9]{24}$/),
  rootTrajectoryId: z.string().uuid(),
  trajectoryIds: z.array(z.string().uuid()).min(1),
  createdAt: z.number(),
  source: z.object({
    reviewerRunId: z.string().regex(/^review_[a-f0-9]{24}$/),
    reviewerSessionId: z.string().min(1),
    analyzerId: z.string().min(1),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  task: z.object({
    goal: z.string().min(1).max(3_000),
    constraints: z.array(z.string().min(1).max(1_000)).max(16),
    successCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(16),
  }).strict(),
  observations: z.array(TaskClaimSchema).min(1).max(24),
  decisions: z.array(TaskDecisionSchema).max(24),
  outcome: z.object({
    verdict: z.enum(['solved', 'partial', 'failed', 'unknown']),
    summary: z.string().min(1).max(3_000),
    criteria: z.array(TaskCriterionCheckSchema).min(1).max(16),
  }).strict(),
  assessment: z.object({
    effectiveness: TaskAssessmentDimensionSchema,
    reliability: TaskAssessmentDimensionSchema,
    stability: TaskAssessmentDimensionSchema,
    efficiency: TaskAssessmentDimensionSchema,
  }).strict(),
  proposalIds: z.array(z.string().regex(/^proposal_[a-f0-9]{24}$/)).max(3),
  noProposalReason: z.string().min(1).max(2_000).optional(),
})

const LegacyTaskReviewSchema = TaskReviewCommonBodySchema.extend({
  schemaVersion: z.literal('task-review-1.0'),
  findings: z.array(LegacyTaskFindingSchema).max(24),
}).strict()

const TaskReviewV2Schema = TaskReviewCommonBodySchema.extend({
  schemaVersion: z.literal('task-review-2.0'),
  processAudit: ProcessAuditSchema,
  methodologyFindings: z.array(TaskFindingSchema).max(16),
}).strict().superRefine((review, ctx) => {
  if (review.outcome.verdict === 'solved') {
    for (const [index, criterion] of review.outcome.criteria.entries()) {
      if (criterion.status !== 'met') {
        ctx.addIssue({
          code: 'custom',
          message: 'a solved task requires every declared success criterion to be met',
          path: ['outcome', 'criteria', index, 'status'],
        })
      }
    }
  }
})

/** Reads legacy reports while all new Reviewer runs emit task-review-2.0. */
export const TaskReviewSchema = z.union([TaskReviewV2Schema, LegacyTaskReviewSchema])

export const TaskReviewerRunManifestSchema = z.object({
  schemaVersion: z.literal('task-review-run-2.0'),
  runId: z.string().regex(/^review_[a-f0-9]{24}$/),
  createdAt: z.number(),
  completedAt: z.number(),
  analyzerId: z.string().min(1),
  scope: z.object({
    all: z.boolean(),
    limit: z.number().int().positive().optional(),
    trajectoryId: z.string().optional(),
    workspace: z.string().optional(),
    since: z.number().optional(),
    maxCases: z.number().int().positive(),
    maxTurnsPerCase: z.number().int().positive(),
    maxBudgetUsd: z.number().positive(),
    force: z.boolean(),
  }).strict(),
  inputHashes: z.record(z.string(), z.string()),
  completedCaseIds: z.array(z.string().regex(/^case_[a-f0-9]{24}$/)),
  stats: z.object({
    casesSelected: z.number().int().nonnegative(),
    casesAnalyzed: z.number().int().nonnegative(),
    casesSkipped: z.number().int().nonnegative(),
    casesUnchanged: z.number().int().nonnegative(),
    trajectoriesIncluded: z.number().int().nonnegative(),
    kernelSessions: z.number().int().nonnegative(),
    kernelTurns: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    proposalsGenerated: z.number().int().nonnegative(),
    proposalsDeduplicated: z.number().int().nonnegative(),
    qualityRejections: z.number().int().nonnegative(),
    analysisErrors: z.number().int().nonnegative(),
  }).strict(),
  taskReviewIds: z.array(z.string().regex(/^task_review_[a-f0-9]{24}$/)),
  proposalIds: z.array(z.string().regex(/^proposal_[a-f0-9]{24}$/)),
  skipped: z.array(z.object({ caseId: z.string(), reason: z.string() }).strict()),
  qualityRejections: z.array(z.object({
    caseId: z.string(),
    proposalIndex: z.number().int().nonnegative(),
    reason: z.string(),
  }).strict()),
  analysisErrors: z.array(z.object({
    caseId: z.string(),
    error: z.string(),
    rawResponseArtifact: z.string().regex(/^analysis\/case_[a-f0-9]{24}\.raw-response\.txt$/).optional(),
  }).strict()),
}).strict()

export const ReviewerRunManifestSchema = z.object({
  schemaVersion: z.literal('trajectory-review-run-1.0'),
  runId: z.string().regex(/^review_[a-f0-9]{24}$/),
  createdAt: z.number(),
  completedAt: z.number(),
  analyzerId: z.string().min(1),
  scope: z.object({
    all: z.boolean(),
    limit: z.number().int().positive().optional(),
    trajectoryId: z.string().optional(),
    workspace: z.string().optional(),
    since: z.number().optional(),
    maxWindows: z.number().int().positive(),
    force: z.boolean(),
  }).strict(),
  inputHashes: z.record(z.string(), z.string()),
  completedTrajectoryIds: z.array(z.string()),
  completedWindowKeys: z.array(z.string().min(1)),
  stats: z.object({
    trajectoriesSelected: z.number().int().nonnegative(),
    trajectoriesScanned: z.number().int().nonnegative(),
    trajectoriesSkipped: z.number().int().nonnegative(),
    trajectoriesUnchanged: z.number().int().nonnegative(),
    candidateWindows: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    windowsSkippedBudget: z.number().int().nonnegative(),
    windowsPreviouslyReviewed: z.number().int().nonnegative(),
    proposalsGenerated: z.number().int().nonnegative(),
    proposalsDeduplicated: z.number().int().nonnegative(),
    noLearningWindows: z.number().int().nonnegative(),
    qualityRejections: z.number().int().nonnegative(),
    analysisErrors: z.number().int().nonnegative(),
    unknownVerdicts: z.number().int().nonnegative(),
  }).strict(),
  proposalIds: z.array(z.string()),
  skipped: z.array(z.object({ trajectoryId: z.string(), reason: z.string() }).strict()),
  noLearning: z.array(z.object({ windowId: z.string(), reason: z.string() }).strict()),
  qualityRejections: z.array(z.object({ windowId: z.string(), proposalIndex: z.number().int().nonnegative(), reason: z.string() }).strict()),
  analysisErrors: z.array(z.object({ windowId: z.string(), error: z.string() }).strict()),
  unknownVerdicts: z.array(z.object({
    trajectoryId: z.string().uuid(),
    ordinal: z.number().int().positive(),
    evaluator: z.string().min(1),
    verdict: z.string(),
  }).strict()),
}).strict()

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>
export type LearningMoment = z.infer<typeof LearningMomentSchema>
export type ExperienceDraft = z.infer<typeof ExperienceDraftSchema>
export type LearningProposal = z.infer<typeof LearningProposalSchema>
export type ExperienceCandidate = z.infer<typeof ExperienceCandidateSchema>
export type ModelLearningProposal = z.infer<typeof ModelLearningProposalSchema>
export type ModelLearningReview = z.infer<typeof ModelLearningReviewSchema>
export type ReviewerRunManifest = z.infer<typeof ReviewerRunManifestSchema>
export type ModelTaskEvidencePointer = z.infer<typeof ModelTaskEvidencePointerSchema>
export type TaskEvidenceRef = z.infer<typeof TaskEvidenceRefSchema>
export type TaskFinding = z.infer<typeof TaskFindingSchema>
export type ModelTaskLearningProposal = z.infer<typeof ModelTaskLearningProposalSchema>
export type ModelTaskReview = z.infer<typeof ModelTaskReviewSchema>
export type TaskReview = z.infer<typeof TaskReviewSchema>
export type TaskReviewerRunManifest = z.infer<typeof TaskReviewerRunManifestSchema>
