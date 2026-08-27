/**
 * Metric computation against docs/知识系统/评测指标与统计契约.md.
 *
 * The contract exists because the dangerous evaluation bugs are not arithmetic
 * errors — they are correct arithmetic over the wrong denominator, and they
 * produce numbers that look entirely normal. So most of these tests are about
 * where `insufficient_evidence` goes, and about the pairs of metrics that are
 * only safe when reported together.
 */
import { describe, expect, it } from 'vitest'
import {
  computeMetrics,
  computeRepeatPassRate,
  toCaseOutcome,
  isFalseSuccess,
  type CaseOutcome,
} from '../Metrics.js'
import type { EvalRunReport } from '../EvalRunner.js'

function outcome(overrides: Partial<CaseOutcome> = {}): CaseOutcome {
  return {
    caseId: 'case-1',
    passedCriteria: 1,
    failedCriteria: 0,
    unresolvedCriteria: 0,
    claimedCompletion: true,
    ...overrides,
  }
}

describe('insufficient_evidence is neither a failure nor invisible', () => {
  it('keeps unresolved criteria out of the pass-rate denominator', () => {
    // Including them would make a runner outage read as a quality regression.
    const metrics = computeMetrics([
      outcome({ caseId: 'a', passedCriteria: 1 }),
      outcome({ caseId: 'b', passedCriteria: 0, unresolvedCriteria: 1 }),
    ])
    expect(metrics.criteriaPassRate).toBe(1)
    expect(metrics.criteriaUnresolvedRate).toBe(0.5)
  })

  it('excludes unresolved cases from the success denominator but reports them', () => {
    // The exclusion is only safe while this rate is watched — see contract §4.
    const metrics = computeMetrics([
      outcome({ caseId: 'a' }),
      outcome({ caseId: 'b', passedCriteria: 0, failedCriteria: 1 }),
      outcome({ caseId: 'c', passedCriteria: 0, unresolvedCriteria: 1 }),
    ])
    expect(metrics.caseSuccessRate).toBe(0.5)
    expect(metrics.conclusiveCases).toBe(2)
    expect(metrics.caseInconclusiveRate).toBeCloseTo(1 / 3, 6)
  })

  it('never counts an unresolved case as a false success', () => {
    // Calling it one would assert knowledge the run explicitly failed to produce.
    expect(isFalseSuccess(outcome({
      claimedCompletion: true, passedCriteria: 0, unresolvedCriteria: 1,
    }))).toBe(false)
  })

  it('returns null rather than zero when nothing is measurable', () => {
    const metrics = computeMetrics([])
    expect(metrics.criteriaPassRate).toBeNull()
    expect(metrics.caseSuccessRate).toBeNull()
    expect(metrics.falseSuccessPrecision).toBeNull()
  })
})

describe('the two false-success denominators', () => {
  it('computes precision over claimed completions', () => {
    // The candidate said it was done and it was not — the only metric that
    // catches confident delivery of a wrong result.
    const metrics = computeMetrics([
      outcome({ caseId: 'a', claimedCompletion: true, passedCriteria: 0, failedCriteria: 1 }),
      outcome({ caseId: 'b', claimedCompletion: true }),
      outcome({ caseId: 'c', claimedCompletion: false, passedCriteria: 0, failedCriteria: 1 }),
    ])
    expect(metrics.claimedCompletions).toBe(2)
    expect(metrics.falseSuccesses).toBe(1)
    expect(metrics.falseSuccessPrecision).toBe(0.5)
  })

  it('reports the per-case rate alongside, because precision alone is gameable', () => {
    // An agent that never claims completion scores perfectly on precision.
    const never = computeMetrics([
      outcome({ caseId: 'a', claimedCompletion: false, passedCriteria: 0, failedCriteria: 1 }),
      outcome({ caseId: 'b', claimedCompletion: false, passedCriteria: 0, failedCriteria: 1 }),
    ])
    expect(never.falseSuccessPrecision).toBeNull()
    expect(never.falseSuccessPerCase).toBe(0)
    // …but it is failing everything, which the success rate does show.
    expect(never.caseSuccessRate).toBe(0)
  })
})

