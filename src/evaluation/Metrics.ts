/**
 * Metric computation (G1-10), implementing docs/知识系统/评测指标与统计契约.md.
 *
 * The contract document is authoritative for every numerator and denominator
 * here. The one thing worth repeating in code, because it is the rule most
 * easily lost in a refactor:
 *
 *   `insufficient_evidence` is never counted as `fail`, and never silently
 *   dropped without being reported.
 *
 * Counting it as a failure corrupts `false_success_precision`, whose
 * denominator is *claimed completions* — infrastructure noise in that
 * denominator makes the core safety counter-metric unreadable. Dropping it
 * silently opens the differential-inconclusiveness hole (see PairedComparison).
 */

import type { EvalRunReport } from './EvalRunner.js'

/** One case's outcome, reduced to what the metrics need. */
export interface CaseOutcome {
  caseId: string
  /** Task family, for the lower-tail cohort gate. */
  taskFamily?: string
  passedCriteria: number
  failedCriteria: number
  unresolvedCriteria: number
  /**
   * The candidate believed it had finished — `execute` exited 0.
   * The denominator of `false_success_precision`.
   */
  claimedCompletion: boolean
  costUsd?: number
  turns?: number
  safetyViolations?: number
}

export interface MetricSet {
  cases: number
  conclusiveCases: number

  criteriaPassRate: number | null
  criteriaUnresolvedRate: number
  caseSuccessRate: number | null
  caseInconclusiveRate: number

  claimedCompletions: number
  falseSuccesses: number
  /** false successes / claimed completions. Null when nothing was claimed. */
  falseSuccessPrecision: number | null
  /** false successes / all cases. Reported alongside, never instead. */
  falseSuccessPerCase: number

  /** Worst task-family cohort success rate. Null without family labels. */
  lowerTailSuccess: number | null
  lowerTailFamily?: string

  costUsdPerSuccess: number | null
  turnsPerSuccess: number | null
  safetyViolations: number

  /** Dimensions the contract defines but nothing can compute yet. */
  unmeasured: string[]
}

/**
 * Metrics the contract defines but which depend on inputs that do not exist.
 * Listed rather than reported as zero — the two call for opposite responses.
 */
const UNMEASURED_METRICS = [
  'preventable_correction_rate — needs human correction labels, which are not collected',
  'eligible_recovery_rate — needs a predefined incident catalogue; an unbounded denominator would reward causing more tool errors in order to recover from them',
  'required_escalation_rate — collected but deliberately never optimised; see contract §2.2',
]

/**
 * A case is conclusive when every criterion resolved AND at least one did.
 *
 * The second half is not pedantry. A run whose evaluator bundle failed to load
 * produces zero criteria of every kind; without the `> 0` clause that case
 * counts as conclusive-and-failed, turning an infrastructure fault into a
 * quality regression — the exact denominator error the metrics contract §1
 * forbids. Belt and braces with the runner's own fix, because these two layers
 * can be used independently.
 */
export function isConclusive(outcome: CaseOutcome): boolean {
  return outcome.unresolvedCriteria === 0 &&
    outcome.passedCriteria + outcome.failedCriteria > 0
}

/** A case succeeded when it is conclusive and nothing failed. */
export function isSuccess(outcome: CaseOutcome): boolean {
  return isConclusive(outcome) && outcome.failedCriteria === 0 && outcome.passedCriteria > 0
}

/**
 * A false success: the candidate said it was done and it was not.
 *
 * Restricted to conclusive cases — calling an unresolved run a false success
 * would assert knowledge the run explicitly failed to produce.
 */
