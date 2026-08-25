/**
 * Evaluator trust tiers (G0-B).
 *
 * The failure this prevents is specific and already came close to happening:
 * the trajectory item type is called `evaluation`, so it reads like a reward.
 * It is not. `auto_verify` is an LLM judge — its own rubric states it does not
 * run typecheck/test/lint (`VerifyJudge.ts`) — so it is a *process signal*.
 * Optimising against it directly is the textbook route to reward hacking:
 * judges are known to be swayed by surface patterns rather than correctness.
 *
 * "Independent evaluator" is also not one property. An evaluator can be
 * independent along five separate axes, and `auto_verify` only satisfies the
 * first:
 *
 *   context   — does not see the executor's reasoning
 *   process   — runs outside the executor's process
 *   artifact  — checks against artifacts the executor cannot write
 *   identity  — runs under a different principal/credentials
 *   governance— owned by a party the candidate cannot change
 *
 * Nothing consumes this registry yet. It exists so that when something does,
 * the tier is a fact in code rather than an assumption in a doc.
 */

/** Ordered weakest → strongest. Comparison relies on this order. */
export const EVALUATOR_TIERS = ['T0', 'T1', 'T2', 'T3'] as const

export type EvaluatorTier = (typeof EVALUATOR_TIERS)[number]

export interface EvaluatorIndependence {
  context: boolean
  process: boolean
  artifact: boolean
  identity: boolean
  governance: boolean
}

export interface EvaluatorProfile {
  /** Matches `evaluation.evaluator` in the trajectory, where one is written. */
  id: string
  tier: EvaluatorTier
  independence: EvaluatorIndependence
  /** Why this tier — kept next to the fact so it cannot silently drift. */
  rationale: string
}

const NO_INDEPENDENCE: EvaluatorIndependence = {
  context: false,
  process: false,
  artifact: false,
  identity: false,
  governance: false,
}

export const EVALUATOR_REGISTRY: readonly EvaluatorProfile[] = [
  {
    id: 'executor_self_report',
    tier: 'T0',
    independence: { ...NO_INDEPENDENCE },
    rationale:
      'A final assistant claim of completion, or run_result.outcome=success. ' +
      'Says the run ended without an internal error; says nothing about the user goal.',
  },
  {
    id: 'auto_verify',
    tier: 'T1',
    independence: { ...NO_INDEPENDENCE, context: true },
    rationale:
      'Isolated-context LLM judge over a read-only snapshot. Its rubric explicitly ' +
      'does not run typecheck/test/lint, and it shares the executor\'s provider and ' +
      'runtime management plane. Usable as critique and a weak process signal.',
  },
] as const

const BY_ID = new Map(EVALUATOR_REGISTRY.map(profile => [profile.id, profile]));

/** Unknown evaluators are T0, never a convenient default of "probably fine". */
export function evaluatorTier(evaluatorId: string): EvaluatorTier {
  return BY_ID.get(evaluatorId)?.tier ?? 'T0'
}

export function evaluatorProfile(evaluatorId: string): EvaluatorProfile | undefined {
  return BY_ID.get(evaluatorId)
}

export function isAtLeast(tier: EvaluatorTier, minimum: EvaluatorTier): boolean {
  return EVALUATOR_TIERS.indexOf(tier) >= EVALUATOR_TIERS.indexOf(minimum)
}

/** T2 is the floor for an automatic metric: a deterministic check in its own process. */
export const MINIMUM_AUTOMATIC_METRIC_TIER: EvaluatorTier = 'T2'

/** T3 is the floor for promotion: independent identity, artifacts and governance. */
export const MINIMUM_PROMOTION_TIER: EvaluatorTier = 'T3'

export function canDriveAutomaticMetric(evaluatorId: string): boolean {
  return isAtLeast(evaluatorTier(evaluatorId), MINIMUM_AUTOMATIC_METRIC_TIER)
}

export function canGatePromotion(evaluatorId: string): boolean {
  return isAtLeast(evaluatorTier(evaluatorId), MINIMUM_PROMOTION_TIER)
}

/**
 * Fail closed before a verdict is used as an optimisation target.
 *
 * Call this at the boundary of anything that turns verdicts into rewards,
 * fitness values or promotion thresholds. It throws rather than returning a
 * boolean because silently degrading to "use it anyway" is the exact failure
 * being prevented.
 */
export function assertRewardEligible(evaluatorId: string): void {
  const tier = evaluatorTier(evaluatorId)
  if (isAtLeast(tier, MINIMUM_AUTOMATIC_METRIC_TIER)) return
  const profile = evaluatorProfile(evaluatorId)
  throw new Error(
    `evaluator '${evaluatorId}' is ${tier}; ${MINIMUM_AUTOMATIC_METRIC_TIER} is the minimum for an ` +
    `optimisation target. ${profile?.rationale ?? 'Unregistered evaluators are treated as T0.'} ` +
    'Use it for critique, navigation or tie-breaking instead.',
  )
}
