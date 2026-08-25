/**
 * Experiment manifest contract (G0-D).
 *
 * A comparison result without a manifest is a debugging note, not evidence.
 * The manifest freezes what was compared, on which data, under which
 * pre-registration — and the pre-registration has to exist *before* results,
 * otherwise thresholds drift to wherever the numbers landed.
 *
 * Two invariants carry most of the value:
 *
 *   1. results cannot be attached without a prior pre-registration;
 *   2. a sealed-test split is single-use and must record its opening.
 *
 * Both are enforced in the schema rather than left to discipline, because both
 * fail silently and only become visible much later as an inflated result.
 *
 * Contract only — no store, no runner.
 */
import { z } from 'zod'
import { ArtifactSetSchema } from './ArtifactRegistry.js'

export const EVALUATION_SPLITS = ['support', 'validation', 'sealed_test', 'canary'] as const
export type EvaluationSplit = (typeof EVALUATION_SPLITS)[number]

/**
 * Pre-registration. Frozen before the runner starts.
 *
 * `minimumDetectableEffect` is mandatory: without it "no significant
 * difference" gets read as "equivalent", which is the most common way an
 * underpowered comparison licenses a bad decision.
 */
export const PreRegistrationSchema = z.object({
  primaryMetric: z.string().min(1),
  secondaryMetrics: z.array(z.string().min(1)).max(24).default([]),
  /** Metrics that may not regress at all, whatever the primary shows. */
  guardMetrics: z.array(z.string().min(1)).max(24).default([]),
  minimumDetectableEffect: z.number().positive(),
  confidenceLevel: z.number().gt(0.5).lt(1),
  plannedRepeats: z.number().int().positive(),
  /** TaskCase count, not run count — repeated seeds are not new samples. */
  plannedSampleSize: z.number().int().positive(),
  stoppingRule: z.string().min(1).max(1_000),
  rollbackThreshold: z.string().min(1).max(1_000),
  multipleComparisonControl: z.enum(['none', 'bonferroni', 'benjamini_hochberg', 'preregistered_single']),
  registeredAt: z.number(),
}).strict()

export type PreRegistration = z.infer<typeof PreRegistrationSchema>

export const ExperimentArmSchema = z.object({
  label: z.enum(['incumbent', 'candidate']),
  artifacts: ArtifactSetSchema,
  randomSeed: z.number().int().optional(),
  /**
   * Present only when a policy chose this arm probabilistically. Off-policy
   * estimation is impossible without it, so its absence must be visible rather
   * than assumed to be 0.5.
   */
  assignmentPropensity: z.number().gt(0).lte(1).optional(),
  eligibleActions: z.array(z.string().min(1)).max(64).optional(),
}).strict()

export const ExperimentResultSchema = z.object({
  metric: z.string().min(1),
  incumbent: z.number(),
  candidate: z.number(),
  /** Absolute difference, plus the interval that says whether it means anything. */
  delta: z.number(),
  confidenceIntervalLow: z.number(),
  confidenceIntervalHigh: z.number(),
  sampleSize: z.number().int().nonnegative(),
  /** `inconclusive` is a first-class outcome, never collapsed into "no effect". */
  verdict: z.enum(['candidate_better', 'incumbent_better', 'equivalent', 'inconclusive']),
}).strict()

export const SealedTestOpeningSchema = z.object({
  openedAt: z.number(),
  openedBy: z.string().min(1),
  /** The candidate must already be frozen when the seal is broken. */
  frozenCandidateHash: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().min(1).max(1_000),
}).strict()

