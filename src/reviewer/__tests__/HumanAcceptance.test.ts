/**
 * Human acceptance verdicts (T3).
 *
 * This is the first evidence in the system above T1, and `MINIMUM_PROMOTION_TIER`
 * is T3 — so these labels are the only thing that could currently anchor a
 * promotion decision. That makes their integrity worth more than their
 * convenience, which is what most of these tests are about:
 *
 *   - `unclear` is a real answer, never coerced into a binary;
 *   - a label is bound to the case content it was formed against, so it cannot
 *     silently come to describe work the rater never saw;
 *   - recording one cannot disturb anything the Reviewer already stored.
 */
import { mkdtemp, rm, readdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HumanAcceptanceStore,
  ACCEPTANCE_VERDICTS,
  isAcceptedAsDone,
  isConclusiveVerdict,
  summariseAcceptance,
  type HumanAcceptance,
  type AcceptanceStatus,
} from '../HumanAcceptance.js'
import { ReviewerStore } from '../ReviewerStore.js'
import { evaluatorTier, canGatePromotion, canDriveAutomaticMetric } from '../../evolution/EvaluatorTrust.js'

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function store(): Promise<HumanAcceptanceStore> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-acceptance-'))
  tempDirs.push(dir)
  return new HumanAcceptanceStore(dir)
}

const CASE_ID = `case_${'a'.repeat(24)}`
const ROOT = '00000000-0000-4000-8000-000000000001'

function acceptance(overrides: Partial<HumanAcceptance> = {}): HumanAcceptance {
  return {
    schemaVersion: 'human-acceptance-1.0',
    caseId: CASE_ID,
    rootTrajectoryId: ROOT,
    verdict: 'completed',
    ratedInputHash: 'hash-v1',
    ratedAt: 1_700_000_000_000,
    ...overrides,
  } as HumanAcceptance
}

describe('the verdict vocabulary', () => {
  it('offers exactly four coarse verdicts', () => {
    expect([...ACCEPTANCE_VERDICTS]).toEqual([
      'completed', 'completed_with_concerns', 'not_completed', 'unclear',
    ])
  })

  it('treats "completed with concerns" as delivered', () => {
    // The work landed. The concerns are a cost signal, not a completion one,
    // and folding them into "not done" would overstate the failure rate.
    expect(isAcceptedAsDone('completed_with_concerns')).toBe(true)
    expect(isAcceptedAsDone('completed')).toBe(true)
    expect(isAcceptedAsDone('not_completed')).toBe(false)
  })

  it('treats "unclear" as carrying no ground truth', () => {
    // A rater who cannot tell must not be forced to guess — a guess in this
    // dataset is worse than a gap, because the whole point is that it is true.
    expect(isConclusiveVerdict('unclear')).toBe(false)
    expect(isAcceptedAsDone('unclear')).toBe(false)
  })
})

describe('HumanAcceptanceStore', () => {
  it('records and reads back a verdict', async () => {
    const s = await store()
    await s.record(acceptance())
    expect(await s.get(CASE_ID)).toMatchObject({ verdict: 'completed', ratedInputHash: 'hash-v1' })
  })

  it('returns null for an unrated case', async () => {
    expect(await (await store()).get(`case_${'b'.repeat(24)}`)).toBeNull()
  })

  it('lets a verdict be revised', async () => {
    const s = await store()
    await s.record(acceptance({ verdict: 'completed' }))
    await s.record(acceptance({ verdict: 'not_completed', note: 'I had to redo it' }))
    expect(await s.get(CASE_ID)).toMatchObject({ verdict: 'not_completed', note: 'I had to redo it' })
  })

  it('refuses a case id that could escape the store directory', async () => {
    const s = await store()
    await expect(s.get('../../etc/passwd')).rejects.toThrow(/invalid case id/)
  })

  it('rejects a verdict outside the vocabulary', async () => {
    const s = await store()
    await expect(s.record(acceptance({ verdict: 'looks_fine' as HumanAcceptance['verdict'] })))
      .rejects.toThrow()
  })

  it('lists rated case ids', async () => {
    const s = await store()
    await s.record(acceptance())
    expect([...await s.ratedCaseIds()]).toEqual([CASE_ID])
  })
})

