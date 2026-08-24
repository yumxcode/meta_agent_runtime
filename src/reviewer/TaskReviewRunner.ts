import { createHash } from 'node:crypto'
import type { PreservedTrajectoryLine } from '../trajectory/types.js'
import {
  newReviewerRunId,
  ReviewerStore,
  taskProposalCaseKey,
  taskReviewedInputKey,
} from './ReviewerStore.js'
import {
  listTaskCaseDescriptors,
  loadTaskCase,
  type TaskCase,
  type TaskCaseScope,
} from './TaskCase.js'
import type {
  ReviewerSessionProgressEvent,
  TaskCaseReviewResult,
  TaskCaseReviewer,
} from './ReviewerSession.js'
import { parseReviewerOutput, ReviewerSessionExecutionError } from './ReviewerSession.js'
import { redactTaskSummary } from './TrajectoryReviewScanner.js'
import {
  LearningMomentSchema,
  ModelTaskReviewSchema,
  TaskReviewSchema,
  TaskReviewerRunManifestSchema,
  type LearningMoment,
  type ModelTaskEvidencePointer,
  type ModelTaskLearningProposal,
  type ModelTaskReview,
  type TaskEvidenceRef,
  type TaskFinding,
  type TaskReview,
  type TaskReviewerRunManifest,
} from './types.js'

const DEFAULT_CASE_LIMIT = 20
const DEFAULT_MAX_CASES = 20
const DEFAULT_MAX_TURNS_PER_CASE = 12
const DEFAULT_MAX_BUDGET_USD = 5

export interface TaskReviewerScope extends TaskCaseScope {
  maxCases?: number
  maxTurnsPerCase?: number
  maxBudgetUsd?: number
  force?: boolean
}

export type TaskReviewerProgressEvent =
  | { phase: 'start'; cases: number; trajectories: number; maxCases: number; maxBudgetUsd: number }
  | { phase: 'case'; index: number; total: number; caseId: string; trajectories: number }
  | { phase: 'recovery'; caseId: string; sourceRunId: string }
  | { phase: 'session'; caseId: string; session: number; maxCases: number }
  | { phase: 'kernel'; caseId: string; event: ReviewerSessionProgressEvent }

export interface RunTaskReviewsOptions {
  reviewer: TaskCaseReviewer
  scope?: TaskReviewerScope
  trajectoryRootDir?: string
  reviewerRootDir?: string
  now?: () => number
  onProgress?: (event: TaskReviewerProgressEvent) => void
}

export interface RunTaskReviewsResult {
  manifest: TaskReviewerRunManifest
  report: string
  taskReviews: TaskReview[]
}

