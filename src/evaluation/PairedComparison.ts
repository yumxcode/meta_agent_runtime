/**
 * Paired comparison (G1-10), implementing docs/知识系统/评测指标与统计契约.md §3.
 *
 * Incumbent and candidate run the same cases, so the comparison is paired and
 * the evidence lives entirely in the discordant pairs. Two rules from the
 * contract are enforced here rather than left to the reader:
 *
 *   §3.3  `equivalent` may only come from an equivalence test. A non-significant
 *         difference is `inconclusive`, never `equivalent`. Treating "we did not
 *         detect a difference" as "there is no difference" is the single most
 *         common way an underpowered comparison licenses a bad decision.
 *
 *   §4    A candidate that makes more runs unresolvable would look better if
 *         unresolved runs were simply dropped. Since they *are* dropped from
 *         the success denominator, the drop has to be guarded: if the two arms
 *         differ in inconclusiveness beyond a pre-registered tolerance, the
 *         whole comparison is void.
 *
 * `inconclusive` is expected to be the common outcome at this corpus size. It
 * is a valid result, not a failure of the machinery.
 */

import { isConclusive, isSuccess, type CaseOutcome } from './Metrics.js'

export type ComparisonVerdict =
  | 'candidate_better'
  | 'incumbent_better'
  | 'equivalent'
  | 'inconclusive'

export interface PairedCounts {
  /** Both succeeded. Carries no information about the difference. */
  bothSucceeded: number
  /** Incumbent succeeded, candidate did not. */
  incumbentOnly: number
  /** Candidate succeeded, incumbent did not. */
  candidateOnly: number
  /** Neither succeeded. Carries no information about the difference. */
  neitherSucceeded: number
  /** Pairs dropped because at least one arm was unresolved. */
  unpairable: number
}

export interface ComparisonInput {
  incumbent: readonly CaseOutcome[]
  candidate: readonly CaseOutcome[]
  /** Smallest difference worth acting on. Required — see contract §3.5. */
  minimumDetectableEffect: number
  /** Two-sided significance level. Default 0.05. */
  alpha?: number
  /**
   * Largest tolerable gap between the arms' inconclusive rates before the
   * comparison is void. Default 0.05.
   */
  maxInconclusiveGap?: number
}

export interface ComparisonReport {
  verdict: ComparisonVerdict
  /** Why, in one line, suitable for showing to whoever must act on it. */
  rationale: string
  counts: PairedCounts
  /** candidate success rate − incumbent success rate, over paired cases. */
  effect: number | null
  confidenceIntervalLow: number | null
  confidenceIntervalHigh: number | null
  /** Two-sided exact p-value from the discordant pairs. */
  pValue: number | null
  pairedCases: number
  incumbentInconclusiveRate: number
  candidateInconclusiveRate: number
  /** True when the arms differ too much in inconclusiveness to compare. */
  differentialInconclusiveness: boolean
}

