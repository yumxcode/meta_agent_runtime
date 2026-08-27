/**
 * EvalCase / EvalSet contracts (G1-3).
 *
 * `ExperimentRunManifest` (G0-8) already describes *a comparison*. These two
 * describe *what is compared over*: the frozen case, and the partitioned set it
 * belongs to.
 *
 * Three rules are enforced in the schema rather than in review comments,
 * because all three fail silently and only surface much later as a number
 * nobody can defend:
 *
 *   1. A case whose starting state cannot be restored may only sit in
 *      `support`. Re-executing from an unrestorable state means starting
 *      somewhere the original task never was.
 *   2. A case whose success criteria were written by the Reviewer *after
 *      reading the outcome* may not sit in `sealed_test`. Retrospective
 *      criteria are fitted to what happened; that is post-treatment bias, and
 *      sealed test is the one split that cannot absorb it.
 *   3. Frozen means frozen — a set that has been frozen cannot gain cases.
 *
 * Splits are imported rather than redeclared so `EVALUATION_SPLITS` has exactly
 * one definition across the two gates.
 */
import { z } from 'zod'
import { EVALUATION_SPLITS } from '../evolution/ExperimentManifest.js'

/**
 * How faithfully the starting environment can be reproduced.
 *
 * Mirrors `EnvironmentFidelity` in BaseSnapshot.ts; declared here as a zod enum
 * so a case carries the claim its snapshot made and the schema can act on it.
 */
export const ENVIRONMENT_FIDELITIES = ['restored', 'approximated', 'unrestorable'] as const

/**
 * How faithfully the *actions* can be replayed — a separate axis from
 * environment fidelity, and the plan is explicit that one does not substitute
 * for the other. A perfectly restored environment driven by a non-deterministic
 * tool is still only approximately replayable.
 */
export const REPLAY_CLASSES = ['deterministic', 'approximate', 'non_replayable'] as const

/** Where a case's success criteria came from. Drives rule 2 above. */
export const CRITERIA_ORIGINS = ['user', 'external_spec', 'human_curated', 'reviewer_generated'] as const

export const SuccessCriterionSchema = z.object({
  id: z.string().min(1).max(64),
  statement: z.string().min(1).max(1_000),
  /**
   * Points into the evaluator bundle, never a bare shell command.
   *
   * v1 inlined `check.command` in the case, which makes every case an arbitrary
   * command the runner executes with the runner's own authority. Indirecting
   * through a versioned bundle is what lets the verifier run under a separate
   * identity that the candidate cannot write to.
   */
  checkRef: z.string().min(1).max(200),
}).strict()

export const EvalCaseSchema = z.object({
  schemaVersion: z.literal('eval-case-2.0'),
  id: z.string().regex(/^evalcase_[a-f0-9]{24}$/),

  origin: z.object({
    caseId: z.string().min(1),
    rootTrajectoryId: z.string().uuid(),
    taskReviewId: z.string().min(1),
  }).strict(),

  prompt: z.string().min(1),
  /**
   * SessionMode has more members than this. `campaign` spans too long to
   * re-execute and `robotics` depends on real hardware that cannot be replayed,
   * so neither can be a re-execution case — excluded at the type level rather
   * than left to be discovered by a runner that hangs.
   */
  mode: z.enum(['agentic', 'auto', 'simple_auto']),

  // ── References, not inlined payloads ──────────────────────────────────────
  eligibilityRef: z.string().min(1),
  /** Points at the state *before* the task ran. */
  baseSnapshotRef: z.string().min(1),
  environmentManifestRef: z.string().min(1),
  evaluatorBundleRef: z.string().min(1),
  resetRecipeRef: z.string().min(1),
  taskContractRef: z.string().min(1).optional(),

  criteriaOrigin: z.enum(CRITERIA_ORIGINS),
  /**
   * Shared by a task, its rewrites, and anything derived from it.
   *
   * Splitting on case id alone leaks: a rewritten duplicate of a training case
   * landing in sealed test is the same case wearing a different id.
   */
  contaminationGroupId: z.string().min(1).max(200),
  riskTier: z.enum(['R1', 'R2', 'R3']),

  successCriteria: z.array(SuccessCriterionSchema).min(1).max(20),

  replayClass: z.enum(REPLAY_CLASSES),
  environmentFidelity: z.enum(ENVIRONMENT_FIDELITIES),
  split: z.enum(EVALUATION_SPLITS),
  taskFamily: z.string().min(1).max(120).optional(),
  frozenAt: z.number(),
}).strict().superRefine((evalCase, ctx) => {
  // Rule 1. An unrestorable or non-replayable case can still be read for
  // diagnosis, which is what `support` is for; it cannot be re-executed.
  const cannotReExecute =
    evalCase.environmentFidelity === 'unrestorable' ||
    evalCase.replayClass === 'non_replayable'
  if (cannotReExecute && evalCase.split !== 'support') {
    ctx.addIssue({
      code: 'custom',
      message:
        `a case with environmentFidelity='${evalCase.environmentFidelity}' and ` +
        `replayClass='${evalCase.replayClass}' cannot be re-executed, so it may only sit in 'support'`,
      path: ['split'],
    })
  }

  // Rule 2. Reviewer-written criteria are produced after reading the outcome,
  // so they can be shaped — unintentionally — to match what already happened.
  if (evalCase.criteriaOrigin === 'reviewer_generated' && evalCase.split === 'sealed_test') {
    ctx.addIssue({
      code: 'custom',
      message:
        "criteriaOrigin='reviewer_generated' is retrospective and carries post-treatment bias; " +
        'it may not enter sealed_test until rewritten by an independent human or an external spec',
      path: ['criteriaOrigin'],
    })
  }

  const criterionIds = new Set(evalCase.successCriteria.map(c => c.id))
  if (criterionIds.size !== evalCase.successCriteria.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'success criteria ids must be unique within a case',
      path: ['successCriteria'],
    })
  }
})