export const ExperimentRunManifestSchema = z.object({
  schemaVersion: z.literal('experiment-run-1.0'),
  experimentId: z.string().regex(/^experiment_[a-f0-9]{24}$/),
  createdAt: z.number(),
  completedAt: z.number().optional(),

  evalSetId: z.string().min(1),
  split: z.enum(EVALUATION_SPLITS),
  caseIds: z.array(z.string().min(1)).min(1),
  baseSnapshotRefs: z.record(z.string(), z.string()),
  evaluatorBundleRef: z.string().min(1),
  /** Weakest evaluator tier contributing to the primary metric. */
  evaluatorTier: z.enum(['T0', 'T1', 'T2', 'T3']),

  arms: z.array(ExperimentArmSchema).length(2),

  runnerVersion: z.string().min(1),
  environmentFingerprint: z.string().min(1),

  preRegistration: PreRegistrationSchema.optional(),
  sealedTestOpening: SealedTestOpeningSchema.optional(),
  results: z.array(ExperimentResultSchema).max(48).optional(),
  note: z.string().max(2_000).optional(),
}).strict().superRefine((manifest, ctx) => {
  const labels = manifest.arms.map(arm => arm.label)
  if (!labels.includes('incumbent') || !labels.includes('candidate')) {
    ctx.addIssue({ code: 'custom', message: 'a comparison needs exactly one incumbent and one candidate arm', path: ['arms'] })
  }

  if (manifest.results && manifest.results.length > 0) {
    // Registering thresholds after seeing numbers is not pre-registration.
    if (!manifest.preRegistration) {
      ctx.addIssue({
        code: 'custom',
        message: 'results cannot be recorded without a pre-registration frozen beforehand',
        path: ['preRegistration'],
      })
    } else if (manifest.preRegistration.registeredAt > manifest.createdAt) {
      ctx.addIssue({
        code: 'custom',
        message: 'pre-registration must be frozen no later than the run it governs',
        path: ['preRegistration', 'registeredAt'],
      })
    }

    if (manifest.preRegistration) {
      const measured = new Set(manifest.results.map(result => result.metric))
      if (!measured.has(manifest.preRegistration.primaryMetric)) {
        ctx.addIssue({
          code: 'custom',
          message: `results omit the pre-registered primary metric '${manifest.preRegistration.primaryMetric}'`,
          path: ['results'],
        })
      }
      for (const guard of manifest.preRegistration.guardMetrics) {
        if (!measured.has(guard)) {
          ctx.addIssue({
            code: 'custom',
            message: `results omit the pre-registered guard metric '${guard}'`,
            path: ['results'],
          })
        }
      }
    }
  }

  // A sealed test is consumed by being opened. Recording the opening is what
  // makes "single use" auditable rather than aspirational.
  if (manifest.split === 'sealed_test' && manifest.results && !manifest.sealedTestOpening) {
    ctx.addIssue({
      code: 'custom',
      message: 'sealed_test results require a recorded sealedTestOpening',
      path: ['sealedTestOpening'],
    })
  }
  if (manifest.split !== 'sealed_test' && manifest.sealedTestOpening) {
    ctx.addIssue({
      code: 'custom',
      message: 'only a sealed_test run may record a sealedTestOpening',
      path: ['sealedTestOpening'],
    })
  }

  // support exists to generate hypotheses; treating it as evidence for a
  // release decision is the adaptive-leak path in miniature.
  if (manifest.split === 'support' && manifest.results) {
    ctx.addIssue({
      code: 'custom',
      message: 'the support split generates candidates; it does not produce comparison results',
      path: ['results'],
    })
  }

  for (const [index, caseId] of manifest.caseIds.entries()) {
    if (!(caseId in manifest.baseSnapshotRefs)) {
      ctx.addIssue({
        code: 'custom',
        message: `case '${caseId}' has no base snapshot; re-execution would start from an unknown state`,
        path: ['baseSnapshotRefs', index],
      })
    }
  }
})

export type ExperimentRunManifest = z.infer<typeof ExperimentRunManifestSchema>
export type ExperimentArm = z.infer<typeof ExperimentArmSchema>
export type ExperimentResult = z.infer<typeof ExperimentResultSchema>

/**
 * Whether a manifest may back a promotion decision.
 *
 * Deliberately conservative: this returns reasons rather than a bare boolean so
 * a refusal can be shown to the person who has to act on it.
 */
export function promotionBlockers(manifest: ExperimentRunManifest): string[] {
  const blockers: string[] = []
  if (!manifest.results || manifest.results.length === 0) blockers.push('no results recorded')
  if (!manifest.preRegistration) blockers.push('no pre-registration')
  if (manifest.split === 'support' || manifest.split === 'validation') {
    blockers.push(`split '${manifest.split}' cannot license a promotion on its own; use canary or sealed_test`)
  }
  if (manifest.evaluatorTier === 'T0' || manifest.evaluatorTier === 'T1') {
    blockers.push(`primary metric rests on a ${manifest.evaluatorTier} evaluator; T2 is the minimum`)
  }
  const primary = manifest.preRegistration?.primaryMetric
  const primaryResult = manifest.results?.find(result => result.metric === primary)
  if (primaryResult?.verdict === 'inconclusive') {
    blockers.push('primary metric is inconclusive; an underpowered comparison is not equivalence')
  }
  return blockers
}
