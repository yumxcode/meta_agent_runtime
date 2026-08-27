/**
 * EvalCase / EvalSet contracts (G1-3).
 *
 * These schemas encode three refusals that a code review would not reliably
 * catch, because each produces a plausible-looking number rather than an error:
 *
 *   1. re-executing a case whose starting state cannot be restored;
 *   2. judging a candidate on criteria written after reading the outcome;
 *   3. splitting a corpus on case id while rewrites of the same task sit on
 *      both sides.
 *
 * The third is the one that quietly turns memorisation into a good score, and
 * it is what `detectSplitLeakage` exists for.
 */
import { describe, expect, it } from 'vitest'
import {
  EvalCaseSchema,
  EvalSetSchema,
  detectSplitLeakage,
  countReExecutableCases,
  type EvalCase,
} from '../types.js'

function evalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    schemaVersion: 'eval-case-2.0',
    id: `evalcase_${'a'.repeat(24)}`,
    origin: {
      caseId: 'case-1',
      rootTrajectoryId: '00000000-0000-4000-8000-000000000001',
      taskReviewId: 'review-1',
    },
    prompt: 'Fix the failing voxel test',
    mode: 'agentic',
    eligibilityRef: 'elig-1',
    baseSnapshotRef: `basesnap_${'b'.repeat(24)}`,
    environmentManifestRef: 'envman-1',
    evaluatorBundleRef: 'bundle-1',
    resetRecipeRef: 'reset-1',
    criteriaOrigin: 'human_curated',
    contaminationGroupId: 'group-1',
    riskTier: 'R1',
    successCriteria: [{ id: 'c1', statement: 'the test passes', checkRef: 'bundle-1#test' }],
    replayClass: 'deterministic',
    environmentFidelity: 'restored',
    split: 'validation',
    frozenAt: 1_700_000_000_000,
    ...overrides,
  } as EvalCase
}

describe('EvalCaseSchema — a case that cannot be re-executed stays in support', () => {
  it('accepts a fully restorable case in any split', () => {
    expect(() => EvalCaseSchema.parse(evalCase({ split: 'sealed_test' }))).not.toThrow()
  })

  it('rejects an unrestorable case outside support', () => {
    // Re-executing from an unrestorable state means starting somewhere the
    // original task never was. The result would be about a different task.
    expect(() => EvalCaseSchema.parse(evalCase({
      environmentFidelity: 'unrestorable',
      split: 'validation',
    }))).toThrow(/may only sit in 'support'/)
  })

  it('rejects a non-replayable case outside support', () => {
    expect(() => EvalCaseSchema.parse(evalCase({
      replayClass: 'non_replayable',
      split: 'canary',
    }))).toThrow(/may only sit in 'support'/)
  })

  it('allows both in support, which exists for exactly this', () => {
    expect(() => EvalCaseSchema.parse(evalCase({
      environmentFidelity: 'unrestorable',
      replayClass: 'non_replayable',
      split: 'support',
    }))).not.toThrow()
  })

  it('treats approximated fidelity as re-executable', () => {
    // Approximated means something is missing but the case still starts from a
    // real captured state. Barring it everywhere would leave almost nothing.
    expect(() => EvalCaseSchema.parse(evalCase({
      environmentFidelity: 'approximated',
      split: 'validation',
    }))).not.toThrow()
  })
})

describe('EvalCaseSchema — retrospective criteria stay out of sealed test', () => {
  it('rejects reviewer-generated criteria in sealed_test', () => {
    // The Reviewer writes these after reading the outcome, so they can be
    // shaped to match what already happened. Sealed test is the one split with
    // no second chance to notice.
    expect(() => EvalCaseSchema.parse(evalCase({
      criteriaOrigin: 'reviewer_generated',
      split: 'sealed_test',
    }))).toThrow(/post-treatment bias/)
  })

  it('allows reviewer-generated criteria elsewhere', () => {
    for (const split of ['support', 'validation', 'canary'] as const) {
      expect(() => EvalCaseSchema.parse(evalCase({ criteriaOrigin: 'reviewer_generated', split })))
        .not.toThrow()
    }
  })

  it('allows human-curated and external-spec criteria in sealed_test', () => {
    for (const criteriaOrigin of ['user', 'external_spec', 'human_curated'] as const) {
      expect(() => EvalCaseSchema.parse(evalCase({ criteriaOrigin, split: 'sealed_test' })))
        .not.toThrow()
    }
  })
})

