/**
 * Paired comparison against docs/知识系统/评测指标与统计契约.md §3–§4.
 *
 * Two rules carry almost all of the value here, and both are about refusing to
 * claim more than the data supports:
 *
 *   §3.3  a non-significant result is `inconclusive`, never `equivalent`;
 *   §4    a candidate that makes more runs unresolvable must not benefit from
 *         those runs being dropped.
 *
 * The exact p-values are cross-checked against hand-computed binomial values,
 * because a statistics bug produces confident wrong numbers rather than errors.
 */
import { describe, expect, it } from 'vitest'
import { comparePaired, exactBinomialTwoSided, type ComparisonInput } from '../PairedComparison.js'
import type { CaseOutcome } from '../Metrics.js'

function ok(caseId: string): CaseOutcome {
  return { caseId, passedCriteria: 1, failedCriteria: 0, unresolvedCriteria: 0, claimedCompletion: true }
}
function bad(caseId: string): CaseOutcome {
  return { caseId, passedCriteria: 0, failedCriteria: 1, unresolvedCriteria: 0, claimedCompletion: true }
}
function unresolved(caseId: string): CaseOutcome {
  return { caseId, passedCriteria: 0, failedCriteria: 0, unresolvedCriteria: 1, claimedCompletion: true }
}

function compare(over: Partial<ComparisonInput>) {
  return comparePaired({
    incumbent: [], candidate: [], minimumDetectableEffect: 0.1, ...over,
  })
}

describe('exactBinomialTwoSided', () => {
  it.each([
    [10, 10, 2 * Math.pow(0.5, 10)],
    [9, 10, (2 * 11) / 1024],
    [5, 10, 1],
    [2, 2, 0.5],
    [0, 5, 2 * Math.pow(0.5, 5)],
  ])('k=%i n=%i matches the hand-computed value', (k, n, expected) => {
    expect(exactBinomialTwoSided(k, n)!).toBeCloseTo(expected, 12)
  })

  it('is symmetric in the direction of the difference', () => {
    expect(exactBinomialTwoSided(2, 10)).toBe(exactBinomialTwoSided(8, 10))
  })

  it('returns null with no discordant pairs to test', () => {
    expect(exactBinomialTwoSided(0, 0)).toBeNull()
  })
})

describe('§3.3 — "not significant" is never "equivalent"', () => {
  it('refuses to call a small agreeing sample equivalent', () => {
    // Ten pairs that all agree is not proof of equivalence: with n=10 the
    // interval is far too wide to exclude a difference worth acting on.
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`)
    const report = compare({
      incumbent: ids.map(ok),
      candidate: ids.map(ok),
      minimumDetectableEffect: 0.05,
    })

    expect(report.counts.bothSucceeded).toBe(10)
    expect(report.verdict).toBe('inconclusive')
    expect(report.rationale).toContain('NOT evidence of equivalence')
  })

  it('does call it equivalent once the interval actually fits inside ±MDE', () => {
    // Same perfect agreement, enough pairs for the interval to be tight.
    const ids = Array.from({ length: 200 }, (_, i) => `c${i}`)
    const report = compare({
      incumbent: ids.map(ok),
      candidate: ids.map(ok),
      minimumDetectableEffect: 0.05,
    })

    expect(report.verdict).toBe('equivalent')
    expect(report.rationale).toContain('equivalence result')
  })

  it('stays inconclusive when discordant pairs are too few to resolve', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`)
    const report = compare({
      incumbent: ids.map((id, i) => (i < 2 ? bad(id) : ok(id))),
      candidate: ids.map((id, i) => (i < 1 ? bad(id) : ok(id))),
      minimumDetectableEffect: 0.05,
    })
    expect(report.verdict).toBe('inconclusive')
    expect(report.pValue).toBeGreaterThan(0.05)
  })
})

