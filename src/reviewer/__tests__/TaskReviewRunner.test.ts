import { statSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MetaAgentConfig } from '../../core/config.js'
import type { MetaAgentEvent } from '../../core/types.js'
import { clearTrajectoryHubForTests } from '../../trajectory/hub.js'
import { TrajectoryRecorder } from '../../trajectory/recorder.js'
import type { TrajectoryIndexEntry } from '../../trajectory/types.js'
import { ReviewerStore } from '../ReviewerStore.js'
import { createReviewerTools } from '../ReviewerTools.js'
import {
  KernelTaskCaseReviewer,
  type TaskCaseReviewer,
} from '../ReviewerSession.js'
import { listTaskCaseDescriptors, loadTaskCase, selectTaskCaseDescriptors } from '../TaskCase.js'
import {
  assertHighValueFinding,
  materializeTaskReview,
  runTaskReviews,
  sanitizeModelDraft,
} from '../TaskReviewRunner.js'
import type { ModelTaskLearningProposal, ModelTaskReview } from '../types.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  clearTrajectoryHubForTests()
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('task-level Kernel Reviewer pipeline', () => {
  it('groups root + child trajectories, excludes reviewer trajectories, and exposes bounded tools', async () => {
    const fixture = await taskCaseFixture()
    const descriptors = await listTaskCaseDescriptors({ all: true }, { rootDir: fixture.trajectoryRoot })
    expect(descriptors).toHaveLength(1)
    expect(descriptors[0]).toMatchObject({
      rootTrajectoryId: fixture.rootTrajectoryId,
      entries: [{ trajectoryId: fixture.rootTrajectoryId }, { trajectoryId: fixture.childTrajectoryId }],
    })

    const taskCase = await loadTaskCase(descriptors[0]!, { rootDir: fixture.trajectoryRoot })
    if ('reason' in taskCase) throw new Error(taskCase.reason)
    expect(taskCase.metrics).toMatchObject({ trajectories: 2, toolCalls: 2, toolErrors: 1 })

    const tools = new Map(createReviewerTools(taskCase).map(tool => [tool.name, tool]))
    const overview = await tools.get('review_case_overview')!.call({}, null as never)
    expect(overview.isError).toBe(false)
    expect(JSON.parse(overview.content)).toMatchObject({ caseId: taskCase.id, rootTrajectoryId: fixture.rootTrajectoryId })

    const outside = await tools.get('review_trajectory_read')!.call({
      trajectoryId: '00000000-0000-4000-8000-000000000999',
      startOrdinal: 1,
    }, null as never)
    expect(outside.isError).toBe(true)
    expect(outside.content).toContain('outside task case')

    const exactLimit = await tools.get('review_trajectory_search')!.call({
      query: 'module resolution failed',
      limit: 1,
    }, null as never)
    expect(JSON.parse(exactLimit.content)).toMatchObject({ truncated: false, matches: [{ ordinal: expect.any(Number) }] })
  })

  it('collapses a corrupt parent cycle into one deterministic TaskCase', () => {
    const firstId = '00000000-0000-4000-8000-000000000001'
    const secondId = '00000000-0000-4000-8000-000000000002'
    const descriptors = selectTaskCaseDescriptors([
      trajectoryIndexEntry(firstId, secondId),
      trajectoryIndexEntry(secondId, firstId),
    ], { all: true })
    expect(descriptors).toHaveLength(1)
    expect(descriptors[0]).toMatchObject({
      rootTrajectoryId: firstId,
      entries: expect.arrayContaining([
        expect.objectContaining({ trajectoryId: firstId }),
        expect.objectContaining({ trajectoryId: secondId }),
      ]),
    })
  })

  it('writes a complete TaskReview and only promotes major high-impact findings', async () => {
    const fixture = await taskCaseFixture()
    const reviewerRoot = join(fixture.trajectoryRoot, 'reviewer-store')
    let calls = 0
    const reviewer: TaskCaseReviewer = {
      id: 'fake-kernel-task-reviewer-v1',
      review: async taskCase => {
        calls++
        const rootAction = findOrdinal(taskCase, fixture.rootTrajectoryId, 'tool_outcome')
        const rootOutcome = findOrdinal(taskCase, fixture.rootTrajectoryId, 'run_result')
        const childOutcome = findOrdinal(taskCase, fixture.childTrajectoryId, 'tool_outcome')
        return {
          draft: reviewDraft(
            fixture.rootTrajectoryId,
            fixture.childTrajectoryId,
            rootAction,
            rootOutcome,
            childOutcome,
          ),
          reviewerSessionId: 'reviewer-session-test',
          turns: 4,
          toolCalls: 3,
          costUsd: 0.125,
        }
      },
    }

    const result = await runTaskReviews({
      reviewer,
      trajectoryRootDir: fixture.trajectoryRoot,
      reviewerRootDir: reviewerRoot,
      scope: { all: true, maxCases: 5, maxTurnsPerCase: 8, maxBudgetUsd: 1 },
    })
    expect(result.manifest.stats).toMatchObject({
      casesSelected: 1,
      casesAnalyzed: 1,
      trajectoriesIncluded: 2,
      kernelSessions: 1,
      kernelTurns: 4,
      toolCalls: 3,
      proposalsGenerated: 1,
      qualityRejections: 1,
    })
    expect(result.taskReviews).toHaveLength(1)
    expect(result.taskReviews[0]).toMatchObject({
      schemaVersion: 'task-review-2.0',
      rootTrajectoryId: fixture.rootTrajectoryId,
      outcome: { verdict: 'solved' },
      processAudit: {
        pathQuality: { verdict: 'reasonable' },
        successCriteriaQuality: { verdict: 'appropriate' },
        completionIntegrity: { verdict: 'well_supported' },
        informationAdequacy: { verdict: 'sufficient' },
        longHorizonControl: { verdict: 'not_applicable' },
      },
      proposalIds: [expect.stringMatching(/^proposal_/)],
    })
    expect(result.report).toContain('Path / criteria / completion / information / long-horizon')
    expect(result.report).toContain('Methodology findings: 2')

    const store = new ReviewerStore(reviewerRoot)
    const [proposal] = await store.listProposals('pending')
    expect(proposal?.source).toMatchObject({
      caseId: result.taskReviews[0]!.caseId,
      taskReviewId: result.taskReviews[0]!.id,
      findingId: result.taskReviews[0]!.schemaVersion === 'task-review-2.0'
        ? result.taskReviews[0]!.methodologyFindings[0]!.id
        : undefined,
    })
    const candidate = await store.approveProposal(proposal!.id)
    expect(candidate.evidence.independentTrajectories).toBe(1)

    const rerun = await runTaskReviews({
      reviewer,
      trajectoryRootDir: fixture.trajectoryRoot,
      reviewerRootDir: reviewerRoot,
      scope: { all: true, force: true, maxBudgetUsd: 1 },
    })
    expect(rerun.manifest.stats).toMatchObject({ casesAnalyzed: 0, casesUnchanged: 1 })
    expect(calls).toBe(1)
  })

  it('reanalyzes a grown TaskCase without resurrecting a rejected finding', async () => {
    const fixture = await taskCaseFixture()
    const reviewerRoot = join(fixture.trajectoryRoot, 'reviewer-store')
    let calls = 0
    const reviewer: TaskCaseReviewer = {
      id: 'stable-finding-reviewer',
      review: async taskCase => {
        calls++
        const rootAction = findOrdinal(taskCase, fixture.rootTrajectoryId, 'tool_outcome')
        const rootOutcome = findOrdinal(taskCase, fixture.rootTrajectoryId, 'run_result')
        const childOutcome = findOrdinal(taskCase, fixture.childTrajectoryId, 'tool_outcome')
        return {
          draft: reviewDraft(fixture.rootTrajectoryId, fixture.childTrajectoryId, rootAction, rootOutcome, childOutcome),
          reviewerSessionId: `reviewer-session-${calls}`,
          turns: 2,
          toolCalls: 1,
          costUsd: 0.05,
        }
      },
    }

    const first = await runTaskReviews({
      reviewer,
      trajectoryRootDir: fixture.trajectoryRoot,
      reviewerRootDir: reviewerRoot,
      scope: { all: true, maxBudgetUsd: 1 },
    })
    const store = new ReviewerStore(reviewerRoot)
    const [proposal] = await store.listProposals('pending')
    const rejected = await store.rejectProposal(proposal!.id, 'not reusable')
    // Simulate a proposal persisted by the pre-fix fingerprint, where inputHash
    // produced a different ID. The semantic identity scan must preserve it.
    const legacyId = `proposal_${'a'.repeat(24)}`
    await writeFile(join(reviewerRoot, 'proposals', `${legacyId}.json`), JSON.stringify({
      ...rejected,
      id: legacyId,
      fingerprint: 'a'.repeat(64),
    }))
    await unlink(store.proposalFile(proposal!.id))

    const resumed = await TrajectoryRecorder.open({
      subject: { kind: 'session', sessionId: 'task-review-root' },
      mode: 'auto',
      workspace: '/workspace/project',
    }, { rootDir: fixture.trajectoryRoot, trajectoryId: fixture.rootTrajectoryId })
    expect(resumed.trajectoryId).toBe(fixture.rootTrajectoryId)
    await resumed.record({ type: 'message', message: { role: 'user', content: '补充一次无关的状态检查' } })
    await resumed.close()

    const second = await runTaskReviews({
      reviewer,
      trajectoryRootDir: fixture.trajectoryRoot,
      reviewerRootDir: reviewerRoot,
      scope: { all: true, maxBudgetUsd: 1 },
    })
    expect(second.manifest.inputHashes[first.taskReviews[0]!.caseId])
      .not.toBe(first.manifest.inputHashes[first.taskReviews[0]!.caseId])
    expect(second.manifest.stats).toMatchObject({
      casesAnalyzed: 1,
      proposalsGenerated: 0,
      proposalsDeduplicated: 1,
    })
    expect(calls).toBe(2)
    expect(await store.listProposals('pending')).toHaveLength(0)
    expect(await store.listProposals('rejected')).toHaveLength(1)
  })

  it('enforces every high-value Finding gate and redacts the full model draft', async () => {
    const fixture = await taskCaseFixture()
    const [descriptor] = await listTaskCaseDescriptors({ all: true }, { rootDir: fixture.trajectoryRoot })
    const taskCase = await loadTaskCase(descriptor!, { rootDir: fixture.trajectoryRoot })
    if ('reason' in taskCase) throw new Error(taskCase.reason)
    const rootAction = findOrdinal(taskCase, fixture.rootTrajectoryId, 'tool_outcome')
    const rootOutcome = findOrdinal(taskCase, fixture.rootTrajectoryId, 'run_result')
    const childOutcome = findOrdinal(taskCase, fixture.childTrajectoryId, 'tool_outcome')
    const draft = reviewDraft(fixture.rootTrajectoryId, fixture.childTrajectoryId, rootAction, rootOutcome, childOutcome)
    const review = materializeTaskReview({
      taskCase,
      draft,
      reviewerRunId: 'review_000000000000000000000001',
      reviewerSessionId: 'reviewer-session-gates',
      analyzerId: 'gate-reviewer',
      createdAt: 1,
    })
    if (review.schemaVersion !== 'task-review-2.0') throw new Error('expected task-review-2.0')
    const finding = review.methodologyFindings[0]!
    const proposal = draft.proposalCandidates[0]!

    expect(() => assertHighValueFinding(finding, proposal, review)).not.toThrow()
    expect(() => assertHighValueFinding({ ...finding, candidateEligible: false }, proposal, review))
      .toThrow('not marked candidateEligible')
    expect(() => assertHighValueFinding({ ...finding, significance: 'minor' }, proposal, review))
      .toThrow('below the experience threshold')
    expect(() => assertHighValueFinding({ ...finding, abstractionLevel: 'task_specific' }, proposal, review))
      .toThrow('task-specific rather than reusable methodology')
    expect(() => assertHighValueFinding(finding, {
      ...proposal,
      experienceDraft: {
        ...proposal.experienceDraft,
        impact: {
          reliability: 'medium',
          stability: 'medium',
          effectiveness: 'medium',
          rationale: ['impact is bounded'],
        },
      },
    }, review)).toThrow('has no high impact')
    expect(() => assertHighValueFinding(finding, {
      ...proposal,
      moment: {
        ...proposal.moment,
        evidence: [{ trajectoryId: fixture.rootTrajectoryId, ordinal: rootOutcome, role: 'outcome' }],
      },
    }, review)).toThrow('has no evidence overlap')

    const unsafe = {
      ...draft,
      task: {
        ...draft.task,
        goal: 'inspect api_key=sk-abcdefghijklmnop in /workspace/project/private/config.json',
      },
    }
    const sanitized = sanitizeModelDraft(unsafe, '/workspace/project')
    expect(JSON.stringify(sanitized)).not.toContain('sk-abcdefghijklmnop')
    expect(JSON.stringify(sanitized)).not.toContain('/workspace/project')
    expect(sanitized.task.goal).toContain('[REDACTED]')
    expect(sanitized.task.goal).toContain('[WORKSPACE]')
  })

  it('runs ReviewerSession with fenced JSON, evidence use, 32k output, and an isolated cwd', async () => {
    const fixture = await taskCaseFixture()
    const [descriptor] = await listTaskCaseDescriptors({ all: true }, { rootDir: fixture.trajectoryRoot })
    const taskCase = await loadTaskCase(descriptor!, { rootDir: fixture.trajectoryRoot })
    if ('reason' in taskCase) throw new Error(taskCase.reason)
    const draft = reviewDraft(
      fixture.rootTrajectoryId,
      fixture.childTrajectoryId,
      findOrdinal(taskCase, fixture.rootTrajectoryId, 'tool_outcome'),
      findOrdinal(taskCase, fixture.rootTrajectoryId, 'run_result'),
      findOrdinal(taskCase, fixture.childTrajectoryId, 'tool_outcome'),
    )
    const rawDraft = draftWithModelAliases(draft)
    let capturedConfig: MetaAgentConfig | undefined
    let capturedProjectMode: number | undefined
    const dispose = vi.fn(async () => undefined)
    const reviewer = new KernelTaskCaseReviewer(reviewerConfig(), config => {
      capturedConfig = config
      capturedProjectMode = statSync(config.projectDir!).mode & 0o777
      return {
        async *submit(): AsyncGenerator<MetaAgentEvent> {
          yield toolUseEvent()
          yield resultEvent(`\`\`\`json\n${JSON.stringify(rawDraft)}\n\`\`\``, 4, 0.2)
        },
        getEstimatedCost: () => 0.2,
        dispose,
      }
    })

    const result = await reviewer.review(taskCase, {
      reviewerRunId: 'review_000000000000000000000002',
      maxTurns: 8,
      maxBudgetUsd: 1,
    })
    expect(result).toMatchObject({ turns: 4, toolCalls: 1, costUsd: 0.2, draft: { task: draft.task } })
    expect(result.draft.proposalCandidates[1]!.moment.evidence[0]!.role).toBe('outcome')
    expect(result.draft.methodologyFindings[0]!.category).toBe('efficiency_strategy')
    expect(result.draft.methodologyFindings[1]!.category).toBe('success_criteria')
    expect(result.proposalRejections).toEqual([])
    expect(capturedConfig?.maxTokens).toBe(32_000)
    expect(capturedConfig?.projectDir).toMatch(/meta-agent-reviewer-/)
    expect(capturedConfig?.projectDir).not.toBe(taskCase.workspace)
    expect(capturedProjectMode).toBe(0o500)
    expect(capturedConfig?.tools).toHaveLength(4)
    expect(capturedConfig?.trajectory).toMatchObject({ mode: 'reviewer', rootTrajectoryId: taskCase.rootTrajectoryId })
    expect(capturedConfig?.systemPrompt).toContain('completionIntegrity')
    expect(capturedConfig?.systemPrompt).toContain('memory loss')
    expect(capturedConfig?.systemPrompt).toContain('domain facts')
    await expect(access(capturedConfig!.projectDir!)).rejects.toThrow()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('persists the TaskReview when one optional proposal candidate is malformed', async () => {
    const fixture = await taskCaseFixture()
    const reviewerRoot = join(fixture.trajectoryRoot, 'reviewer-store')
    const [descriptor] = await listTaskCaseDescriptors({ all: true }, { rootDir: fixture.trajectoryRoot })
    const taskCase = await loadTaskCase(descriptor!, { rootDir: fixture.trajectoryRoot })
    if ('reason' in taskCase) throw new Error(taskCase.reason)
    const draft = reviewDraft(
      fixture.rootTrajectoryId,
      fixture.childTrajectoryId,
      findOrdinal(taskCase, fixture.rootTrajectoryId, 'tool_outcome'),
      findOrdinal(taskCase, fixture.rootTrajectoryId, 'run_result'),
      findOrdinal(taskCase, fixture.childTrajectoryId, 'tool_outcome'),
    )
    const rawDraft = draftWithEvidenceRole(draft, 1, 0, 'unsupported_role')
    const reviewer = new KernelTaskCaseReviewer(reviewerConfig(), () => ({
      async *submit(): AsyncGenerator<MetaAgentEvent> {
        yield toolUseEvent()
        yield resultEvent(JSON.stringify(rawDraft), 3, 0.1)
      },
      getEstimatedCost: () => 0.1,
      dispose: async () => undefined,
    }))

    const result = await runTaskReviews({
      reviewer,
      trajectoryRootDir: fixture.trajectoryRoot,
      reviewerRootDir: reviewerRoot,
      scope: { all: true, maxBudgetUsd: 1 },
    })
    expect(result.manifest.stats).toMatchObject({
      casesAnalyzed: 1,
      proposalsGenerated: 1,
      qualityRejections: 1,
      analysisErrors: 0,
    })
    expect(result.taskReviews).toHaveLength(1)
    expect(result.manifest.qualityRejections[0]).toMatchObject({
      caseId: result.taskReviews[0]!.caseId,
      proposalIndex: 1,
    })
    expect(result.manifest.qualityRejections[0]!.reason).toContain('proposal schema rejected')
  })

  it('recovers a matching failed raw response without another model call', async () => {
    const fixture = await taskCaseFixture()
    const reviewerRoot = join(fixture.trajectoryRoot, 'reviewer-store')
    const [descriptor] = await listTaskCaseDescriptors({ all: true }, { rootDir: fixture.trajectoryRoot })
    const taskCase = await loadTaskCase(descriptor!, { rootDir: fixture.trajectoryRoot })
    if ('reason' in taskCase) throw new Error(taskCase.reason)
    const draft = reviewDraft(
      fixture.rootTrajectoryId,
      fixture.childTrajectoryId,
      findOrdinal(taskCase, fixture.rootTrajectoryId, 'tool_outcome'),
      findOrdinal(taskCase, fixture.rootTrajectoryId, 'run_result'),
      findOrdinal(taskCase, fixture.childTrajectoryId, 'tool_outcome'),
    )
    const analyzerId = 'recovering-reviewer'
    const oldRunId = 'review_000000000000000000000004'
    const store = new ReviewerStore(reviewerRoot)
    const rawResponseArtifact = await store.writeTaskRunRawResponse(
      oldRunId,
      taskCase.id,
      JSON.stringify(draftWithModelAliases(draft)),
    )
    await store.writeTaskRun({
      schemaVersion: 'task-review-run-2.0',
      runId: oldRunId,
      createdAt: 1,
      completedAt: 2,
      analyzerId,
      scope: {
        all: true,
        maxCases: 20,
        maxTurnsPerCase: 12,
        maxBudgetUsd: 5,
        force: false,
      },
      inputHashes: { [taskCase.id]: taskCase.inputHash },
      completedCaseIds: [],
      stats: {
        casesSelected: 1,
        casesAnalyzed: 0,
        casesSkipped: 0,
        casesUnchanged: 0,
        trajectoriesIncluded: taskCase.members.length,
        kernelSessions: 1,
        kernelTurns: 4,
        toolCalls: 2,
        costUsd: 0.1,
        proposalsGenerated: 0,
        proposalsDeduplicated: 0,
        qualityRejections: 0,
        analysisErrors: 1,
      },
      taskReviewIds: [],
      proposalIds: [],
      skipped: [],
      qualityRejections: [],
      analysisErrors: [{
        caseId: taskCase.id,
        error: 'old parser rejected model aliases',
        rawResponseArtifact,
      }],
    }, '# prior failed run')
    let calls = 0
    const reviewer: TaskCaseReviewer = {
      id: analyzerId,
      review: async () => {
        calls++
        throw new Error('model should not be called during recovery')
      },
    }
    const progress: string[] = []
    const result = await runTaskReviews({
      reviewer,
      trajectoryRootDir: fixture.trajectoryRoot,
      reviewerRootDir: reviewerRoot,
      scope: { all: true, maxBudgetUsd: 1 },
      onProgress: event => progress.push(event.phase),
    })

    expect(calls).toBe(0)
    expect(progress).toContain('recovery')
    expect(result.manifest.stats).toMatchObject({
      casesAnalyzed: 1,
      kernelSessions: 0,
      kernelTurns: 0,
      toolCalls: 0,
      costUsd: 0,
      proposalsGenerated: 1,
      analysisErrors: 0,
    })
    expect(result.taskReviews[0]).toMatchObject({
      methodologyFindings: [
        expect.objectContaining({ category: 'efficiency_strategy' }),
        expect.objectContaining({ category: 'success_criteria' }),
      ],
      source: { reviewerSessionId: `recovered:${oldRunId}` },
    })
  })

  it('rejects a ReviewerSession that never investigates evidence and preserves usage', async () => {
    const fixture = await taskCaseFixture()
    const [descriptor] = await listTaskCaseDescriptors({ all: true }, { rootDir: fixture.trajectoryRoot })
    const taskCase = await loadTaskCase(descriptor!, { rootDir: fixture.trajectoryRoot })
    if ('reason' in taskCase) throw new Error(taskCase.reason)
    const rawResponse = JSON.stringify({ noEvidence: true })
    const reviewer = new KernelTaskCaseReviewer(reviewerConfig(), () => ({
      async *submit(): AsyncGenerator<MetaAgentEvent> {
        yield resultEvent(rawResponse, 2, 0.3)
      },
      getEstimatedCost: () => 0.3,
      dispose: async () => undefined,
    }))

    await expect(reviewer.review(taskCase, {
      reviewerRunId: 'review_000000000000000000000003',
      maxTurns: 4,
      maxBudgetUsd: 1,
    })).rejects.toMatchObject({
      name: 'ReviewerSessionExecutionError',
      turns: 2,
      toolCalls: 0,
      costUsd: 0.3,
      rawResponse,
    })
  })

  it('accounts malformed ReviewerSession output and stores a redacted recovery artifact', async () => {
    const fixture = await taskCaseFixture()
    const reviewerRoot = join(fixture.trajectoryRoot, 'reviewer-store')
    const rawResponse = '{"task":{"goal":"api_key=sk-abcdefghijklmnop at /workspace/project/private.txt"'
    const reviewer = new KernelTaskCaseReviewer(reviewerConfig(), () => ({
      async *submit(): AsyncGenerator<MetaAgentEvent> {
        yield toolUseEvent()
        yield resultEvent(rawResponse, 3, 0.4)
      },
      getEstimatedCost: () => 0.4,
      dispose: async () => undefined,
    }))
    const result = await runTaskReviews({
      reviewer,
      trajectoryRootDir: fixture.trajectoryRoot,
      reviewerRootDir: reviewerRoot,
      scope: { all: true, maxBudgetUsd: 1 },
    })
    expect(result.manifest.stats).toMatchObject({
      kernelSessions: 1,
      kernelTurns: 3,
      toolCalls: 1,
      costUsd: 0.4,
      analysisErrors: 1,
    })
    const [error] = result.manifest.analysisErrors
    expect(error?.rawResponseArtifact).toMatch(/^analysis\/case_.*\.raw-response\.txt$/)
    const artifact = await readFile(join(reviewerRoot, 'runs', result.manifest.runId, error!.rawResponseArtifact!), 'utf8')
    expect(artifact).toContain('[REDACTED]')
    expect(artifact).toContain('[WORKSPACE]')
    expect(artifact).not.toContain('sk-abcdefghijklmnop')
    expect(artifact).not.toContain('/workspace/project')
  })
})

function reviewerConfig(): MetaAgentConfig {
  return {
    apiKey: 'test-reviewer-key',
    baseURL: 'https://reviewer.invalid',
    model: 'reviewer-test-model',
    trajectory: { enabled: false },
  }
}

function toolUseEvent(): MetaAgentEvent {
  return {
    type: 'tool_use',
    toolUseId: 'review-overview',
    toolName: 'review_case_overview',
    toolInput: {},
    sessionId: 'reviewer-session',
  }
}

function resultEvent(result: string, numTurns: number, totalCostUsd: number): MetaAgentEvent {
  return {
    type: 'result',
    subtype: 'success',
    sessionId: 'reviewer-session',
    result,
    isError: false,
    durationMs: 10,
    numTurns,
    stopReason: 'end_turn',
    totalCostUsd,
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  }
}

function trajectoryIndexEntry(trajectoryId: string, parentTrajectoryId: string): TrajectoryIndexEntry {
  return {
    trajectoryId,
    subject: { kind: 'session', sessionId: trajectoryId },
    mode: 'agentic',
    createdAt: 1,
    lastActivity: 1,
    lastOrdinal: 1,
    parentTrajectoryId,
    toolCalls: 0,
    toolErrors: 0,
    runs: 0,
    totalCostUsd: 0,
  }
}

function draftWithEvidenceRole(
  draft: ModelTaskReview,
  proposalIndex: number,
  evidenceIndex: number,
  role: string,
): unknown {
  const copy = structuredClone(draft) as unknown as {
    proposalCandidates: Array<{ moment: { evidence: Array<{ role: string }> } }>
  }
  copy.proposalCandidates[proposalIndex]!.moment.evidence[evidenceIndex]!.role = role
  return copy
}

function draftWithModelAliases(draft: ModelTaskReview): unknown {
  const copy = structuredClone(draft) as unknown as {
    methodologyFindings: Array<{ category: string }>
    proposalCandidates: Array<{ moment: { evidence: Array<{ role: string }> } }>
  }
  copy.methodologyFindings[0]!.category = 'tool_usage'
  copy.methodologyFindings[1]!.category = 'calibration'
  copy.proposalCandidates[1]!.moment.evidence[0]!.role = 'failure'
  return copy
}

function reviewDraft(
  rootTrajectoryId: string,
  childTrajectoryId: string,
  rootAction: number,
  rootOutcome: number,
  childOutcome: number,
): ModelTaskReview {
  const majorProposal = proposalCandidate(rootTrajectoryId, childTrajectoryId, rootAction, childOutcome, 0)
  const minorProposal = {
    ...proposalCandidate(rootTrajectoryId, childTrajectoryId, rootAction, rootOutcome, 1),
    experienceDraft: {
      ...majorProposal.experienceDraft,
      title: '局部格式清理',
    },
  }
  return {
    task: {
      goal: '修复构建并由独立子任务验证结果',
      constraints: ['保持工作区兼容'],
      successCriteria: ['构建成功', '子任务验证通过'],
    },
    observations: [{
      statement: '根任务执行修复，子任务提供独立验证信号',
      epistemicStatus: 'observed',
      evidence: [
        { trajectoryId: rootTrajectoryId, ordinal: rootAction },
        { trajectoryId: childTrajectoryId, ordinal: childOutcome },
      ],
    }],
    decisions: [{
      decision: '修改依赖解析后交给子任务验证',
      rationale: '相同构建错误要求改变因果输入',
      alternativesConsidered: ['原样重试'],
      outcome: '根任务完成，子任务验证通过',
      evidence: [
        { trajectoryId: rootTrajectoryId, ordinal: rootAction },
        { trajectoryId: childTrajectoryId, ordinal: childOutcome },
      ],
    }],
    outcome: {
      verdict: 'solved',
      summary: '目标完成且有子任务验证证据',
      criteria: [
        {
          criterion: '构建成功',
          status: 'met',
          rationale: '根任务记录成功终态',
          evidence: [{ trajectoryId: rootTrajectoryId, ordinal: rootOutcome }],
        },
        {
          criterion: '子任务验证通过',
          status: 'met',
          rationale: '子任务工具结果成功',
          evidence: [{ trajectoryId: childTrajectoryId, ordinal: childOutcome }],
        },
      ],
    },
    assessment: {
      effectiveness: dimension('strong', rootTrajectoryId, rootOutcome),
      reliability: dimension('strong', childTrajectoryId, childOutcome),
      stability: dimension('adequate', rootTrajectoryId, rootOutcome),
      efficiency: dimension('adequate', rootTrajectoryId, rootAction),
    },
    processAudit: {
      solutionPath: {
        summary: '先识别确定性构建失败的因果输入，再修改该输入并交给独立子任务验证。',
        phases: [
          {
            phase: '诊断并修复',
            objective: '找出构建失败原因并改变因果输入',
            strategy: '根据失败结果修改依赖解析，而不是原样重试',
            outcome: '根任务记录构建修复',
            evidence: [
              { trajectoryId: rootTrajectoryId, ordinal: rootAction },
              { trajectoryId: rootTrajectoryId, ordinal: rootOutcome },
            ],
          },
          {
            phase: '独立验证',
            objective: '避免以 Agent 自己的完成声明作为唯一证据',
            strategy: '让子任务执行独立验证',
            outcome: '子任务验证通过',
            evidence: [{ trajectoryId: childTrajectoryId, ordinal: childOutcome }],
          },
        ],
      },
      pathQuality: {
        verdict: 'reasonable',
        rationale: '改变了确定性失败的因果输入，并增加独立验证；没有证据证明存在明显更短路径。',
        betterPath: [],
        evidence: [{ trajectoryId: rootTrajectoryId, ordinal: rootAction }],
      },
      successCriteriaQuality: {
        verdict: 'appropriate',
        rationale: '构建结果和独立验证共同覆盖目标。',
        missingCriteria: [],
        misleadingCriteria: [],
        evidence: [{ trajectoryId: childTrajectoryId, ordinal: childOutcome }],
      },
      completionIntegrity: {
        verdict: 'well_supported',
        rationale: '完成声明有根任务结果和独立验证支撑。',
        unsupportedClaims: [],
        unresolvedIssues: [],
        evidence: [
          { trajectoryId: rootTrajectoryId, ordinal: rootOutcome },
          { trajectoryId: childTrajectoryId, ordinal: childOutcome },
        ],
      },
      informationAdequacy: {
        verdict: 'sufficient',
        rationale: '失败结果提供了选择修复路径所需的信息。',
        notAvailableToAgent: [],
        availableButNotSought: [],
        reviewerVisibilityGaps: [],
        evidence: [{ trajectoryId: rootTrajectoryId, ordinal: rootAction }],
      },
      longHorizonControl: {
        verdict: 'not_applicable',
        rationale: '该任务没有跨长周期执行。',
        continuityMechanisms: [],
        issues: [
          { type: 'information_omission', status: 'not_observed', summary: '未观察到信息遗漏', evidence: [] },
          { type: 'memory_loss', status: 'not_observed', summary: '未观察到记忆丢失', evidence: [] },
          { type: 'noise_accumulation', status: 'not_observed', summary: '未观察到噪声累积', evidence: [] },
          { type: 'goal_drift', status: 'not_observed', summary: '未观察到目标偏移', evidence: [] },
        ],
        evidence: [{ trajectoryId: rootTrajectoryId, ordinal: rootOutcome }],
      },
    },
    methodologyFindings: [
      {
        category: 'solution_strategy',
        significance: 'major',
        abstractionLevel: 'cross_task',
        summary: '改变失败的因果输入后使用子任务验证',
        mechanism: '改变依赖解析消除确定性失败，独立验证降低自证风险',
        recommendation: '确定性失败后改变一个因果输入，并使用独立验证检查结果',
        expectedImpact: '显著提高任务可靠性和有效性',
        candidateEligible: true,
        evidence: [
          { trajectoryId: rootTrajectoryId, ordinal: rootAction },
          { trajectoryId: childTrajectoryId, ordinal: childOutcome },
        ],
      },
      {
        category: 'efficiency_strategy',
        significance: 'minor',
        abstractionLevel: 'task_specific',
        summary: '输出格式可以更紧凑',
        mechanism: '减少显示噪声',
        recommendation: '压缩局部输出',
        expectedImpact: '轻微减少文本',
        candidateEligible: true,
        evidence: [{ trajectoryId: rootTrajectoryId, ordinal: rootOutcome }],
      },
    ],
    proposalCandidates: [majorProposal, minorProposal],
  }
}

function dimension(
  rating: 'strong' | 'adequate',
  trajectoryId: string,
  ordinal: number,
) {
  return { rating, rationale: '由轨迹证据支持', evidence: [{ trajectoryId, ordinal }] }
}

function proposalCandidate(
  rootTrajectoryId: string,
  childTrajectoryId: string,
  actionOrdinal: number,
  outcomeOrdinal: number,
  findingIndex: number,
): ModelTaskLearningProposal {
  return {
    findingIndex,
    moment: {
      kind: 'transferable_pattern',
      taskSummary: '修复并验证构建',
      taskFamily: 'software_build',
      relevantState: ['确定性失败已重复出现'],
      action: '改变失败的因果输入并交给子任务验证',
      observedOutcome: '构建成功且验证通过',
      transferableHint: '适用于确定性工具失败后的恢复与验证',
      evidence: [
        { trajectoryId: rootTrajectoryId, ordinal: actionOrdinal, role: 'action' },
        { trajectoryId: childTrajectoryId, ordinal: outcomeOrdinal, role: 'verification' },
      ],
    },
    experienceDraft: {
      title: '确定性失败后改变因果输入并独立验证',
      category: 'recovery',
      applicability: {
        context: '工具在相同输入下返回确定性失败',
        cues: ['相同错误签名', '输入未变化'],
        prerequisites: ['能够识别可改变的因果输入'],
        excludes: ['已有证据表明是瞬时故障'],
      },
      policyDelta: {
        previousApproach: '原样重试',
        recommendedAction: '改变一个因果输入，并让独立检查验证结果',
        avoidAction: '条件不变时重复执行',
        expectedEffect: '提高恢复成功率并降低自证偏差',
      },
      mechanism: '确定性失败必须改变输入才能获得新结果，独立验证提供额外证据',
      verification: {
        checks: ['记录改变的输入', '运行独立验证'],
        successSignals: ['原错误消失', '验证通过'],
        failureSignals: ['相同错误再次出现', '验证失败'],
      },
      impact: {
        reliability: 'high',
        stability: 'high',
        effectiveness: 'high',
        rationale: ['减少无信息重试并增加独立验证'],
      },
    },
  }
}

function findOrdinal(
  taskCase: Awaited<ReturnType<typeof loadTaskCase>> & { members: unknown },
  trajectoryId: string,
  itemType: string,
): number {
  if ('reason' in taskCase) throw new Error(taskCase.reason)
  const member = taskCase.members.find(item => item.entry.trajectoryId === trajectoryId)!
  return member.lines.find(line => line.item.type === itemType)!.ordinal
}

async function taskCaseFixture(): Promise<{
  trajectoryRoot: string
  rootTrajectoryId: string
  childTrajectoryId: string
}> {
  const trajectoryRoot = await mkdtemp(join(tmpdir(), 'task-reviewer-run-'))
  temporaryRoots.push(trajectoryRoot)
  const root = await TrajectoryRecorder.open({
    subject: { kind: 'session', sessionId: 'task-review-root' },
    mode: 'auto',
    workspace: '/workspace/project',
  }, { rootDir: trajectoryRoot })
  await root.record({ type: 'message', message: { role: 'user', content: '修复构建并验证' } })
  await root.record({
    type: 'tool_outcome',
    toolUseId: 'root-build',
    toolName: 'bash',
    durationMs: 10,
    isError: true,
    outputSummary: 'module resolution failed',
    outputHash: 'root-failure',
    exitCode: 1,
  })
  await root.record({
    type: 'run_result',
    outcome: 'success',
    isError: false,
    resultSummary: 'build repaired',
  })
  await root.close()

  const child = await TrajectoryRecorder.open({
    subject: { kind: 'subagent', taskId: 'verify-build', sessionId: 'task-review-child' },
    mode: 'subagent',
    rootTrajectoryId: root.trajectoryId,
    parentTrajectoryId: root.trajectoryId,
    workspace: '/workspace/project',
  }, { rootDir: trajectoryRoot })
  await child.record({
    type: 'tool_outcome',
    toolUseId: 'child-verify',
    toolName: 'bash',
    durationMs: 10,
    isError: false,
    outputSummary: 'verification passed',
    outputHash: 'child-success',
    exitCode: 0,
  })
  await child.close()

  const reviewer = await TrajectoryRecorder.open({
    subject: { kind: 'session', sessionId: 'task-review-analysis' },
    mode: 'reviewer',
    rootTrajectoryId: root.trajectoryId,
    parentTrajectoryId: root.trajectoryId,
    workspace: '/workspace/project',
  }, { rootDir: trajectoryRoot })
  await reviewer.record({ type: 'message', message: { role: 'assistant', content: 'review analysis' } })
  await reviewer.close()
  return {
    trajectoryRoot,
    rootTrajectoryId: root.trajectoryId,
    childTrajectoryId: child.trajectoryId,
  }
}