/** Task-centric Reviewer runner. The legacy window runner remains for API compatibility. */
export async function runTaskReviews(options: RunTaskReviewsOptions): Promise<RunTaskReviewsResult> {
  const now = options.now ?? Date.now
  const createdAt = now()
  const runId = newReviewerRunId()
  const scope = normalizeTaskReviewerScope(options.scope)
  const store = new ReviewerStore(options.reviewerRootDir)
  const descriptors = await listTaskCaseDescriptors(scope, { rootDir: options.trajectoryRootDir })
  const history = await store.taskReviewedState(options.reviewer.id)
  const inputHashes: Record<string, string> = {}
  const completedCaseIds = new Set<string>()
  const taskReviewIds: string[] = []
  const proposalIds: string[] = []
  const skipped: TaskReviewerRunManifest['skipped'] = []
  const qualityRejections: TaskReviewerRunManifest['qualityRejections'] = []
  const analysisErrors: TaskReviewerRunManifest['analysisErrors'] = []
  const taskReviews: TaskReview[] = []
  let casesAnalyzed = 0
  let casesUnchanged = 0
  let trajectoriesIncluded = 0
  let kernelSessions = 0
  let kernelTurns = 0
  let toolCalls = 0
  let costUsd = 0
  let proposalsGenerated = 0
  let proposalsDeduplicated = 0

  options.onProgress?.({
    phase: 'start',
    cases: descriptors.length,
    trajectories: descriptors.reduce((total, item) => total + item.entries.length, 0),
    maxCases: scope.maxCases,
    maxBudgetUsd: scope.maxBudgetUsd,
  })

  for (const [index, descriptor] of descriptors.entries()) {
    options.onProgress?.({
      phase: 'case',
      index: index + 1,
      total: descriptors.length,
      caseId: descriptor.caseId,
      trajectories: descriptor.entries.length,
    })
    if (casesAnalyzed >= scope.maxCases) {
      skipped.push({ caseId: descriptor.caseId, reason: 'case budget exhausted (--max-cases)' })
      continue
    }
    const remainingBudgetUsd = scope.maxBudgetUsd - costUsd
    if (remainingBudgetUsd <= 0) {
      skipped.push({ caseId: descriptor.caseId, reason: 'reviewer USD budget exhausted' })
      continue
    }
    const taskCase = await loadTaskCase(descriptor, { rootDir: options.trajectoryRootDir })
    if ('reason' in taskCase) {
      skipped.push({ caseId: taskCase.caseId, reason: taskCase.reason })
      continue
    }
    trajectoriesIncluded += taskCase.members.length
    inputHashes[taskCase.id] = taskCase.inputHash
    const reviewedKey = taskReviewedInputKey(taskCase.id, taskCase.inputHash, options.reviewer.id)
    const previouslyCompleted = history.completedCaseKeys.has(reviewedKey)
    const hasProposalIdentity = history.proposalCaseKeys.has(taskProposalCaseKey(taskCase.id, options.reviewer.id))
    if (previouslyCompleted && (!scope.force || hasProposalIdentity)) {
      casesUnchanged++
      completedCaseIds.add(taskCase.id)
      skipped.push({
        caseId: taskCase.id,
        reason: hasProposalIdentity
          ? 'completed task case already has an immutable LearningProposal identity'
          : 'unchanged since completed task review',
      })
      continue
    }
    try {
      let result: TaskCaseReviewResult | undefined
      const recoverable = await store.findRecoverableTaskResponse(
        taskCase.id,
        taskCase.inputHash,
        options.reviewer.id,
      )
      if (recoverable) {
        try {
          const parsed = parseReviewerOutput(recoverable.rawResponse)
          result = {
            draft: parsed.draft,
            reviewerSessionId: `recovered:${recoverable.sourceRunId}`,
            turns: 0,
            toolCalls: 0,
            costUsd: 0,
            proposalCandidateIndices: parsed.proposalCandidateIndices,
            proposalRejections: parsed.proposalRejections,
          }
          options.onProgress?.({
            phase: 'recovery',
            caseId: taskCase.id,
            sourceRunId: recoverable.sourceRunId,
          })
        } catch {
          // The parser may still be unable to salvage an older artifact. A
          // fresh Kernel session remains the authoritative fallback.
        }
      }
      if (!result) {
        kernelSessions++
        options.onProgress?.({
          phase: 'session',
          caseId: taskCase.id,
          session: kernelSessions,
          maxCases: scope.maxCases,
        })
        result = await options.reviewer.review(taskCase, {
          reviewerRunId: runId,
          maxTurns: scope.maxTurnsPerCase,
          maxBudgetUsd: remainingBudgetUsd,
          onProgress: event => options.onProgress?.({ phase: 'kernel', caseId: taskCase.id, event }),
        })
      }
      casesAnalyzed++
      kernelTurns += result.turns
      toolCalls += result.toolCalls
      costUsd += result.costUsd
      for (const rejection of result.proposalRejections ?? []) {
        qualityRejections.push({
          caseId: taskCase.id,
          proposalIndex: rejection.proposalIndex,
          reason: `proposal schema rejected: ${rejection.reason}`,
        })
      }
      const sanitizedDraft = sanitizeModelDraft(result.draft, taskCase.workspace)
      const review = materializeTaskReview({
        taskCase,
        draft: sanitizedDraft,
        reviewerRunId: runId,
        reviewerSessionId: result.reviewerSessionId,
        analyzerId: options.reviewer.id,
        createdAt: now(),
      })
      // Persist the evidence-backed retrospective before proposals reference it.
      // If the process dies during proposal writes, the absent completed run
      // manifest makes the case retryable and stable proposal identities repair
      // the partial commit on the next run.
      await store.writeTaskReview(review)
      const storedProposalIds: string[] = []
      for (const [proposalIndex, candidate] of sanitizedDraft.proposalCandidates.entries()) {
        const sourceProposalIndex = result.proposalCandidateIndices?.[proposalIndex] ?? proposalIndex
        let finding: TaskFinding
        let moment: LearningMoment
        try {
          if (review.schemaVersion !== 'task-review-2.0') {
            throw new Error('new methodology proposals require task-review-2.0')
          }
          const linkedFinding = review.methodologyFindings[candidate.findingIndex]
          if (!linkedFinding) throw new Error(`proposal references missing finding ${candidate.findingIndex}`)
          finding = linkedFinding
          assertHighValueFinding(finding, candidate, review)
          moment = materializeTaskLearningMoment(taskCase, candidate)
        } catch (error) {
          qualityRejections.push({
            caseId: taskCase.id,
            proposalIndex: sourceProposalIndex,
            reason: error instanceof Error ? error.message : String(error),
          })
          continue
        }
        // Persistence failures are operational analysis errors, not model
        // quality failures; let the outer case boundary record/retry them.
        const evidenceTrajectories = [...new Set(moment.evidence.map(ref => ref.trajectoryId))]
        const stored = await store.addProposal({
          source: {
            reviewerRunId: runId,
            windowId: `${taskCase.id}:${finding.id}`,
            windowHash: taskCase.inputHash,
            proposalIndex: sourceProposalIndex,
            trigger: `task_review:${finding.category}`,
            trajectoryIds: evidenceTrajectories,
            analyzerId: options.reviewer.id,
            caseId: taskCase.id,
            taskReviewId: review.id,
            findingId: finding.id,
          },
          moment,
          experienceDraft: candidate.experienceDraft,
          now: now(),
        })
        storedProposalIds.push(stored.proposal.id)
        if (stored.duplicate) proposalsDeduplicated++
        else {
          proposalsGenerated++
          proposalIds.push(stored.proposal.id)
        }
      }
      const finalReview = TaskReviewSchema.parse({
        ...review,
        proposalIds: [...new Set(storedProposalIds)],
      })
      await store.writeTaskReview(finalReview)
      taskReviews.push(finalReview)
      taskReviewIds.push(finalReview.id)
      completedCaseIds.add(taskCase.id)
      history.completedCaseKeys.add(reviewedKey)
    } catch (error) {
      let rawResponseArtifact: string | undefined
      let artifactError: string | undefined
      if (error instanceof ReviewerSessionExecutionError) {
        kernelTurns += error.turns
        toolCalls += error.toolCalls
        costUsd += error.costUsd
        if (error.rawResponse) {
          try {
            rawResponseArtifact = await store.writeTaskRunRawResponse(
              runId,
              taskCase.id,
              redactTaskSummary(error.rawResponse, taskCase.workspace),
            )
          } catch (writeError) {
            artifactError = `; failed to preserve raw response: ${writeError instanceof Error ? writeError.message : String(writeError)}`
          }
        }
      }
      analysisErrors.push({
        caseId: taskCase.id,
        error: `${error instanceof Error ? error.message : String(error)}${artifactError ?? ''}`,
        ...(rawResponseArtifact ? { rawResponseArtifact } : {}),
      })
    }
  }

  const manifest = TaskReviewerRunManifestSchema.parse({
    schemaVersion: 'task-review-run-2.0',
    runId,
    createdAt,
    completedAt: now(),
    analyzerId: options.reviewer.id,
    scope,
    inputHashes,
    completedCaseIds: [...completedCaseIds],
    stats: {
      casesSelected: descriptors.length,
      casesAnalyzed,
      casesSkipped: skipped.length,
      casesUnchanged,
      trajectoriesIncluded,
      kernelSessions,
      kernelTurns,
      toolCalls,
      costUsd,
      proposalsGenerated,
      proposalsDeduplicated,
      qualityRejections: qualityRejections.length,
      analysisErrors: analysisErrors.length,
    },
    taskReviewIds,
    proposalIds,
    skipped,
    qualityRejections,
    analysisErrors,
  })
  const report = renderTaskReviewerRunReport(manifest, taskReviews)
  await store.writeTaskRun(manifest, report)
  return { manifest, report, taskReviews }
}

