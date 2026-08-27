/**
 * False success measured against human judgement (T3).
 *
 * The check-based metrics rest on an evaluator bundle — T2 at best, and one
 * that does not exist for real tasks yet. This rests on `human_acceptance`,
 * which is T3, and `MINIMUM_PROMOTION_TIER` is T3. So for the moment this is
 * the only false-success figure in the system that could legitimately gate a
 * promotion, and its exclusion rules matter more than its arithmetic.
 */
import { describe, expect, it } from 'vitest'
import { computeAcceptanceMetrics, type AcceptanceObservation } from '../Metrics.js'

function observation(overrides: Partial<AcceptanceObservation> = {}): AcceptanceObservation {
  return {
    caseId: 'case-1',
    agentClaimedSuccess: true,
    humanAcceptedAsDone: true,
    unusable: false,
    ...overrides,
  }
}

describe('computeAcceptanceMetrics', () => {
  it('counts a claimed-but-not-delivered task as a false success', () => {
    // The failure mode this whole metric exists for: the agent said it was
    // done, confidently, and it was not.
    const metrics = computeAcceptanceMetrics([
      observation({ caseId: 'a', agentClaimedSuccess: true, humanAcceptedAsDone: false }),
      observation({ caseId: 'b' }),
    ])
    expect(metrics.falseSuccesses).toBe(1)
    expect(metrics.claimedCompletions).toBe(2)
    expect(metrics.falseSuccessPrecision).toBe(0.5)
    expect(metrics.falseSuccessPerCase).toBe(0.5)
  })

  it('excludes unusable observations from every numerator and denominator', () => {
    // `unclear`, or a label that went stale. Neither is evidence of success or
    // of failure, and rounding it either way corrupts the one dataset whose
    // entire value is being ground truth.
    const metrics = computeAcceptanceMetrics([
      observation({ caseId: 'a', humanAcceptedAsDone: false }),
      observation({ caseId: 'b', unusable: true }),
      observation({ caseId: 'c', unusable: true, humanAcceptedAsDone: false }),
    ])
    expect(metrics.observations).toBe(3)
    expect(metrics.usable).toBe(1)
    expect(metrics.excluded).toBe(2)
    expect(metrics.claimedCompletions).toBe(1)
    expect(metrics.falseSuccessPrecision).toBe(1)
  })

  it('reports the excluded count so the exclusion stays visible', () => {
    const metrics = computeAcceptanceMetrics([observation({ unusable: true })])
    expect(metrics.excluded).toBe(1)
    expect(metrics.falseSuccessPrecision).toBeNull()
  })

  it('does not count work the agent never claimed as a false success', () => {
    // Not claiming and not delivering is a normal failure, not a false success.
    const metrics = computeAcceptanceMetrics([
      observation({ agentClaimedSuccess: false, humanAcceptedAsDone: false }),
    ])
    expect(metrics.falseSuccesses).toBe(0)
    expect(metrics.claimedCompletions).toBe(0)
    expect(metrics.falseSuccessPrecision).toBeNull()
  })

  it('tracks delivered-but-unclaimed work as its own quantity', () => {
    // The opposite error. Harmless for safety, but it inflates precision if the
    // two are not watched together — an agent that simply stops claiming
    // completion would otherwise look like it had improved.
    const metrics = computeAcceptanceMetrics([
      observation({ agentClaimedSuccess: false, humanAcceptedAsDone: true }),
    ])
    expect(metrics.unclaimedSuccesses).toBe(1)
    expect(metrics.falseSuccesses).toBe(0)
  })

  it('returns null rather than zero when nothing was claimed', () => {
    // Zero would read as a perfect score.
    const metrics = computeAcceptanceMetrics([])
    expect(metrics.falseSuccessPrecision).toBeNull()
    expect(metrics.falseSuccessPerCase).toBeNull()
  })

  it('treats "completed with concerns" as delivered, per the vocabulary', () => {
    // The caller maps the verdict; this pins that a delivered-with-concerns
    // task is not counted as a false success.
    const metrics = computeAcceptanceMetrics([
      observation({ agentClaimedSuccess: true, humanAcceptedAsDone: true }),
    ])
    expect(metrics.falseSuccesses).toBe(0)
  })
})
