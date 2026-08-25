/**
 * G0 contracts. Both suites pin fail-closed behaviour, because in each case the
 * dangerous direction is the permissive one:
 *
 *   - an unregistered evaluator quietly becoming a reward;
 *   - an unmarked trajectory quietly entering an evaluation set.
 */
import { describe, expect, it } from 'vitest'
import {
  DataEligibilitySchema,
  EVALUATOR_REGISTRY,
  assertEligible,
  assertRewardEligible,
  canDriveAutomaticMetric,
  canGatePromotion,
  checkEligibility,
  evaluatorProfile,
  evaluatorTier,
  isAtLeast,
  type DataEligibility,
} from '../index.js'

describe('evaluator trust tiers', () => {
  it('pins auto_verify at T1 — it is a judge, not a reward', () => {
    // The rubric in VerifyJudge explicitly does not run typecheck/test/lint.
    // If this ever reads T2, someone has quietly promoted an LLM opinion.
    expect(evaluatorTier('auto_verify')).toBe('T1')
    expect(canDriveAutomaticMetric('auto_verify')).toBe(false)
    expect(canGatePromotion('auto_verify')).toBe(false)
  })

  it('credits auto_verify with context isolation and nothing more', () => {
    expect(evaluatorProfile('auto_verify')?.independence).toEqual({
      context: true,
      process: false,
      artifact: false,
      identity: false,
      governance: false,
    })
  })

  it('treats an unregistered evaluator as T0 rather than assuming it is fine', () => {
    expect(evaluatorTier('some_new_judge')).toBe('T0')
    expect(evaluatorProfile('some_new_judge')).toBeUndefined()
    expect(canDriveAutomaticMetric('some_new_judge')).toBe(false)
  })

  it('refuses to let a sub-T2 verdict become an optimisation target', () => {
    expect(() => assertRewardEligible('auto_verify')).toThrow(/T1.*minimum for an optimisation target/s)
    expect(() => assertRewardEligible('executor_self_report')).toThrow(/T0/)
    expect(() => assertRewardEligible('unknown_evaluator')).toThrow(/Unregistered/)
  })

  it('explains itself when it refuses', () => {
    // An operator hitting this needs to know what to do instead.
    expect(() => assertRewardEligible('auto_verify')).toThrow(/critique, navigation or tie-breaking/)
  })

  it('orders tiers so comparisons mean what they read like', () => {
    expect(isAtLeast('T3', 'T2')).toBe(true)
    expect(isAtLeast('T2', 'T2')).toBe(true)
    expect(isAtLeast('T1', 'T2')).toBe(false)
  })

  it('keeps a rationale on every registered evaluator', () => {
    for (const profile of EVALUATOR_REGISTRY) {
      expect(profile.rationale.length, profile.id).toBeGreaterThan(20)
    }
  })
})

function eligibility(overrides: Partial<DataEligibility> = {}): DataEligibility {
  return DataEligibilitySchema.parse({
    schemaVersion: 'data-eligibility-1.0',
    subjectRef: 'case_0123456789abcdef01234567',
    trainingEligibility: 'workspace',
    workspaceId: 'ws-1',
    allowedUses: ['audit', 'analysis', 'evaluation'],
    crossWorkspace: false,
    decidedAt: 1_000,
    ...overrides,
  })
}

describe('data eligibility', () => {
  it('denies when no decision was ever recorded', () => {
    expect(checkEligibility(null, { use: 'evaluation' })).toMatchObject({ allowed: false })
    expect(checkEligibility(undefined, { use: 'evaluation' }).reason).toMatch(/no eligibility decision/)
  })

  it('allows a recorded use inside its own workspace', () => {
    expect(checkEligibility(eligibility(), { use: 'evaluation', targetWorkspaceId: 'ws-1' }))
      .toEqual({ allowed: true })
  })

  it('denies a use that was not granted', () => {
    const decision = checkEligibility(eligibility(), { use: 'training' })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/use 'training' is not in the allowed uses/)
  })

  it('denies anything marked denied regardless of allowed uses', () => {
    const record = eligibility({ trainingEligibility: 'denied', allowedUses: ['evaluation', 'training'] })
    expect(checkEligibility(record, { use: 'evaluation' }).allowed).toBe(false)
  })

  it('denies after retention expires', () => {
    const record = eligibility({ retentionUntil: 5_000 })
    expect(checkEligibility(record, { use: 'evaluation', now: 4_999 }).allowed).toBe(true)
    expect(checkEligibility(record, { use: 'evaluation', now: 5_001 }).allowed).toBe(false)
  })

  it('keeps workspace-scoped data inside its workspace', () => {
    for (const level of ['local_only', 'workspace'] as const) {
      const decision = checkEligibility(
        eligibility({ trainingEligibility: level }),
        { use: 'evaluation', targetWorkspaceId: 'ws-2' },
      )
      expect(decision.allowed, level).toBe(false)
      expect(decision.reason, level).toMatch(/cannot leave workspace/)
    }
  })

  it('requires a named approver to cross a workspace boundary', () => {
    const unapproved = eligibility({ trainingEligibility: 'aggregate', crossWorkspace: false })
    expect(checkEligibility(unapproved, { use: 'evaluation', targetWorkspaceId: 'ws-2' }).reason)
      .toMatch(/was not approved/)

    const approved = eligibility({
      trainingEligibility: 'aggregate',
      crossWorkspace: { approvedBy: 'micah', approvedAt: 900 },
    })
    expect(checkEligibility(approved, { use: 'evaluation', targetWorkspaceId: 'ws-2' }).allowed).toBe(true)
  })

  it('rejects an approval record without an approver', () => {
    expect(DataEligibilitySchema.safeParse({
      schemaVersion: 'data-eligibility-1.0',
      subjectRef: 'case_0123456789abcdef01234567',
      trainingEligibility: 'aggregate',
      allowedUses: ['evaluation'],
      crossWorkspace: { approvedAt: 900 },
      decidedAt: 1_000,
    }).success).toBe(false)
  })

  it('rejects unknown fields so a decision cannot carry unreviewed semantics', () => {
    expect(DataEligibilitySchema.safeParse({
      ...eligibility(),
      alsoAllowTraining: true,
    }).success).toBe(false)
  })

  it('throws with the reason at a boundary that must not continue', () => {
    expect(() => assertEligible(null, { use: 'evaluation' }))
      .toThrow(/data eligibility denied: no eligibility decision/)
  })
})