interface MaterializeTaskReviewInput {
  taskCase: TaskCase
  draft: ModelTaskReview
  reviewerRunId: string
  reviewerSessionId: string
  analyzerId: string
  createdAt: number
}

export function materializeTaskReview(input: MaterializeTaskReviewInput): TaskReview {
  const { taskCase, draft } = input
  const evidenceIndex = buildEvidenceIndex(taskCase)
  const methodologyFindings = draft.methodologyFindings.map(finding => {
    const evidence = hydrateTaskEvidence(finding.evidence, evidenceIndex)
    const id = findingIdFor(taskCase.id, finding.category, evidence)
    return { ...finding, id, evidence }
  })
  const id = `task_review_${stableHash({
    reviewerRunId: input.reviewerRunId,
    caseId: taskCase.id,
    inputHash: taskCase.inputHash,
    analyzerId: input.analyzerId,
  }).slice(0, 24)}`
  return TaskReviewSchema.parse({
    schemaVersion: 'task-review-2.0',
    id,
    caseId: taskCase.id,
    rootTrajectoryId: taskCase.rootTrajectoryId,
    trajectoryIds: taskCase.members.map(member => member.entry.trajectoryId),
    createdAt: input.createdAt,
    source: {
      reviewerRunId: input.reviewerRunId,
      reviewerSessionId: input.reviewerSessionId,
      analyzerId: input.analyzerId,
      inputHash: taskCase.inputHash,
    },
    task: draft.task,
    observations: draft.observations.map(claim => ({
      ...claim,
      evidence: hydrateTaskEvidence(claim.evidence, evidenceIndex),
    })),
    decisions: draft.decisions.map(decision => ({
      ...decision,
      evidence: hydrateTaskEvidence(decision.evidence, evidenceIndex),
    })),
    outcome: {
      ...draft.outcome,
      criteria: draft.outcome.criteria.map(criterion => ({
        ...criterion,
        evidence: hydrateTaskEvidence(criterion.evidence, evidenceIndex),
      })),
    },
    assessment: Object.fromEntries(Object.entries(draft.assessment).map(([dimension, value]) => [
      dimension,
      { ...value, evidence: hydrateTaskEvidence(value.evidence, evidenceIndex) },
    ])),
    processAudit: {
      solutionPath: {
        ...draft.processAudit.solutionPath,
        phases: draft.processAudit.solutionPath.phases.map(phase => ({
          ...phase,
          evidence: hydrateTaskEvidence(phase.evidence, evidenceIndex),
        })),
      },
      pathQuality: hydrateProcessAuditDimension(draft.processAudit.pathQuality, evidenceIndex),
      successCriteriaQuality: hydrateProcessAuditDimension(
        draft.processAudit.successCriteriaQuality,
        evidenceIndex,
      ),
      completionIntegrity: hydrateProcessAuditDimension(
        draft.processAudit.completionIntegrity,
        evidenceIndex,
      ),
      informationAdequacy: hydrateProcessAuditDimension(
        draft.processAudit.informationAdequacy,
        evidenceIndex,
      ),
      longHorizonControl: {
        ...hydrateProcessAuditDimension(draft.processAudit.longHorizonControl, evidenceIndex),
        issues: draft.processAudit.longHorizonControl.issues.map(issue => ({
          ...issue,
          evidence: hydrateTaskEvidence(issue.evidence, evidenceIndex),
        })),
      },
    },
    methodologyFindings,
    proposalIds: [],
    ...(draft.noProposalReason ? { noProposalReason: draft.noProposalReason } : {}),
  })
}

