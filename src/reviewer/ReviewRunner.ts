import { createHash } from 'node:crypto'
import { listTrajectoryIndex } from '../trajectory/indexStore.js'
import type { TrajectoryIndexEntry } from '../trajectory/types.js'
import {
  ReviewerStore,
  newReviewerRunId,
  proposalWindowKey,
  reviewedInputKey,
} from './ReviewerStore.js'
import {
  scanTrajectoryForLearning,
  type TrajectoryReviewWindow,
} from './TrajectoryReviewScanner.js'
import {
  LearningMomentSchema,
  type LearningMoment,
  type ModelLearningProposal,
  type ReviewerRunManifest,
} from './types.js'
import type { LearningAnalyzer } from './LearningAnalyzer.js'

export interface ReviewerScope {
  all?: boolean
  limit?: number
  trajectoryId?: string
  workspace?: string
  since?: number
  maxWindows?: number
  force?: boolean
}

export type ReviewerProgressEvent =
  | { phase: 'start'; trajectories: number; maxWindows: number }
  | { phase: 'trajectory'; index: number; total: number; trajectoryId: string }
  | { phase: 'model_call'; call: number; maxWindows: number; trajectoryId: string; windowId: string }

export type ReviewerProgressListener = (event: ReviewerProgressEvent) => void

export interface RunTrajectoryReviewOptions {
  analyzer: LearningAnalyzer
  scope?: ReviewerScope
  trajectoryRootDir?: string
  reviewerRootDir?: string
  now?: () => number
  onProgress?: ReviewerProgressListener
}

export interface RunTrajectoryReviewResult {
  manifest: ReviewerRunManifest
  report: string
}

const DEFAULT_TRAJECTORY_LIMIT = 20
const DEFAULT_MAX_WINDOWS = 50

/**
 * @deprecated Use runTaskReviews. The window-based compatibility runner is
 * scheduled for removal in v1.0.0.
 */