export function comparePaired(input: ComparisonInput): ComparisonReport {
  const alpha = input.alpha ?? 0.05
  const maxGap = input.maxInconclusiveGap ?? 0.05

  const incumbentById = new Map(input.incumbent.map(o => [o.caseId, o]))
  const candidateById = new Map(input.candidate.map(o => [o.caseId, o]))
  const caseIds = [...incumbentById.keys()].filter(id => candidateById.has(id)).sort()

  const counts: PairedCounts = {
    bothSucceeded: 0,
    incumbentOnly: 0,
    candidateOnly: 0,
    neitherSucceeded: 0,
    unpairable: 0,
  }

  for (const id of caseIds) {
    const a = incumbentById.get(id)!
    const b = candidateById.get(id)!
    // A pair is only usable when both arms produced a verdict. One unresolved
    // side makes the pair uninformative, not a loss for either arm.
    if (!isConclusive(a) || !isConclusive(b)) {
      counts.unpairable += 1
      continue
    }
    const aOk = isSuccess(a)
    const bOk = isSuccess(b)
    if (aOk && bOk) counts.bothSucceeded += 1
    else if (aOk && !bOk) counts.incumbentOnly += 1
    else if (!aOk && bOk) counts.candidateOnly += 1
    else counts.neitherSucceeded += 1
  }

  const incumbentInconclusiveRate = inconclusiveRate(input.incumbent)
  const candidateInconclusiveRate = inconclusiveRate(input.candidate)
  const gap = Math.abs(candidateInconclusiveRate - incumbentInconclusiveRate)
  const differentialInconclusiveness = gap > maxGap

  const paired = counts.bothSucceeded + counts.incumbentOnly +
    counts.candidateOnly + counts.neitherSucceeded

  const base: Omit<ComparisonReport, 'verdict' | 'rationale'> = {
    counts,
    effect: paired === 0 ? null : (counts.candidateOnly - counts.incumbentOnly) / paired,
    confidenceIntervalLow: null,
    confidenceIntervalHigh: null,
    pValue: null,
    pairedCases: paired,
    incumbentInconclusiveRate,
    candidateInconclusiveRate,
    differentialInconclusiveness,
  }

  // Guard first: an effect size computed across arms with different
  // inconclusiveness is measuring the exclusion, not the change.
  if (differentialInconclusiveness) {
    return {
      ...base,
      effect: null,
      verdict: 'inconclusive',
      rationale:
        `arms differ in inconclusive rate by ${(gap * 100).toFixed(1)}% ` +
        `(incumbent ${(incumbentInconclusiveRate * 100).toFixed(1)}%, ` +
        `candidate ${(candidateInconclusiveRate * 100).toFixed(1)}%), ` +
        `above the ${(maxGap * 100).toFixed(1)}% tolerance; dropping unresolved runs would ` +
        'flatter whichever arm produced more of them',
    }
  }

  if (paired === 0) {
    return {
      ...base,
      verdict: 'inconclusive',
      rationale: 'no case produced a verdict in both arms',
    }
  }

  const discordant = counts.incumbentOnly + counts.candidateOnly
  const pValue = exactBinomialTwoSided(counts.candidateOnly, discordant)
  const interval = wilsonDifferenceInterval(counts, paired, alpha)

  const report: Omit<ComparisonReport, 'verdict' | 'rationale'> = {
    ...base,
    pValue,
    confidenceIntervalLow: interval.low,
    confidenceIntervalHigh: interval.high,
  }

  if (discordant === 0) {
    // Every pair agreed. That is not evidence of equivalence unless the
    // interval is tight enough to exclude a difference worth acting on.
    return equivalenceOrInconclusive(report, input.minimumDetectableEffect,
      'every paired case agreed')
  }

  if (pValue !== null && pValue < alpha) {
    const candidateWins = counts.candidateOnly > counts.incumbentOnly
    return {
      ...report,
      verdict: candidateWins ? 'candidate_better' : 'incumbent_better',
      rationale:
        `${discordant} discordant pairs (candidate-only ${counts.candidateOnly}, ` +
        `incumbent-only ${counts.incumbentOnly}), exact p=${pValue.toFixed(4)} < ${alpha}`,
    }
  }

  return equivalenceOrInconclusive(report, input.minimumDetectableEffect,
    `exact p=${pValue?.toFixed(4) ?? 'n/a'} does not clear ${alpha}`)
}

/**
 * The §3.3 rule, in one place.
 *
 * `equivalent` requires the whole confidence interval to sit inside ±MDE. Any
 * other non-significant result is `inconclusive`, and the rationale says which
 * of the two it is so nobody has to guess.
 */