export function materializeTaskLearningMoment(
  taskCase: TaskCase,
  proposal: ModelTaskLearningProposal,
): LearningMoment {
  const evidenceIndex = buildEvidenceIndex(taskCase)
  const distinct = new Set(proposal.moment.evidence.map(ref => `${ref.trajectoryId}:${ref.ordinal}`))
  if (distinct.size < 2) throw new Error('task learning proposal must cite at least two distinct evidence locations')
  const evidence = proposal.moment.evidence.map(ref => {
    const hydrated = hydrateTaskEvidence([ref], evidenceIndex)[0]!
    return { ...hydrated, role: ref.role }
  })
  const hasObservedResult = evidence.some(ref =>
    ref.role === 'outcome' || ref.role === 'feedback' || ref.role === 'correction' ||
    ref.role === 'verification' || ref.role === 'contradiction')
  if (!hasObservedResult) throw new Error('task learning proposal has no outcome, feedback, correction, or verification evidence')
  const body = {
    schemaVersion: 'learning-moment-1.0' as const,
    kind: proposal.moment.kind,
    context: {
      taskSummary: taskCase.taskSummary,
      ...(proposal.moment.taskFamily ? { taskFamily: proposal.moment.taskFamily } : {}),
      ...(taskCase.workspaceId ? { workspaceId: taskCase.workspaceId } : {}),
      relevantState: proposal.moment.relevantState,
    },
    ...(proposal.moment.expectation ? { expectation: proposal.moment.expectation } : {}),
    action: proposal.moment.action,
    observedOutcome: proposal.moment.observedOutcome,
    ...(proposal.moment.feedback ? { feedback: proposal.moment.feedback } : {}),
    ...(proposal.moment.correction ? { correction: proposal.moment.correction } : {}),
    ...(proposal.moment.correctedOutcome ? { correctedOutcome: proposal.moment.correctedOutcome } : {}),
    ...(proposal.moment.transferableHint ? { transferableHint: proposal.moment.transferableHint } : {}),
    evidence,
  }
  return LearningMomentSchema.parse({ ...body, id: `moment_${stableHash(body).slice(0, 24)}` })
}