export function isFalseSuccess(outcome: CaseOutcome): boolean {
  return outcome.claimedCompletion && isConclusive(outcome) && !isSuccess(outcome)
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-anchored false success (T3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One task judged by a person: what the agent claimed, and what was true.
 *
 * The check-based metrics above rest on an evaluator bundle, which is T2 at
 * best and does not exist yet for real tasks. This rests on `human_acceptance`,
 * the only T3 evidence in the system — and `MINIMUM_PROMOTION_TIER` is T3, so
 * this is currently the only false-success figure that could gate a promotion.
 */
export interface AcceptanceObservation {
  caseId: string
  /** The agent asserted it had finished. */
  agentClaimedSuccess: boolean
  /** The person said the work was actually delivered. */
  humanAcceptedAsDone: boolean
  /** The person could not judge, or the label no longer describes the case. */
  unusable: boolean
}

export interface AcceptanceMetrics {
  observations: number
  /** Rated, non-stale, and not `unclear`. */
  usable: number
  /** Excluded because the rater said `unclear` or the case moved on. */
  excluded: number
  claimedCompletions: number
  falseSuccesses: number
  /** false successes / claimed completions, judged by a person. */
  falseSuccessPrecision: number | null
  falseSuccessPerCase: number | null
  /** Delivered work the agent never claimed — the opposite error. */
  unclaimedSuccesses: number
}

/**
 * False success measured against human judgement rather than against checks.
 *
 * `unusable` observations are excluded from every numerator and denominator and
 * reported separately, for the same reason `insufficient_evidence` is: a case
 * nobody could judge is not evidence of either success or failure, and letting
 * it round either way corrupts the one dataset whose value is being ground
 * truth.
 */
export function computeAcceptanceMetrics(
  observations: readonly AcceptanceObservation[],
): AcceptanceMetrics {
  const usable = observations.filter(o => !o.unusable)
  const claimed = usable.filter(o => o.agentClaimedSuccess)
  const falseSuccesses = claimed.filter(o => !o.humanAcceptedAsDone).length
  // Work that was delivered without the agent saying so. Not a safety problem,
  // but it inflates precision if the two are not tracked together.
  const unclaimedSuccesses = usable.filter(o => !o.agentClaimedSuccess && o.humanAcceptedAsDone).length

  return {
    observations: observations.length,
    usable: usable.length,
    excluded: observations.length - usable.length,
    claimedCompletions: claimed.length,
    falseSuccesses,
    falseSuccessPrecision: claimed.length === 0 ? null : falseSuccesses / claimed.length,
    falseSuccessPerCase: usable.length === 0 ? null : falseSuccesses / usable.length,
    unclaimedSuccesses,
  }
}

/** Reduce a runner report to the metric input. */
export function toCaseOutcome(
  report: EvalRunReport,
  opts: { caseId?: string; taskFamily?: string; costUsd?: number; turns?: number } = {},
): CaseOutcome {
  const execute = report.phases.find(phase => phase.phase === 'execute')
  return {
    caseId: opts.caseId ?? report.caseRef,
    ...(opts.taskFamily !== undefined ? { taskFamily: opts.taskFamily } : {}),
    passedCriteria: report.checks.filter(c => c.verdict === 'pass').length,
    failedCriteria: report.checks.filter(c => c.verdict === 'fail').length,
    unresolvedCriteria: report.checks.filter(c => c.verdict === 'insufficient_evidence').length,
    // Exit 0 is the candidate asserting it finished. A candidate that never
    // exits 0 scores perfectly on precision, which is why the per-case rate is
    // always reported next to it.
    claimedCompletion: execute?.status === 'ok',
    ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
    ...(opts.turns !== undefined ? { turns: opts.turns } : {}),
  }
}

export function computeMetrics(outcomes: readonly CaseOutcome[]): MetricSet {
  const cases = outcomes.length
  const conclusive = outcomes.filter(isConclusive)
  const successes = outcomes.filter(isSuccess)

  const passed = sum(outcomes, o => o.passedCriteria)
  const failed = sum(outcomes, o => o.failedCriteria)
  const unresolved = sum(outcomes, o => o.unresolvedCriteria)
  const totalCriteria = passed + failed + unresolved
  const resolvedCriteria = passed + failed

  const claimed = outcomes.filter(o => o.claimedCompletion && isConclusive(o)).length
  const falseSuccesses = outcomes.filter(isFalseSuccess).length

  const { rate: lowerTailSuccess, family: lowerTailFamily } = lowerTail(outcomes)

  const costTotal = sum(outcomes, o => o.costUsd ?? 0)
  const turnsTotal = sum(outcomes, o => o.turns ?? 0)

  return {
    cases,
    conclusiveCases: conclusive.length,

    // Denominator is resolved criteria: including unresolved ones would let a
    // runner outage read as a quality regression.
    criteriaPassRate: resolvedCriteria === 0 ? null : passed / resolvedCriteria,
    criteriaUnresolvedRate: totalCriteria === 0 ? 0 : unresolved / totalCriteria,
    caseSuccessRate: conclusive.length === 0 ? null : successes.length / conclusive.length,
    // Reported prominently because the line above excludes these, and that
    // exclusion is only safe while this number is watched. See §4.
    caseInconclusiveRate: cases === 0 ? 0 : (cases - conclusive.length) / cases,

    claimedCompletions: claimed,
    falseSuccesses,
    falseSuccessPrecision: claimed === 0 ? null : falseSuccesses / claimed,
    falseSuccessPerCase: cases === 0 ? 0 : falseSuccesses / cases,

    lowerTailSuccess,
    ...(lowerTailFamily !== undefined ? { lowerTailFamily } : {}),

    // Constraints, not objectives. Null rather than 0 when there are no
    // successes: dividing by zero successes is undefined, and reporting 0 would
    // read as "free", the most flattering possible misreading.
    costUsdPerSuccess: successes.length === 0 || costTotal === 0 ? null : costTotal / successes.length,
    turnsPerSuccess: successes.length === 0 || turnsTotal === 0 ? null : turnsTotal / successes.length,
    safetyViolations: sum(outcomes, o => o.safetyViolations ?? 0),

    unmeasured: UNMEASURED_METRICS,
  }
}

/**
 * Worst-performing task family.
 *
 * A hard gate rather than an average, because an aggregate improvement that
 * comes with a collapse in one cohort is not an improvement — it is a
 * redistribution, and the cohort that collapsed is somebody's whole workload.
 */
function lowerTail(
  outcomes: readonly CaseOutcome[],
): { rate: number | null; family?: string } {
  const families = new Map<string, CaseOutcome[]>()
  for (const outcome of outcomes) {
    if (outcome.taskFamily === undefined) continue
    const list = families.get(outcome.taskFamily) ?? []
    list.push(outcome)
    families.set(outcome.taskFamily, list)
  }
  if (families.size === 0) return { rate: null }

  let worstRate = Infinity
  let worstFamily: string | undefined
  for (const [family, list] of [...families.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const conclusive = list.filter(isConclusive)
    if (conclusive.length === 0) continue
    const rate = conclusive.filter(isSuccess).length / conclusive.length
    if (rate < worstRate) {
      worstRate = rate
      worstFamily = family
    }
  }

  return worstFamily === undefined
    ? { rate: null }
    : { rate: worstRate, family: worstFamily }
}

/**
 * Repeat pass rate: cases whose every repetition succeeded.
 *
 * Repeats are observations of one sample, not extra samples — this feeds
 * variance and flakiness, never the sample size of a comparison.
 */
export function computeRepeatPassRate(
  repeats: ReadonlyMap<string, readonly CaseOutcome[]>,
  requiredRepeats: number,
): number | null {
  const eligible = [...repeats.values()].filter(runs => runs.length >= requiredRepeats)
  if (eligible.length === 0) return null
  const allPassed = eligible.filter(runs => runs.every(isSuccess)).length
  return allPassed / eligible.length
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0)
}