describe('EvalCaseSchema — structural guards', () => {
  it('rejects modes that cannot be re-executed at all', () => {
    // campaign spans too long to replay; robotics needs real hardware.
    expect(() => EvalCaseSchema.parse(evalCase({ mode: 'robotics' as EvalCase['mode'] }))).toThrow()
    expect(() => EvalCaseSchema.parse(evalCase({ mode: 'campaign' as EvalCase['mode'] }))).toThrow()
  })

  it('requires at least one success criterion', () => {
    expect(() => EvalCaseSchema.parse(evalCase({ successCriteria: [] }))).toThrow()
  })

  it('rejects duplicate criterion ids', () => {
    expect(() => EvalCaseSchema.parse(evalCase({
      successCriteria: [
        { id: 'c1', statement: 'a', checkRef: 'bundle-1#a' },
        { id: 'c1', statement: 'b', checkRef: 'bundle-1#b' },
      ],
    }))).toThrow(/unique/)
  })

  it('rejects unknown fields rather than silently dropping them', () => {
    expect(() => EvalCaseSchema.parse({ ...evalCase(), setupCommands: ['rm -rf /'] })).toThrow()
  })

  it('rejects a malformed id', () => {
    expect(() => EvalCaseSchema.parse(evalCase({ id: '../../etc/passwd' as EvalCase['id'] }))).toThrow()
  })
})

describe('detectSplitLeakage', () => {
  it('finds nothing when each contamination group sits in one split', () => {
    expect(detectSplitLeakage([
      evalCase({ id: `evalcase_${'a'.repeat(24)}`, contaminationGroupId: 'g1', split: 'validation' }),
      evalCase({ id: `evalcase_${'b'.repeat(24)}`, contaminationGroupId: 'g2', split: 'sealed_test' }),
    ])).toEqual([])
  })

  it('catches the same task appearing on both sides of a split', () => {
    // The failure this exists for: a case used to generate a candidate and a
    // rewrite of that case used to judge it are not two independent samples.
    const leaks = detectSplitLeakage([
      evalCase({ id: `evalcase_${'a'.repeat(24)}`, contaminationGroupId: 'g1', split: 'support' }),
      evalCase({ id: `evalcase_${'b'.repeat(24)}`, contaminationGroupId: 'g1', split: 'sealed_test' }),
    ])
    expect(leaks).toHaveLength(1)
    expect(leaks[0]).toMatchObject({
      contaminationGroupId: 'g1',
      splits: ['sealed_test', 'support'],
    })
  })

  it('reports every violation, not just the first', () => {
    // A corpus assembled without this check usually has several; returning one
    // at a time costs a full re-audit per round.
    const leaks = detectSplitLeakage([
      evalCase({ id: `evalcase_${'a'.repeat(24)}`, contaminationGroupId: 'g1', split: 'support' }),
      evalCase({ id: `evalcase_${'b'.repeat(24)}`, contaminationGroupId: 'g1', split: 'validation' }),
      evalCase({ id: `evalcase_${'c'.repeat(24)}`, contaminationGroupId: 'g2', split: 'support' }),
      evalCase({ id: `evalcase_${'d'.repeat(24)}`, contaminationGroupId: 'g2', split: 'canary' }),
    ])
    expect(leaks.map(l => l.contaminationGroupId)).toEqual(['g1', 'g2'])
  })

  it('does not flag several cases of one group inside one split', () => {
    expect(detectSplitLeakage([
      evalCase({ id: `evalcase_${'a'.repeat(24)}`, contaminationGroupId: 'g1', split: 'support' }),
      evalCase({ id: `evalcase_${'b'.repeat(24)}`, contaminationGroupId: 'g1', split: 'support' }),
    ])).toEqual([])
  })
})

describe('countReExecutableCases', () => {
  it('counts only cases that can actually be rerun', () => {
    // G1's abort condition counts these, not captured cases. A corpus of
    // unrestorable fragments must not clear the bar.
    expect(countReExecutableCases([
      evalCase({ id: `evalcase_${'a'.repeat(24)}`, environmentFidelity: 'restored' }),
      evalCase({ id: `evalcase_${'b'.repeat(24)}`, environmentFidelity: 'approximated' }),
      evalCase({ id: `evalcase_${'c'.repeat(24)}`, environmentFidelity: 'unrestorable', split: 'support' }),
      evalCase({ id: `evalcase_${'d'.repeat(24)}`, replayClass: 'non_replayable', split: 'support' }),
    ])).toBe(1)
  })
})

describe('EvalSetSchema', () => {
  it('accepts a well-formed set', () => {
    expect(() => EvalSetSchema.parse({
      schemaVersion: 'eval-set-1.0',
      id: 'evalset_first-batch',
      name: 'First batch',
      createdAt: 1,
      caseIds: [],
    })).not.toThrow()
  })

  it('rejects ids that could escape the store directory', () => {
    for (const id of ['evalset_../../x', '../evil', 'evalset_A', 'evalset_ab']) {
      expect(() => EvalSetSchema.parse({
        schemaVersion: 'eval-set-1.0', id, name: 'x', createdAt: 1, caseIds: [],
      })).toThrow()
    }
  })
})