export type EvalCase = z.infer<typeof EvalCaseSchema>
export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>

export const EvalSetSchema = z.object({
  schemaVersion: z.literal('eval-set-1.0'),
  id: z.string().regex(/^evalset_[a-z0-9][a-z0-9_-]{2,63}$/),
  name: z.string().min(1).max(200),
  createdAt: z.number(),
  /** Once set, the set is immutable. */
  frozenAt: z.number().optional(),
  caseIds: z.array(z.string().regex(/^evalcase_[a-f0-9]{24}$/)).max(10_000).default([]),
  note: z.string().max(2_000).optional(),
}).strict()

export type EvalSet = z.infer<typeof EvalSetSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Leakage detection
// ─────────────────────────────────────────────────────────────────────────────

export interface SplitLeak {
  contaminationGroupId: string
  /** The splits this group is spread across, sorted. */
  splits: string[]
  caseIds: string[]
}

/**
 * Find contamination groups that straddle more than one split.
 *
 * This is the check that makes the four-way split mean anything. Without it,
 * a case used to generate a candidate and a rewritten twin of that case used to
 * judge it look like two independent samples, and the resulting number is
 * measuring memorisation.
 *
 * Returns every violation rather than the first, because a corpus assembled
 * without this check usually has more than one and fixing them one at a time
 * wastes a full re-audit each round.
 */
export function detectSplitLeakage(cases: readonly EvalCase[]): SplitLeak[] {
  const bySplitGroup = new Map<string, Map<string, string[]>>()

  for (const evalCase of cases) {
    const splits = bySplitGroup.get(evalCase.contaminationGroupId) ?? new Map<string, string[]>()
    const ids = splits.get(evalCase.split) ?? []
    ids.push(evalCase.id)
    splits.set(evalCase.split, ids)
    bySplitGroup.set(evalCase.contaminationGroupId, splits)
  }

  const leaks: SplitLeak[] = []
  for (const [contaminationGroupId, splits] of bySplitGroup) {
    if (splits.size <= 1) continue
    leaks.push({
      contaminationGroupId,
      splits: [...splits.keys()].sort(),
      caseIds: [...splits.values()].flat().sort(),
    })
  }
  return leaks.sort((a, b) => a.contaminationGroupId.localeCompare(b.contaminationGroupId))
}

/**
 * Cases that satisfy G1's abort condition, i.e. genuinely re-executable ones.
 *
 * The gate's stopping rule counts cases whose starting state can be restored
 * *and* whose criteria are deterministic checks. Counting captured cases
 * instead would let a corpus of unrestorable fragments clear the bar and send
 * the project into G2 on evidence that cannot be reproduced.
 */
export function countReExecutableCases(cases: readonly EvalCase[]): number {
  return cases.filter(evalCase =>
    evalCase.environmentFidelity === 'restored' &&
    evalCase.replayClass !== 'non_replayable',
  ).length
}