export async function runTrajectoryReview(
  options: RunTrajectoryReviewOptions,
): Promise<RunTrajectoryReviewResult> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const runId = newReviewerRunId()
  const scope = normalizeScope(options.scope)
  const store = new ReviewerStore(options.reviewerRootDir)
  const allEntries = await listTrajectoryIndex({ rootDir: options.trajectoryRootDir })
  const entries = selectEntries(allEntries, scope)
  const history = await store.reviewedState(options.analyzer.id)
  const reviewedInputs = history.reviewedInputKeys
  const priorCompletedWindowKeys = history.completedWindowKeys
  const existingProposalWindowKeys = history.proposalWindowKeys

  const inputHashes: Record<string, string> = {}
  const completedTrajectoryIds = new Set<string>()
  const completedWindowKeys = new Set<string>()
  const proposalIds: string[] = []
  const skipped: ReviewerRunManifest['skipped'] = []
  const noLearning: ReviewerRunManifest['noLearning'] = []
  const qualityRejections: ReviewerRunManifest['qualityRejections'] = []
  const analysisErrors: ReviewerRunManifest['analysisErrors'] = []
  const unknownVerdicts: ReviewerRunManifest['unknownVerdicts'] = []
  let trajectoriesScanned = 0
  let trajectoriesUnchanged = 0
  let candidateWindows = 0
  let modelCalls = 0
  let windowsSkippedBudget = 0
  let windowsPreviouslyReviewed = 0
  let proposalsGenerated = 0
  let proposalsDeduplicated = 0
  let noLearningWindows = 0

  options.onProgress?.({ phase: 'start', trajectories: entries.length, maxWindows: scope.maxWindows })
  for (const [entryIndex, entry] of entries.entries()) {
    options.onProgress?.({
      phase: 'trajectory',
      index: entryIndex + 1,
      total: entries.length,
      trajectoryId: entry.trajectoryId,
    })
    const scanned = await scanTrajectoryForLearning(entry, { rootDir: options.trajectoryRootDir })
    if ('reason' in scanned) {
      skipped.push({ trajectoryId: scanned.trajectoryId, reason: scanned.reason })
      continue
    }
    trajectoriesScanned++
    inputHashes[entry.trajectoryId] = scanned.inputHash
    candidateWindows += scanned.windows.length
    unknownVerdicts.push(...scanned.unknownEvaluationVerdicts.map(item => ({
      trajectoryId: entry.trajectoryId,
      ...item,
    })))
    if (!scope.force && reviewedInputs.has(reviewedInputKey(entry.trajectoryId, scanned.inputHash))) {
      trajectoriesUnchanged++
      skipped.push({ trajectoryId: entry.trajectoryId, reason: 'unchanged since completed reviewer run' })
      completedTrajectoryIds.add(entry.trajectoryId)
      continue
    }

    // Deliberately sequential: manual review should not turn a large history
    // scan into an unbounded burst of model calls.
    let trajectoryComplete = true
    for (let windowIndex = 0; windowIndex < scanned.windows.length; windowIndex++) {
      const window = scanned.windows[windowIndex]!
      const windowHash = stableHash(window)
      const windowKey = proposalWindowKey({
        windowId: window.id,
        windowHash,
        analyzerId: options.analyzer.id,
      })
      // Existing proposals are immutable review identities, including rejected
      // ones. Even --force must not spend money producing content that cannot
      // be stored without reassigning proposal slots.
      if (existingProposalWindowKeys.has(windowKey)) {
        windowsPreviouslyReviewed++
        completedWindowKeys.add(windowKey)
        continue
      }
      // Normal incremental runs also skip prior no-learning / quality-reviewed
      // windows. --force deliberately rechecks only this proposal-free class.
      if (!scope.force && priorCompletedWindowKeys.has(windowKey)) {
        windowsPreviouslyReviewed++
        completedWindowKeys.add(windowKey)
        continue
      }
      if (modelCalls >= scope.maxWindows) {
        windowsSkippedBudget += scanned.windows.length - windowIndex
        trajectoryComplete = false
        break
      }

      modelCalls++
      options.onProgress?.({
        phase: 'model_call',
        call: modelCalls,
        maxWindows: scope.maxWindows,
        trajectoryId: entry.trajectoryId,
        windowId: window.id,
      })
      let result: Awaited<ReturnType<LearningAnalyzer['analyze']>>
      try {
        result = await options.analyzer.analyze(window)
      } catch (error) {
        trajectoryComplete = false
        analysisErrors.push({
          windowId: window.id,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }

      if (result.proposals.length === 0) {
        noLearningWindows++
        noLearning.push({
          windowId: window.id,
          reason: result.noLearningReason ?? 'analyzer returned no proposal without a reason',
        })
        completedWindowKeys.add(windowKey)
        priorCompletedWindowKeys.add(windowKey)
        continue
      }
      for (const [proposalIndex, modelProposal] of result.proposals.entries()) {
        try {
          const moment = materializeLearningMoment(window, modelProposal)
          const stored = await store.addProposal({
            source: {
              reviewerRunId: runId,
              windowId: window.id,
              windowHash,
              proposalIndex,
              trigger: window.trigger,
              trajectoryIds: [window.trajectoryId],
              analyzerId: options.analyzer.id,
            },
            moment,
            experienceDraft: modelProposal.experienceDraft,
            now: now(),
          })
          if (stored.duplicate) proposalsDeduplicated++
          else {
            proposalIds.push(stored.proposal.id)
            proposalsGenerated++
          }
          existingProposalWindowKeys.add(windowKey)
        } catch (error) {
          qualityRejections.push({
            windowId: window.id,
            proposalIndex,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
      priorCompletedWindowKeys.add(windowKey)
      completedWindowKeys.add(windowKey)
    }
    if (trajectoryComplete) completedTrajectoryIds.add(entry.trajectoryId)
  }

  const manifest: ReviewerRunManifest = {
    schemaVersion: 'trajectory-review-run-1.0',
    runId,
    createdAt: startedAt,
    completedAt: now(),
    analyzerId: options.analyzer.id,
    scope,
    inputHashes,
    completedTrajectoryIds: [...completedTrajectoryIds],
    completedWindowKeys: [...completedWindowKeys],
    stats: {
      trajectoriesSelected: entries.length,
      trajectoriesScanned,
      trajectoriesSkipped: skipped.length,
      trajectoriesUnchanged,
      candidateWindows,
      modelCalls,
      windowsSkippedBudget,
      windowsPreviouslyReviewed,
      proposalsGenerated,
      proposalsDeduplicated,
      noLearningWindows,
      qualityRejections: qualityRejections.length,
      analysisErrors: analysisErrors.length,
      unknownVerdicts: unknownVerdicts.length,
    },
    proposalIds,
    skipped,
    noLearning,
    qualityRejections,
    analysisErrors,
    unknownVerdicts,
  }
  const report = renderReviewerRunReport(manifest)
  await store.writeRun(manifest, report)
  return { manifest, report }
}

export function materializeLearningMoment(
  window: TrajectoryReviewWindow,
  proposal: ModelLearningProposal,
): LearningMoment {
  const lines = new Map(window.lines.map(line => [line.ordinal, line]))
  const distinctOrdinals = new Set(proposal.moment.evidence.map(ref => ref.ordinal))
  if (distinctOrdinals.size < 2) throw new Error('learning proposal must cite at least two distinct evidence ordinals')

  const hydratedEvidence = proposal.moment.evidence.map(ref => {
    const line = lines.get(ref.ordinal)
    if (!line) throw new Error(`evidence ordinal ${ref.ordinal} is outside review window '${window.id}'`)
    return {
      trajectoryId: window.trajectoryId,
      ordinal: line.ordinal,
      itemType: line.itemType,
      ...(line.journalSequence !== undefined ? { journalSequence: line.journalSequence } : {}),
      ...(line.artifactHash ? { artifactHash: line.artifactHash } : {}),
      role: ref.role,
    }
  })

  const hasObservedResult = hydratedEvidence.some(ref =>
    ref.role === 'outcome' || ref.role === 'feedback' ||
    ref.role === 'correction' || ref.role === 'verification' || ref.role === 'contradiction')
  if (!hasObservedResult) throw new Error('learning proposal has no outcome, feedback, correction, or verification evidence')

  const momentBody = {
    schemaVersion: 'learning-moment-1.0' as const,
    kind: proposal.moment.kind,
    context: {
      // Keep the persisted summary on the host-redacted value. The analyzer's
      // paraphrase is untrusted output and may copy a path back out of evidence.
      taskSummary: window.taskSummary,
      ...(proposal.moment.taskFamily ? { taskFamily: proposal.moment.taskFamily } : {}),
      ...(window.workspaceId ? { workspaceId: window.workspaceId } : {}),
      ...(window.graphHash ? { graphHash: window.graphHash } : {}),
      ...(window.nodeId ? { nodeId: window.nodeId } : {}),
      relevantState: proposal.moment.relevantState,
    },
    ...(proposal.moment.expectation ? { expectation: proposal.moment.expectation } : {}),
    action: proposal.moment.action,
    observedOutcome: proposal.moment.observedOutcome,
    ...(proposal.moment.feedback ? { feedback: proposal.moment.feedback } : {}),
    ...(proposal.moment.correction ? { correction: proposal.moment.correction } : {}),
    ...(proposal.moment.correctedOutcome ? { correctedOutcome: proposal.moment.correctedOutcome } : {}),
    ...(proposal.moment.transferableHint ? { transferableHint: proposal.moment.transferableHint } : {}),
    evidence: hydratedEvidence,
  }
  const id = `moment_${stableHash(momentBody).slice(0, 24)}`
  return LearningMomentSchema.parse({ ...momentBody, id })
}

function normalizeScope(scope: ReviewerScope = {}): ReviewerRunManifest['scope'] {
  if (scope.limit !== undefined && (!Number.isSafeInteger(scope.limit) || scope.limit < 1)) {
    throw new Error('reviewer limit must be a positive integer')
  }
  if (scope.since !== undefined && !Number.isFinite(scope.since)) {
    throw new Error('reviewer since must be a valid timestamp')
  }
  if (scope.maxWindows !== undefined && (!Number.isSafeInteger(scope.maxWindows) || scope.maxWindows < 1)) {
    throw new Error('reviewer maxWindows must be a positive integer')
  }
  return {
    all: scope.all === true,
    ...(!scope.all ? { limit: scope.limit ?? DEFAULT_TRAJECTORY_LIMIT } : {}),
    ...(scope.trajectoryId ? { trajectoryId: scope.trajectoryId } : {}),
    ...(scope.workspace ? { workspace: scope.workspace } : {}),
    ...(scope.since !== undefined ? { since: scope.since } : {}),
    maxWindows: scope.maxWindows ?? DEFAULT_MAX_WINDOWS,
    force: scope.force === true,
  }
}

function selectEntries(
  entries: readonly TrajectoryIndexEntry[],
  scope: ReviewerRunManifest['scope'],
): TrajectoryIndexEntry[] {
  let selected = [...entries]
  if (scope.trajectoryId) {
    const exact = selected.find(entry => entry.trajectoryId === scope.trajectoryId)
    if (exact) selected = [exact]
    else {
      const matches = selected.filter(entry => entry.trajectoryId.startsWith(scope.trajectoryId!))
      if (matches.length > 1) throw new Error(`trajectory id prefix '${scope.trajectoryId}' is ambiguous`)
      if (matches.length === 0) throw new Error(`unknown trajectory '${scope.trajectoryId}'`)
      selected = matches
    }
  }
  if (scope.workspace) {
    selected = selected.filter(entry =>
      entry.workspace === scope.workspace || entry.workspaceId === scope.workspace)
  }
  if (scope.since !== undefined) selected = selected.filter(entry => entry.lastActivity >= scope.since!)
  selected.sort((a, b) => b.lastActivity - a.lastActivity || a.trajectoryId.localeCompare(b.trajectoryId))
  if (!scope.all && scope.limit !== undefined) selected = selected.slice(0, scope.limit)
  return selected
}

function renderReviewerRunReport(manifest: ReviewerRunManifest): string {
  const lines = [
    `# Trajectory Reviewer Run ${manifest.runId}`,
    '',
    `- Started: ${new Date(manifest.createdAt).toISOString()}`,
    `- Completed: ${new Date(manifest.completedAt).toISOString()}`,
    `- Analyzer: ${manifest.analyzerId}`,
    `- Trajectories: ${manifest.stats.trajectoriesScanned}/${manifest.stats.trajectoriesSelected} scanned`,
    `- Unchanged trajectories: ${manifest.stats.trajectoriesUnchanged}`,
    `- Candidate windows: ${manifest.stats.candidateWindows}`,
    `- Model calls: ${manifest.stats.modelCalls}/${manifest.scope.maxWindows}`,
    `- Windows skipped by budget: ${manifest.stats.windowsSkippedBudget}`,
    `- Previously reviewed windows: ${manifest.stats.windowsPreviouslyReviewed}`,
    `- Learning proposals: ${manifest.stats.proposalsGenerated} new, ${manifest.stats.proposalsDeduplicated} deduplicated`,
    `- No-learning decisions: ${manifest.stats.noLearningWindows}`,
    `- Quality-gate rejections: ${manifest.stats.qualityRejections}`,
    `- Analysis errors: ${manifest.stats.analysisErrors}`,
    `- Unknown evaluation verdicts: ${manifest.stats.unknownVerdicts}`,
    '',
    '## New proposals requiring human review',
    '',
  ]
  if (manifest.proposalIds.length === 0) lines.push('No new learning proposals were generated.')
  else for (const id of manifest.proposalIds) lines.push(`- ${id}`)
  if (manifest.skipped.length > 0) {
    lines.push('', '## Skipped trajectories', '')
    for (const item of manifest.skipped) lines.push(`- ${item.trajectoryId}: ${item.reason}`)
  }
  if (manifest.noLearning.length > 0) {
    lines.push('', '## No learning extracted', '')
    for (const item of manifest.noLearning) lines.push(`- ${item.windowId}: ${item.reason}`)
  }
  if (manifest.qualityRejections.length > 0) {
    lines.push('', '## Quality-gate rejections', '')
    for (const item of manifest.qualityRejections) {
      lines.push(`- ${item.windowId} proposal #${item.proposalIndex + 1}: ${item.reason}`)
    }
  }
  if (manifest.analysisErrors.length > 0) {
    lines.push('', '## Analysis errors', '')
    for (const item of manifest.analysisErrors) lines.push(`- ${item.windowId}: ${item.error}`)
  }
  if (manifest.unknownVerdicts.length > 0) {
    lines.push('', '## Unknown evaluation verdicts', '')
    for (const item of manifest.unknownVerdicts) {
      lines.push(`- ${item.trajectoryId}#${item.ordinal} ${item.evaluator}: ${JSON.stringify(item.verdict)}`)
    }
  }
  lines.push('', '> No ExperienceCandidate is created until a human approves a LearningProposal.', '')
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
