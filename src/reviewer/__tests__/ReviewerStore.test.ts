import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ReviewerStore } from '../ReviewerStore.js'
import type { ExperienceDraft, LearningMoment } from '../types.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('ReviewerStore human gate', () => {
  it('creates no ExperienceCandidate until a human approves the proposal', async () => {
    const root = await temporaryRoot()
    const store = new ReviewerStore(root)
    const stored = await store.addProposal({
      source: source('review-1'),
      moment: moment(),
      experienceDraft: draft(),
      now: 100,
    })

    expect(stored.proposal.status).toBe('pending')
    expect(await store.listCandidates()).toEqual([])

    const candidate = await store.approveProposal(stored.proposal.id, '证据和边界已人工核对', 200)
    expect(candidate).toMatchObject({
      proposalId: stored.proposal.id,
      status: 'approved',
      approvedBy: 'human',
      reviewNote: '证据和边界已人工核对',
    })
    expect(await store.getProposal(stored.proposal.id)).toMatchObject({
      status: 'approved',
      review: { decision: 'approved', reviewedBy: 'human' },
    })
    expect(await store.listCandidates()).toHaveLength(1)

    // Approval is idempotent and never creates a second candidate.
    expect((await store.approveProposal(stored.proposal.id)).id).toBe(candidate.id)
    expect(await store.listCandidates()).toHaveLength(1)
  })

  it('keeps a rejected proposal as audit evidence and never creates a candidate', async () => {
    const root = await temporaryRoot()
    const store = new ReviewerStore(root)
    const stored = await store.addProposal({
      source: source('review-2'),
      moment: moment('moment_rejected'),
      experienceDraft: { ...draft(), title: '会被拒绝的提案' },
    })

    const rejected = await store.rejectProposal(stored.proposal.id, '无法从轨迹复核机制')
    expect(rejected).toMatchObject({
      status: 'rejected',
      review: { decision: 'rejected', note: '无法从轨迹复核机制' },
    })
    expect(await store.listCandidates()).toEqual([])
    await expect(store.approveProposal(stored.proposal.id)).rejects.toThrow('already rejected')
  })

  it('deduplicates concurrent analyzer writes under a cross-process lock', async () => {
    const root = await temporaryRoot()
    const store = new ReviewerStore(root)
    const input = {
      source: source('review-concurrent'),
      moment: moment('moment_concurrent'),
      experienceDraft: draft(),
      now: 100,
    }
    const results = await Promise.all([store.addProposal(input), store.addProposal(input)])
    expect(results.map(result => result.duplicate).sort()).toEqual([false, true])
    expect(new Set(results.map(result => result.proposal.id))).toHaveLength(1)
    expect(await store.listProposals()).toHaveLength(1)
  })

  it('deduplicates by evidence window even when model wording changes after rejection', async () => {
    const root = await temporaryRoot()
    const store = new ReviewerStore(root)
    const original = await store.addProposal({
      source: source('review-original'),
      moment: moment('moment_original'),
      experienceDraft: draft(),
    })
    await store.rejectProposal(original.proposal.id, '不值得沉淀')

    const paraphrased = await store.addProposal({
      source: source('review-rerun'),
      moment: { ...moment('moment_paraphrased'), action: '换一种说法描述同一个动作' },
      experienceDraft: { ...draft(), title: '换一种标题也不能复活提案' },
    })
    expect(paraphrased.duplicate).toBe(true)
    expect(paraphrased.proposal.status).toBe('rejected')
    expect(await store.listProposals()).toHaveLength(1)
  })
})

function source(reviewerRunId: string) {
  return {
    reviewerRunId,
    windowId: 'window_123',
    windowHash: 'a'.repeat(64),
    proposalIndex: 0,
    trigger: 'repeated_failure',
    trajectoryIds: ['00000000-0000-4000-8000-000000000001'],
    analyzerId: 'fake-reviewer-v1',
  }
}

function moment(id = 'moment_123'): LearningMoment {
  const trajectoryId = '00000000-0000-4000-8000-000000000001'
  return {
    schemaVersion: 'learning-moment-1.0',
    id,
    kind: 'repeated_failure',
    context: {
      taskSummary: '修复重复失败的命令调用',
      workspaceId: 'workspace-1',
      relevantState: ['同一个命令连续失败两次'],
    },
    action: '未改变参数即重试相同命令',
    observedOutcome: '第二次得到相同错误',
    feedback: '重复错误说明继续重试不会增加信息',
    correction: '先读取错误信息并改变假设，再决定下一次动作',
    evidence: [
      { trajectoryId, ordinal: 3, itemType: 'tool_outcome', role: 'action' },
      { trajectoryId, ordinal: 4, itemType: 'tool_outcome', role: 'outcome' },
    ],
  }
}

function draft(): ExperienceDraft {
  return {
    title: '重复工具失败后先更新诊断假设',
    category: 'recovery',
    applicability: {
      context: '同一工具以相同输入重复返回相同错误时',
      cues: ['错误签名相同', '输入和环境未变化'],
      prerequisites: ['错误输出可读取'],
      excludes: ['错误明确属于瞬时网络抖动且已有退避策略'],
    },
    policyDelta: {
      previousApproach: '原样重试',
      recommendedAction: '停止原样重试，提取错误约束并修改一个可验证假设',
      avoidAction: '在输入和环境不变时继续调用',
      expectedEffect: '减少无信息增益的步骤并提高恢复成功率',
    },
    mechanism: '相同条件下的确定性失败不会因重复执行而产生新证据',
    verification: {
      checks: ['下一次调用前是否记录了改变的假设或输入'],
      successSignals: ['错误签名改变或工具成功'],
      failureSignals: ['再次出现完全相同的错误签名'],
    },
    impact: {
      reliability: 'medium',
      stability: 'high',
      effectiveness: 'medium',
      rationale: ['避免稳定陷入重复失败循环'],
    },
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'trajectory-reviewer-store-'))
  temporaryRoots.push(root)
  return root
}