describe('lower-tail cohort gate', () => {
  it('reports the worst task family, not the average', () => {
    // An aggregate gain that collapses one cohort is a redistribution, and the
    // collapsed cohort is somebody's entire workload.
    const metrics = computeMetrics([
      outcome({ caseId: 'a', taskFamily: 'refactor' }),
      outcome({ caseId: 'b', taskFamily: 'refactor' }),
      outcome({ caseId: 'c', taskFamily: 'migration', passedCriteria: 0, failedCriteria: 1 }),
      outcome({ caseId: 'd', taskFamily: 'migration', passedCriteria: 0, failedCriteria: 1 }),
    ])
    expect(metrics.caseSuccessRate).toBe(0.5)
    expect(metrics.lowerTailSuccess).toBe(0)
    expect(metrics.lowerTailFamily).toBe('migration')
  })

  it('returns null when no case carries a family label', () => {
    expect(computeMetrics([outcome()]).lowerTailSuccess).toBeNull()
  })
})

describe('cost and turns are constraints, not objectives', () => {
  it('reports null rather than zero when there are no successes', () => {
    // Zero would read as "free", the most flattering possible misreading.
    const metrics = computeMetrics([
      outcome({ passedCriteria: 0, failedCriteria: 1, costUsd: 5, turns: 20 }),
    ])
    expect(metrics.costUsdPerSuccess).toBeNull()
    expect(metrics.turnsPerSuccess).toBeNull()
  })

  it('divides by successes, not by cases', () => {
    const metrics = computeMetrics([
      outcome({ caseId: 'a', costUsd: 3, turns: 10 }),
      outcome({ caseId: 'b', costUsd: 3, turns: 10, passedCriteria: 0, failedCriteria: 1 }),
    ])
    expect(metrics.costUsdPerSuccess).toBe(6)
    expect(metrics.turnsPerSuccess).toBe(20)
  })
})

describe('repeat pass rate', () => {
  it('counts cases whose every repetition succeeded', () => {
    const repeats = new Map([
      ['a', [outcome(), outcome(), outcome()]],
      ['b', [outcome(), outcome({ passedCriteria: 0, failedCriteria: 1 }), outcome()]],
    ])
    expect(computeRepeatPassRate(repeats, 3)).toBe(0.5)
  })

  it('ignores cases without enough repetitions', () => {
    const repeats = new Map([['a', [outcome(), outcome()]]])
    expect(computeRepeatPassRate(repeats, 3)).toBeNull()
  })
})

describe('toCaseOutcome — reading a runner report', () => {
  function report(overrides: Partial<EvalRunReport> = {}): EvalRunReport {
    return {
      caseRef: 'case-1',
      startedAt: 0,
      finishedAt: 1,
      phases: [{ phase: 'execute', status: 'ok', durationMs: 1 }],
      checks: [
        { checkId: 'c1', statement: 's', verdict: 'pass', durationMs: 1 },
        { checkId: 'c2', statement: 's', verdict: 'fail', durationMs: 1 },
      ],
      succeeded: false,
      inconclusive: false,
      bundleTampered: false,
      isolation: {
        bundleOutsideWorkspace: true, bundleHashVerified: true,
        verifyEnvPolicy: 'empty', verifyCwdIsBundle: true,
        processGroupKill: true, osSandbox: false, notInForce: [],
      },
      cleanedUp: true,
      ...overrides,
    }
  }

  it('reads claimed completion from the execute exit status', () => {
    expect(toCaseOutcome(report()).claimedCompletion).toBe(true)
    expect(toCaseOutcome(report({
      phases: [{ phase: 'execute', status: 'failed', durationMs: 1, exitCode: 1 }],
    })).claimedCompletion).toBe(false)
  })

  it('does not treat a timed-out candidate as claiming completion', () => {
    expect(toCaseOutcome(report({
      phases: [{ phase: 'execute', status: 'timed_out', durationMs: 1 }],
    })).claimedCompletion).toBe(false)
  })

  it('carries the three verdicts across separately', () => {
    const out = toCaseOutcome(report({
      checks: [
        { checkId: 'a', statement: 's', verdict: 'pass', durationMs: 1 },
        { checkId: 'b', statement: 's', verdict: 'fail', durationMs: 1 },
        { checkId: 'c', statement: 's', verdict: 'insufficient_evidence', durationMs: 1 },
      ],
    }))
    expect(out).toMatchObject({ passedCriteria: 1, failedCriteria: 1, unresolvedCriteria: 1 })
  })
})

describe('unmeasured metrics are listed, not zeroed', () => {
  it('names the metrics the contract defines but nothing can compute', () => {
    const text = computeMetrics([outcome()]).unmeasured.join(' ')
    expect(text).toContain('preventable_correction_rate')
    expect(text).toContain('eligible_recovery_rate')
    // The reason matters as much as the name: an unbounded recovery denominator
    // would reward causing errors in order to recover from them.
    expect(text).toContain('reward causing more tool errors')
  })
})