export function assertHighValueFinding(
  finding: TaskFinding,
  proposal: ModelTaskLearningProposal,
  review: TaskReview,
): void {
  if (!finding.candidateEligible) throw new Error(`finding '${finding.id}' is not marked candidateEligible`)
  if (finding.significance !== 'critical' && finding.significance !== 'major') {
    throw new Error(`finding '${finding.id}' significance '${finding.significance}' is below the experience threshold`)
  }
  if (finding.abstractionLevel === 'task_specific') {
    throw new Error(`finding '${finding.id}' is task-specific rather than reusable methodology`)
  }
  const impacts = proposal.experienceDraft.impact
  if (![impacts.reliability, impacts.stability, impacts.effectiveness].includes('high')) {
    throw new Error(`finding '${finding.id}' has no high impact on reliability, stability, or effectiveness`)
  }
  const findingEvidence = new Set(finding.evidence.map(ref => `${ref.trajectoryId}:${ref.ordinal}`))
  const overlaps = proposal.moment.evidence.some(ref => findingEvidence.has(`${ref.trajectoryId}:${ref.ordinal}`))
  if (!overlaps) throw new Error(`proposal has no evidence overlap with finding '${finding.id}'`)
  if (review.outcome.verdict === 'unknown' && finding.category === 'solution_strategy') {
    throw new Error('cannot promote a success strategy while task outcome is unknown')
  }
}

function hydrateProcessAuditDimension<T extends { evidence: readonly ModelTaskEvidencePointer[] }>(
  dimension: T,
  evidenceIndex: ReadonlyMap<string, PreservedTrajectoryLine>,
): Omit<T, 'evidence'> & { evidence: TaskEvidenceRef[] } {
  return {
    ...dimension,
    evidence: hydrateTaskEvidence(dimension.evidence, evidenceIndex),
  }
}

function buildEvidenceIndex(taskCase: TaskCase): Map<string, PreservedTrajectoryLine> {
  return new Map(taskCase.members.flatMap(member => member.lines.map(line => [
    `${member.entry.trajectoryId}:${line.ordinal}`,
    line,
  ] as const)))
}

function hydrateTaskEvidence(
  pointers: readonly ModelTaskEvidencePointer[],
  evidenceIndex: ReadonlyMap<string, PreservedTrajectoryLine>,
): TaskEvidenceRef[] {
  return pointers.map(pointer => {
    const line = evidenceIndex.get(`${pointer.trajectoryId}:${pointer.ordinal}`)
    if (!line) {
      throw new Error(`evidence ${pointer.trajectoryId}#${pointer.ordinal} is outside the bounded TaskCase`)
    }
    return {
      trajectoryId: pointer.trajectoryId,
      ordinal: pointer.ordinal,
      itemType: line.item.type,
    }
  })
}

export function sanitizeModelDraft(draft: ModelTaskReview, workspace?: string): ModelTaskReview {
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return redactTaskSummary(value, workspace)
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, visit(item)]))
    }
    return value
  }
  return ModelTaskReviewSchema.parse(visit(draft))
}

function findingIdFor(
  caseId: string,
  category: TaskFinding['category'],
  evidence: readonly TaskEvidenceRef[],
): string {
  return `finding_${stableHash({
    caseId,
    category,
    evidence: evidence.map(ref => `${ref.trajectoryId}:${ref.ordinal}`).sort(),
  }).slice(0, 24)}`
}