describe('a label is bound to what the rater actually saw', () => {
  it('is current while the case is unchanged', async () => {
    const s = await store()
    await s.record(acceptance({ ratedInputHash: 'hash-v1' }))
    expect(await s.status(CASE_ID, 'hash-v1')).toMatchObject({ stale: false })
  })

  it('goes stale once the case grows', async () => {
    // Without this, a verdict formed on a three-turn case would keep describing
    // that case after it grew to thirty — asserting acceptance of work the
    // rater never saw.
    const s = await store()
    await s.record(acceptance({ ratedInputHash: 'hash-v1' }))
    expect(await s.status(CASE_ID, 'hash-v2')).toMatchObject({ stale: true })
  })

  it('keeps the stale verdict rather than deleting it', async () => {
    // It was a real judgement about a real state; it just no longer describes
    // the present one.
    const s = await store()
    await s.record(acceptance({ ratedInputHash: 'hash-v1' }))
    const status = await s.status(CASE_ID, 'hash-v2')
    expect(status?.acceptance.verdict).toBe('completed')
  })
})

describe('summariseAcceptance', () => {
  function status(verdict: HumanAcceptance['verdict'], stale = false): AcceptanceStatus {
    return { acceptance: acceptance({ verdict }), stale }
  }

  it('counts only fresh, conclusive labels as usable ground truth', () => {
    const summary = summariseAcceptance([
      status('completed'),
      status('completed_with_concerns'),
      status('not_completed'),
      status('unclear'),                 // conclusive? no
      status('completed', true),         // fresh? no
    ])
    expect(summary.rated).toBe(5)
    expect(summary.usable).toBe(3)
    expect(summary.stale).toBe(1)
    expect(summary.byVerdict.completed).toBe(2)
  })

  it('reports zero counts for verdicts nobody used', () => {
    const summary = summariseAcceptance([status('completed')])
    expect(summary.byVerdict.not_completed).toBe(0)
    expect(summary.byVerdict.unclear).toBe(0)
  })
})

describe('trust registration', () => {
  it('registers human acceptance as T3, the first in the system', () => {
    expect(evaluatorTier('human_acceptance')).toBe('T3')
    expect(canGatePromotion('human_acceptance')).toBe(true)
    expect(canDriveAutomaticMetric('human_acceptance')).toBe(true)
  })

  it('leaves the existing tiers exactly where they were', () => {
    // Adding a T3 entry must not quietly promote anything else.
    expect(evaluatorTier('executor_self_report')).toBe('T0')
    expect(evaluatorTier('auto_verify')).toBe('T1')
    expect(canGatePromotion('auto_verify')).toBe(false)
  })
})

describe('the Reviewer is only added to, never changed', () => {
  it('exposes acceptance as a sibling store under the reviewer root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meta-agent-reviewer-'))
    tempDirs.push(root)
    const reviewer = new ReviewerStore(root)
    await reviewer.ensureLayout()

    const dirs = await readdir(root)
    // The pre-existing layout is intact; acceptance sits beside it.
    for (const expected of ['proposals', 'candidates', 'task-reviews', 'runs', 'acceptance']) {
      expect(dirs).toContain(expected)
    }
  })

  it('records a verdict without touching task reviews or proposals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meta-agent-reviewer-'))
    tempDirs.push(root)
    const reviewer = new ReviewerStore(root)
    await reviewer.acceptance.record(acceptance())

    // Stronger than "left empty": rating does not so much as create the
    // Reviewer's own directories, because the acceptance store provisions only
    // itself. Nothing about stored TaskReview identity or incremental-skip
    // bookkeeping can move as a side effect of recording a verdict.
    await expect(readdir(reviewer.paths.taskReviews)).rejects.toThrow(/ENOENT/)
    await expect(readdir(reviewer.paths.proposals)).rejects.toThrow(/ENOENT/)
    // The verdict itself did land.
    expect(await reviewer.acceptance.get(CASE_ID)).not.toBeNull()
  })
})