function equivalenceOrInconclusive(
  report: Omit<ComparisonReport, 'verdict' | 'rationale'>,
  mde: number,
  because: string,
): ComparisonReport {
  const { confidenceIntervalLow: low, confidenceIntervalHigh: high } = report
  const equivalent = low !== null && high !== null && low > -mde && high < mde

  return equivalent
    ? {
        ...report,
        verdict: 'equivalent',
        rationale:
          `${because}; the ${((1 - 0.05) * 100).toFixed(0)}% interval ` +
          `[${low!.toFixed(3)}, ${high!.toFixed(3)}] lies inside ±${mde}, ` +
          'which is an equivalence result rather than an absence of evidence',
      }
    : {
        ...report,
        verdict: 'inconclusive',
        rationale:
          `${because}; the interval ` +
          `[${low?.toFixed(3) ?? '?'}, ${high?.toFixed(3) ?? '?'}] is not contained in ` +
          `±${mde}, so this is an absence of evidence, NOT evidence of equivalence`,
      }
}

function inconclusiveRate(outcomes: readonly CaseOutcome[]): number {
  if (outcomes.length === 0) return 0
  return outcomes.filter(o => !isConclusive(o)).length / outcomes.length
}

/**
 * Two-sided exact binomial test on the discordant pairs (McNemar exact).
 *
 * Exact rather than the chi-square approximation because at a few dozen cases
 * the approximation is not valid, and this is precisely the regime the corpus
 * survey says we are in.
 */
export function exactBinomialTwoSided(successes: number, trials: number): number | null {
  if (trials <= 0) return null
  const observed = binomialPmf(successes, trials)
  // Sum the probability of every outcome no more likely than the observed one —
  // the standard construction of an exact two-sided p-value.
  let p = 0
  const tolerance = 1e-12
  for (let k = 0; k <= trials; k++) {
    const pk = binomialPmf(k, trials)
    if (pk <= observed + tolerance) p += pk
  }
  return Math.min(1, p)
}

function binomialPmf(k: number, n: number): number {
  // p = 0.5, so the pmf is C(n,k) / 2^n. Computed in log space to stay stable
  // for larger n.
  return Math.exp(logChoose(n, k) - n * Math.LN2)
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k)
}

const logFactorialCache = [0, 0]
function logFactorial(n: number): number {
  if (n < 2) return 0
  for (let i = logFactorialCache.length; i <= n; i++) {
    logFactorialCache[i] = logFactorialCache[i - 1]! + Math.log(i)
  }
  return logFactorialCache[n]!
}

/**
 * Confidence interval for the paired difference in proportions.
 *
 * Uses a Wilson-style interval on the discordant proportion, mapped back to the
 * difference scale. Chosen over the normal approximation because it does not
 * collapse to a zero-width interval when the discordant count is 0 — that
 * collapse is what would otherwise let "every pair agreed" masquerade as proof
 * of equivalence at any sample size.
 */
export function wilsonDifferenceInterval(
  counts: PairedCounts,
  paired: number,
  alpha: number,
): { low: number; high: number } {
  const discordant = counts.incumbentOnly + counts.candidateOnly
  if (paired === 0) return { low: -1, high: 1 }

  const z = zForTwoSided(alpha)

  if (discordant === 0) {
    // No discordant pairs: the point estimate is 0, but the uncertainty is
    // governed by how many pairs we saw at all. The rule of three gives the
    // upper bound on an unobserved event rate.
    const bound = Math.min(1, 3 / paired)
    return { low: -bound, high: bound }
  }

  // Wilson interval for p = candidateOnly / discordant.
  const n = discordant
  const phat = counts.candidateOnly / n
  const denom = 1 + (z * z) / n
  const centre = (phat + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom

  // Map [p_low, p_high] on the discordant scale back to the difference scale:
  // difference = (2p − 1) × (discordant / paired).
  const scale = n / paired
  return {
    low: (2 * Math.max(0, centre - half) - 1) * scale,
    high: (2 * Math.min(1, centre + half) - 1) * scale,
  }
}

function zForTwoSided(alpha: number): number {
  // Standard critical values; the contract only ever uses 0.05 / 0.01 / 0.10,
  // so a table beats shipping an inverse-normal implementation nobody reviews.
  if (alpha <= 0.01) return 2.5758
  if (alpha <= 0.05) return 1.9600
  if (alpha <= 0.10) return 1.6449
  return 1.2816
}