function normalizeTaskReviewerScope(scope: TaskReviewerScope = {}): TaskReviewerRunManifest['scope'] {
  const limit = scope.limit ?? DEFAULT_CASE_LIMIT
  const maxCases = scope.maxCases ?? DEFAULT_MAX_CASES
  const maxTurnsPerCase = scope.maxTurnsPerCase ?? DEFAULT_MAX_TURNS_PER_CASE
  const maxBudgetUsd = scope.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD
  for (const [label, value] of [['limit', limit], ['maxCases', maxCases], ['maxTurnsPerCase', maxTurnsPerCase]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`reviewer ${label} must be a positive integer`)
  }
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    throw new Error('reviewer maxBudgetUsd must be a positive number')
  }
  if (scope.since !== undefined && !Number.isFinite(scope.since)) {
    throw new Error('reviewer since must be a valid timestamp')
  }
  return {
    all: scope.all === true,
    ...(!scope.all ? { limit } : {}),
    ...(scope.trajectoryId ? { trajectoryId: scope.trajectoryId } : {}),
    ...(scope.workspace ? { workspace: scope.workspace } : {}),
    ...(scope.since !== undefined ? { since: scope.since } : {}),
    maxCases,
    maxTurnsPerCase,
    maxBudgetUsd,
    force: scope.force === true,
  }
}

export function renderTaskReviewerRunReport(
  manifest: TaskReviewerRunManifest,
  reviews: readonly TaskReview[],
): string {
  const stats = manifest.stats
  const lines = [
    `# Task Reviewer Run ${manifest.runId}`,
    '',
    `- Analyzer: ${manifest.analyzerId}`,
    `- Task cases: ${stats.casesAnalyzed}/${stats.casesSelected} analyzed`,
    `- Trajectories included: ${stats.trajectoriesIncluded}`,
    `- Kernel sessions / turns / tools: ${stats.kernelSessions} / ${stats.kernelTurns} / ${stats.toolCalls}`,
    `- Cost: $${stats.costUsd.toFixed(4)} / $${manifest.scope.maxBudgetUsd.toFixed(2)}`,
    `- Learning proposals: ${stats.proposalsGenerated} new, ${stats.proposalsDeduplicated} deduplicated`,
    `- Quality-gate rejections: ${stats.qualityRejections}`,
    `- Analysis errors: ${stats.analysisErrors}`,
    '',
    '## Task reviews',
    '',
  ]
  if (reviews.length === 0) lines.push('No new TaskReview was generated.')
  for (const review of reviews) {
    lines.push(
      `### ${review.id}`,
      '',
      `- Goal: ${review.task.goal}`,
      `- Outcome: ${review.outcome.verdict} — ${review.outcome.summary}`,
      `- Effectiveness / reliability / stability / efficiency: ` +
        `${review.assessment.effectiveness.rating} / ${review.assessment.reliability.rating} / ` +
        `${review.assessment.stability.rating} / ${review.assessment.efficiency.rating}`,
      ...(review.schemaVersion === 'task-review-2.0'
        ? [
            `- Path / criteria / completion / information / long-horizon: ` +
              `${review.processAudit.pathQuality.verdict} / ` +
              `${review.processAudit.successCriteriaQuality.verdict} / ` +
              `${review.processAudit.completionIntegrity.verdict} / ` +
              `${review.processAudit.informationAdequacy.verdict} / ` +
              `${review.processAudit.longHorizonControl.verdict}`,
            `- Methodology findings: ${review.methodologyFindings.length}; proposals: ${review.proposalIds.length}`,
          ]
        : [`- Legacy findings: ${review.findings.length}; proposals: ${review.proposalIds.length}`]),
      '',
    )
  }
  if (manifest.skipped.length > 0) {
    lines.push('## Skipped cases', '')
    for (const item of manifest.skipped) lines.push(`- ${item.caseId}: ${item.reason}`)
    lines.push('')
  }
  if (manifest.qualityRejections.length > 0) {
    lines.push('## Proposal quality-gate rejections', '')
    for (const item of manifest.qualityRejections) {
      lines.push(`- ${item.caseId} candidate #${item.proposalIndex + 1}: ${item.reason}`)
    }
    lines.push('')
  }
  if (manifest.analysisErrors.length > 0) {
    lines.push('## Analysis errors', '')
    for (const item of manifest.analysisErrors) {
      lines.push(
        `- ${item.caseId}: ${item.error}` +
        (item.rawResponseArtifact ? ` (redacted raw response: ${item.rawResponseArtifact})` : ''),
      )
    }
    lines.push('')
  }
  lines.push('> TaskReview audits the problem-solving process. Domain details appear only as supporting evidence.', '')
  return lines.join('\n')
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}
