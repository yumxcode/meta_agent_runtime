import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearTrajectoryHubForTests } from '../../trajectory/hub.js'
import { TrajectoryRecorder } from '../../trajectory/recorder.js'
import type { PreservedTrajectoryLine, TrajectoryIndexEntry, TrajectoryItem } from '../../trajectory/types.js'
import type { LearningAnalyzer } from '../LearningAnalyzer.js'
import { materializeLearningMoment, runTrajectoryReview } from '../ReviewRunner.js'
import { ReviewerStore } from '../ReviewerStore.js'
import { buildReviewWindows } from '../TrajectoryReviewScanner.js'
import type { ModelLearningProposal } from '../types.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  clearTrajectoryHubForTests()
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('trajectory Reviewer pipeline', () => {
  it('scans canonical trajectories into pending proposals without touching a candidate store', async () => {
    const root = await temporaryRoot()
    const reviewerRoot = join(root, 'isolated-reviewer')
    const recorder = await TrajectoryRecorder.open({
      subject: { kind: 'session', sessionId: 'review-source-session' },
      mode: 'agentic',
      workspace: '/workspace/review-source',
      workspaceId: 'workspace-review-source',
    }, { rootDir: root })
    await recorder.record({ type: 'message', message: { role: 'user', content: '修复构建' } })
    for (const toolUseId of ['tool-1', 'tool-2']) {
      await recorder.record({
        type: 'tool_outcome',
        toolUseId,
        toolName: 'bash',
        durationMs: 5,
        isError: true,
        outputSummary: 'build failed: missing module foo',
        outputHash: 'same-error',
        command: 'npm run build',
        exitCode: 1,
      })
    }
    await recorder.close()

    const analyzer = new RepeatedFailureAnalyzer()
    const first = await runTrajectoryReview({
      analyzer,
      trajectoryRootDir: root,
      reviewerRootDir: reviewerRoot,
      scope: { all: true },
    })
    expect(first.manifest.stats).toMatchObject({
      trajectoriesSelected: 1,
      trajectoriesScanned: 1,
      candidateWindows: 1,
      proposalsGenerated: 1,
      proposalsDeduplicated: 0,
    })

    const store = new ReviewerStore(reviewerRoot)
    const pending = await store.listProposals('pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.source.trajectoryIds).toEqual([recorder.trajectoryId])
    expect(pending[0]!.moment.evidence.every(ref => ref.trajectoryId === recorder.trajectoryId)).toBe(true)
    expect(await store.listCandidates()).toEqual([])

    // A second scan skips the unchanged input before another model call; it
    // still cannot bypass the human gate.
    const second = await runTrajectoryReview({
      analyzer,
      trajectoryRootDir: root,
      reviewerRootDir: reviewerRoot,
      scope: { all: true },
    })
    expect(second.manifest.stats).toMatchObject({
      trajectoriesUnchanged: 1,
      modelCalls: 0,
      proposalsGenerated: 0,
    })
    expect(await store.listCandidates()).toEqual([])

    await store.approveProposal(pending[0]!.id)
    expect(await store.listCandidates()).toHaveLength(1)
  })

  it('rejects model evidence that points outside the bounded trajectory window', () => {
    const proposal = proposalFor(2, 999)
    expect(() => materializeLearningMoment({
      id: 'window_1',
      trajectoryId: '00000000-0000-4000-8000-000000000001',
      trigger: 'repeated_failure',
      triggerOrdinals: [2, 3],
      taskSummary: 'test',
      lines: [
        { ordinal: 2, ts: 1, itemType: 'tool_outcome', text: 'first failure' },
        { ordinal: 3, ts: 2, itemType: 'tool_outcome', text: 'second failure' },
      ],
    }, proposal)).toThrow("evidence ordinal 999 is outside review window")
  })

  it('enforces a model-call budget and resumes only unfinished windows', async () => {
    const root = await temporaryRoot()
    const reviewerRoot = join(root, 'budgeted-reviewer')
    const recorder = await TrajectoryRecorder.open({
      subject: { kind: 'session', sessionId: 'budget-source-session' },
      mode: 'agentic',
    }, { rootDir: root })
    for (const signature of ['alpha', 'beta', 'gamma']) {
      for (let attempt = 0; attempt < 2; attempt++) {
        await recorder.record({
          type: 'tool_outcome',
          toolUseId: `${signature}-${attempt}`,
          toolName: 'bash',
          durationMs: 1,
          isError: true,
          outputSummary: `${signature} deterministic failure`,
          outputHash: signature,
          exitCode: 1,
        })
      }
    }
    await recorder.close()

    const analyzer = new NoLearningAnalyzer()
    const progress: string[] = []
    const first = await runTrajectoryReview({
      analyzer,
      trajectoryRootDir: root,
      reviewerRootDir: reviewerRoot,
      scope: { all: true, maxWindows: 2 },
      onProgress: event => progress.push(event.phase),
    })
    expect(first.manifest.stats).toMatchObject({
      candidateWindows: 3,
      modelCalls: 2,
      windowsSkippedBudget: 1,
      noLearningWindows: 2,
    })
    expect(first.manifest.completedTrajectoryIds).not.toContain(recorder.trajectoryId)
    expect(first.manifest.noLearning).toHaveLength(2)
    expect(first.report).toContain('## No learning extracted')
    expect(progress.filter(phase => phase === 'model_call')).toHaveLength(2)

    const second = await runTrajectoryReview({
      analyzer,
      trajectoryRootDir: root,
      reviewerRootDir: reviewerRoot,
      scope: { all: true, maxWindows: 5 },
    })
    expect(second.manifest.stats).toMatchObject({
      modelCalls: 1,
      windowsPreviouslyReviewed: 2,
      windowsSkippedBudget: 0,
    })
    expect(second.manifest.completedTrajectoryIds).toContain(recorder.trajectoryId)

    const third = await runTrajectoryReview({
      analyzer,
      trajectoryRootDir: root,
      reviewerRootDir: reviewerRoot,
      scope: { all: true },
    })
    expect(third.manifest.stats).toMatchObject({ trajectoriesUnchanged: 1, modelCalls: 0 })
  })

  it('reports analyzer failures separately from host quality-gate rejections', async () => {
    const root = await temporaryRoot()
    const reviewerRoot = join(root, 'reviewer-error-taxonomy')
    const recorder = await TrajectoryRecorder.open({
      subject: { kind: 'session', sessionId: 'error-taxonomy-session' },
      mode: 'agentic',
    }, { rootDir: root })
    for (const signature of ['first', 'second']) {
      for (let attempt = 0; attempt < 2; attempt++) {
        await recorder.record({
          type: 'tool_outcome',
          toolUseId: `${signature}-${attempt}`,
          toolName: 'bash',
          durationMs: 1,
          isError: true,
          outputSummary: `${signature} failure`,
          outputHash: signature,
          exitCode: 1,
        })
      }
    }
    await recorder.close()

    let calls = 0
    const analyzer: LearningAnalyzer = {
      id: 'fake-error-taxonomy-v1',
      analyze: async () => {
        calls++
        if (calls === 1) return { proposals: [proposalFor(999, 1_000)] }
        throw new Error('analyzer unavailable')
      },
    }
    const result = await runTrajectoryReview({
      analyzer,
      trajectoryRootDir: root,
      reviewerRootDir: reviewerRoot,
      scope: { all: true },
    })
    expect(result.manifest.stats).toMatchObject({ qualityRejections: 1, analysisErrors: 1 })
    expect(result.manifest.qualityRejections[0]!.reason).toContain('outside review window')
    expect(result.manifest.analysisErrors[0]!.error).toBe('analyzer unavailable')
    expect(result.report).toContain('## Quality-gate rejections')
    expect(result.report).toContain('## Analysis errors')
  })

  it('--force rechecks proposal-free windows but never reanalyzes an existing proposal identity', async () => {
    const root = await temporaryRoot()
    const reviewerRoot = join(root, 'force-semantics-reviewer')
    const recorder = await TrajectoryRecorder.open({
      subject: { kind: 'session', sessionId: 'force-semantics-session' },
      mode: 'agentic',
    }, { rootDir: root })
    for (const attempt of [1, 2]) {
      await recorder.record({
        type: 'tool_outcome',
        toolUseId: `force-${attempt}`,
        toolName: 'bash',
        durationMs: 1,
        isError: true,
        outputSummary: 'force semantics failure',
        outputHash: 'force',
        exitCode: 1,
      })
    }
    await recorder.close()

    let calls = 0
    const analyzer: LearningAnalyzer = {
      id: 'fake-force-semantics-v1',
      analyze: async window => {
        calls++
        if (calls === 1) return { proposals: [], noLearningReason: 'first pass found no learning' }
        const errors = window.lines.filter(line => line.itemType === 'tool_outcome')
        return { proposals: [proposalFor(errors[0]!.ordinal, errors[1]!.ordinal)] }
      },
    }

    const first = await runTrajectoryReview({
      analyzer,
      trajectoryRootDir: root,
      reviewerRootDir: reviewerRoot,
      scope: { all: true },
    })
    expect(first.manifest.stats).toMatchObject({ modelCalls: 1, noLearningWindows: 1 })

    const forced = await runTrajectoryReview({
      analyzer,
      trajectoryRootDir: root,
      reviewerRootDir: reviewerRoot,
      scope: { all: true, force: true },
    })
    expect(forced.manifest.stats).toMatchObject({ modelCalls: 1, proposalsGenerated: 1 })

    const forcedAgain = await runTrajectoryReview({
      analyzer,
      trajectoryRootDir: root,
      reviewerRootDir: reviewerRoot,
      scope: { all: true, force: true },
    })
    expect(forcedAgain.manifest.stats).toMatchObject({
      modelCalls: 0,
      windowsPreviouslyReviewed: 1,
      proposalsGenerated: 0,
    })
    expect(calls).toBe(2)
  })

  it('surfaces unknown evaluation verdicts without guessing pass or fail', async () => {
    const root = await temporaryRoot()
    const reviewerRoot = join(root, 'unknown-verdict-reviewer')
    const recorder = await TrajectoryRecorder.open({
      subject: { kind: 'session', sessionId: 'unknown-verdict-session' },
      mode: 'agentic',
    }, { rootDir: root })
    await recorder.record({
      type: 'evaluation',
      evaluator: 'future_judge',
      verdict: 'provisionally_green',
    })
    await recorder.close()

    const analyzer: LearningAnalyzer = {
      id: 'fake-unknown-verdict-v1',
      analyze: async () => { throw new Error('no window should reach the analyzer') },
    }
    const result = await runTrajectoryReview({
      analyzer,
      trajectoryRootDir: root,
      reviewerRootDir: reviewerRoot,
      scope: { all: true },
    })
    expect(result.manifest.stats).toMatchObject({ modelCalls: 0, unknownVerdicts: 1 })
    expect(result.manifest.unknownVerdicts[0]).toMatchObject({
      evaluator: 'future_judge',
      verdict: 'provisionally_green',
    })
    expect(result.report).toContain('## Unknown evaluation verdicts')
  })

  it('opens a human-correction window and redacts evidence before review', () => {
    const trajectoryId = '00000000-0000-4000-8000-000000000002'
    const items: TrajectoryItem[] = [
      {
        type: 'trajectory_meta',
        subject: { kind: 'session', sessionId: 'human-correction-session' },
        mode: 'agentic',
        createdAt: 1,
      },
      {
        type: 'message',
        message: { role: 'assistant', content: 'I will use sk-abcdefghijklmnopqrstuv' },
      },
      {
        type: 'approval',
        toolUseId: 'dangerous-tool',
        toolName: 'bash',
        decision: 'redirect',
        decidedBy: 'human',
        reason: '先采用只读检查',
      },
    ]
    const lines: PreservedTrajectoryLine[] = items.map((item, index) => ({
      schemaVersion: 'trajectory-line-1.0',
      ts: index + 1,
      ordinal: index + 1,
      trajectoryId,
      item,
      knownItem: true,
      rawLine: JSON.stringify(item),
    }))
    const entry: TrajectoryIndexEntry = {
      trajectoryId,
      subject: { kind: 'session', sessionId: 'human-correction-session' },
      mode: 'agentic',
      createdAt: 1,
      lastActivity: 3,
      lastOrdinal: 3,
      toolCalls: 0,
      toolErrors: 0,
      runs: 0,
      totalCostUsd: 0,
      firstPrompt: '参考 https://example.com/docs/guide 修复 /Users/alice/private/repo，token=sk-abcdefghijklmnopqrstuv',
    }

    const windows = buildReviewWindows(entry, lines)
    expect(windows).toHaveLength(1)
    expect(windows[0]!.trigger).toBe('human_correction')
    expect(windows[0]!.lines.map(line => line.text).join(' ')).not.toContain('sk-abcdefghijklmnopqrstuv')
    expect(windows[0]!.lines.map(line => line.text).join(' ')).toContain('[REDACTED]')
    expect(windows[0]!.taskSummary).not.toContain('/Users/alice/private/repo')
    expect(windows[0]!.taskSummary).not.toContain('sk-abcdefghijklmnopqrstuv')
    expect(windows[0]!.taskSummary).toContain('https://example.com/docs/guide')
  })

  it('only treats explicit negative evaluation verdicts as reviewer corrections', () => {
    const { entry, lines } = trajectoryFixture([
      { type: 'evaluation', evaluator: 'judge', verdict: 'pass_with_notes' },
      { type: 'evaluation', evaluator: 'judge', verdict: 'satisfied' },
      { type: 'evaluation', evaluator: 'judge', verdict: '通过' },
      { type: 'evaluation', evaluator: 'judge', verdict: 'fail' },
    ])
    const corrections = buildReviewWindows(entry, lines)
      .filter(window => window.trigger === 'reviewer_correction')
    expect(corrections).toHaveLength(1)
    expect(corrections[0]!.triggerOrdinals).toEqual([5])
  })

  it('recognizes legacy Auto Verify feedback and steering as correction signals', () => {
    const { entry, lines } = trajectoryFixture([
      {
        type: 'message',
        message: {
          role: 'user',
          isMeta: true,
          content: '[系统·完成度审核 第 1 轮] 尚未覆盖失败路径',
        },
      },
      {
        type: 'message',
        message: { role: 'user', isSteering: true, content: '不要改配置，先做只读诊断' },
      },
    ])
    const windows = buildReviewWindows(entry, lines)
    expect(windows.map(window => window.trigger)).toEqual([
      'reviewer_correction',
      'human_correction',
    ])
  })

  it('does not duplicate a structured Auto Verify failure through its legacy message', () => {
    const fixture = trajectoryFixture([
      { type: 'evaluation', evaluator: 'auto_verify', verdict: 'fail' },
      {
        type: 'message',
        message: {
          role: 'user',
          isMeta: true,
          content: '[系统·完成度审核 第 1 轮] 尚未覆盖失败路径',
        },
      },
    ])
    const lines = fixture.lines.map(line => ({ ...line, runId: '00000000-0000-4000-8000-000000000123' }))
    const corrections = buildReviewWindows(fixture.entry, lines)
      .filter(window => window.trigger === 'reviewer_correction')
    expect(corrections).toHaveLength(1)
    expect(corrections[0]!.triggerOrdinals).toEqual([2])
  })

  it('merges a dense repeated-failure series instead of calling once per pair', () => {
    const failures: TrajectoryItem[] = Array.from({ length: 6 }, (_, index) => ({
      type: 'tool_outcome',
      toolUseId: `dense-failure-${index}`,
      toolName: 'bash',
      durationMs: 1,
      isError: true,
      outputSummary: 'same dense deterministic failure',
      outputHash: 'same',
      exitCode: 1,
    }))
    const { entry, lines } = trajectoryFixture(failures)
    const windows = buildReviewWindows(entry, lines)
      .filter(window => window.trigger === 'repeated_failure')
    expect(windows).toHaveLength(1)
    expect(windows[0]!.triggerOrdinals).toEqual([2, 3, 4, 5, 6, 7])
  })

  it('keeps every repeated-failure trigger ordinal inside its bounded window', () => {
    const items: TrajectoryItem[] = []
    for (let ordinal = 2; ordinal <= 90; ordinal++) {
      if ([2, 45, 88].includes(ordinal)) {
        items.push({
          type: 'tool_outcome',
          toolUseId: `failure-${ordinal}`,
          toolName: 'bash',
          durationMs: 1,
          isError: true,
          outputSummary: 'same deterministic failure',
          outputHash: 'same',
          exitCode: 1,
        })
      } else {
        items.push({ type: 'phase', domain: 'test', action: `step-${ordinal}` })
      }
    }
    const { entry, lines } = trajectoryFixture(items)
    const windows = buildReviewWindows(entry, lines)
      .filter(window => window.trigger === 'repeated_failure')
    expect(windows).toHaveLength(2)
    for (const window of windows) {
      const ordinals = new Set(window.lines.map(line => line.ordinal))
      expect(window.triggerOrdinals.every(ordinal => ordinals.has(ordinal))).toBe(true)
    }
    expect(windows.at(-1)!.triggerOrdinals).toContain(88)
  })
})

class RepeatedFailureAnalyzer implements LearningAnalyzer {
  readonly id = 'fake-repeated-failure-reviewer-v1'

  async analyze(window: Parameters<LearningAnalyzer['analyze']>[0]) {
    const errors = window.lines.filter(line => line.itemType === 'tool_outcome')
    return { proposals: [proposalFor(errors[0]!.ordinal, errors[1]!.ordinal)] }
  }
}

class NoLearningAnalyzer implements LearningAnalyzer {
  readonly id = 'fake-no-learning-reviewer-v1'

  async analyze() {
    return { proposals: [], noLearningReason: '重复出现，但轨迹里没有策略变化或修正结果。' }
  }
}

function proposalFor(actionOrdinal: number, outcomeOrdinal: number): ModelLearningProposal {
  return {
    moment: {
      kind: 'repeated_failure',
      taskSummary: '修复构建失败',
      taskFamily: 'software_build',
      relevantState: ['相同命令和相同错误签名重复出现'],
      expectation: {
        statement: '原样重试可能成功',
        source: 'action_implied',
        confidence: 'medium',
      },
      action: '在条件未变化时原样重试构建命令',
      observedOutcome: '构建以相同的缺失模块错误再次失败',
      feedback: '第二次失败没有提供新信息',
      correction: '先确认缺失依赖来源并改变环境或命令，再执行验证',
      transferableHint: '适用于确定性工具错误的恢复流程',
      evidence: [
        { ordinal: actionOrdinal, role: 'action' },
        { ordinal: outcomeOrdinal, role: 'outcome' },
      ],
    },
    experienceDraft: {
      title: '相同构建错误重复后先改变诊断假设',
      category: 'recovery',
      applicability: {
        context: '构建命令在输入与环境未变化时重复返回同一错误',
        cues: ['相同退出码', '相同错误签名'],
        prerequisites: ['能够读取错误摘要'],
        excludes: ['已确认是瞬时远端故障且正在执行有界退避'],
      },
      policyDelta: {
        previousApproach: '原样重试',
        recommendedAction: '停止原样重试，定位缺失模块的解析路径并只改变一个假设后验证',
        avoidAction: '无条件重复相同构建命令',
        expectedEffect: '减少无信息步骤并提高恢复概率',
      },
      mechanism: '确定性错误在条件不变时会稳定复现，必须改变其因果输入才能获得新证据',
      verification: {
        checks: ['下一次构建前是否验证了解析路径或依赖安装状态'],
        successSignals: ['缺失模块错误消失'],
        failureSignals: ['相同错误签名第三次出现'],
      },
      impact: {
        reliability: 'medium',
        stability: 'high',
        effectiveness: 'medium',
        rationale: ['防止工作流陷入无进展重试'],
      },
    },
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'trajectory-reviewer-run-'))
  temporaryRoots.push(root)
  return root
}

function trajectoryFixture(items: TrajectoryItem[]): {
  entry: TrajectoryIndexEntry
  lines: PreservedTrajectoryLine[]
} {
  const trajectoryId = '00000000-0000-4000-8000-000000000099'
  const allItems: TrajectoryItem[] = [{
    type: 'trajectory_meta',
    subject: { kind: 'session', sessionId: 'review-scanner-fixture' },
    mode: 'agentic',
    createdAt: 1,
  }, ...items]
  return {
    entry: {
      trajectoryId,
      subject: { kind: 'session', sessionId: 'review-scanner-fixture' },
      mode: 'agentic',
      createdAt: 1,
      lastActivity: allItems.length,
      lastOrdinal: allItems.length,
      toolCalls: 0,
      toolErrors: 0,
      runs: 0,
      totalCostUsd: 0,
    },
    lines: allItems.map((item, index) => ({
      schemaVersion: 'trajectory-line-1.0',
      ts: index + 1,
      ordinal: index + 1,
      trajectoryId,
      item,
      knownItem: true,
      rawLine: JSON.stringify(item),
    })),
  }
}