describe('§3.2 — evidence comes from discordant pairs', () => {
  it('declares the candidate better on a clear one-sided split', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`)
    const report = compare({
      // Incumbent fails the first 10, candidate passes everything.
      incumbent: ids.map((id, i) => (i < 10 ? bad(id) : ok(id))),
      candidate: ids.map(ok),
    })

    expect(report.counts.candidateOnly).toBe(10)
    expect(report.counts.incumbentOnly).toBe(0)
    expect(report.verdict).toBe('candidate_better')
    expect(report.pValue!).toBeLessThan(0.05)
  })

  it('declares the incumbent better in the mirror case', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`)
    const report = compare({
      incumbent: ids.map(ok),
      candidate: ids.map((id, i) => (i < 10 ? bad(id) : ok(id))),
    })
    expect(report.verdict).toBe('incumbent_better')
  })

  it('ignores concordant pairs when weighing the difference', () => {
    // 100 cases where both agree add no evidence about which is better; the
    // verdict must rest on the 10 that disagree.
    const agree = Array.from({ length: 100 }, (_, i) => `same${i}`)
    const differ = Array.from({ length: 10 }, (_, i) => `diff${i}`)
    const report = compare({
      incumbent: [...agree.map(ok), ...differ.map(bad)],
      candidate: [...agree.map(ok), ...differ.map(ok)],
    })
    expect(report.counts.bothSucceeded).toBe(100)
    expect(report.verdict).toBe('candidate_better')
  })
})

describe('§4 — differential inconclusiveness voids the comparison', () => {
  it('refuses a verdict when the candidate produces far more unresolved runs', () => {
    // The attack: break the checks and the broken runs get dropped, leaving a
    // flattering subset behind.
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}`)
    const report = compare({
      incumbent: ids.map(bad),
      // Passes the 4 it resolves; the rest are unresolved and would be dropped.
      candidate: ids.map((id, i) => (i < 4 ? ok(id) : unresolved(id))),
      maxInconclusiveGap: 0.05,
    })

    expect(report.differentialInconclusiveness).toBe(true)
    expect(report.verdict).toBe('inconclusive')
    expect(report.rationale).toContain('would flatter whichever arm')
    // And crucially, no effect size is published for someone to quote.
    expect(report.effect).toBeNull()
  })

  it('permits the comparison when both arms are equally resolvable', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}`)
    const report = compare({
      incumbent: ids.map((id, i) => (i < 1 ? unresolved(id) : bad(id))),
      candidate: ids.map((id, i) => (i < 1 ? unresolved(id) : ok(id))),
      maxInconclusiveGap: 0.05,
    })
    expect(report.differentialInconclusiveness).toBe(false)
    expect(report.verdict).toBe('candidate_better')
  })

  it('drops a pair when either side is unresolved, penalising neither arm', () => {
    const report = compare({
      incumbent: [ok('a'), ok('b')],
      candidate: [ok('a'), unresolved('b')],
      maxInconclusiveGap: 1,
    })
    expect(report.counts.unpairable).toBe(1)
    expect(report.pairedCases).toBe(1)
  })
})

describe('degenerate inputs', () => {
  it('is inconclusive when no case appears in both arms', () => {
    const report = compare({ incumbent: [ok('a')], candidate: [ok('b')] })
    expect(report.verdict).toBe('inconclusive')
    expect(report.rationale).toContain('no case produced a verdict in both arms')
  })

  it('is inconclusive on empty input', () => {
    expect(compare({}).verdict).toBe('inconclusive')
  })

  it('always reports the discordant counts for the reader to check', () => {
    const ids = Array.from({ length: 6 }, (_, i) => `c${i}`)
    const report = compare({
      incumbent: ids.map((id, i) => (i < 3 ? bad(id) : ok(id))),
      candidate: ids.map(ok),
    })
    expect(report.counts.candidateOnly).toBe(3)
    expect(report.counts.incumbentOnly).toBe(0)
    expect(report.pairedCases).toBe(6)
  })
})
