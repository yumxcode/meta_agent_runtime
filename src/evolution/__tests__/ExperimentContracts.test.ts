/**
 * Artifact registry, experiment manifest and risk tiering.
 *
 * Each suite pins an invariant that fails silently if left to discipline:
 * a hash you cannot resolve, a threshold registered after the numbers, a
 * sealed test opened twice, or a prompt classified as low risk because it is
 * text.
 */
import { describe, expect, it } from 'vitest'
import {
  ArtifactEntrySchema,
  ArtifactSetSchema,
  ExperimentRunManifestSchema,
  artifactIdFor,
  assertArtifactRetrievable,
  assertInjectionRiskTier,
  assessRisk,
  differingArtifactKinds,
  hashArtifactContent,
  isShadowEligible,
  promotionBlockers,
  verifyArtifactContent,
  type ArtifactEntry,
  type ExperimentRunManifest,
  type RiskInputs,
} from '../index.js'

const TEXT = 'You are a careful engineering agent.'
const HASH = hashArtifactContent(TEXT)
const ID = artifactIdFor('prompt', HASH)
const OTHER_ID = artifactIdFor('prompt', hashArtifactContent('previous prompt'))

function artifact(overrides: Record<string, unknown> = {}): ArtifactEntry {
  return ArtifactEntrySchema.parse({
    schemaVersion: 'artifact-entry-1.0',
    artifactId: ID,
    kind: 'prompt',
    contentHash: HASH,
    content: { storage: 'inline', text: TEXT },
    createdBy: 'micah',
    createdAt: 1_000,
    approvalState: 'draft',
    ...overrides,
  })
}

describe('artifact registry', () => {
  it('verifies a hash against inline content', () => {
    expect(verifyArtifactContent(artifact())).toBe(true)
    expect(verifyArtifactContent(artifact({ contentHash: 'f'.repeat(64) }))).toBe(false)
  })

  it('refuses an external artifact whose content cannot be resolved', () => {
    const external = artifact({ content: { storage: 'external', ref: 'blob://prompt-1', sizeBytes: 42 } })
    expect(() => assertArtifactRetrievable(external))
      .toThrow(/hash without retrievable content cannot reproduce a comparison/)
    expect(() => assertArtifactRetrievable(external, TEXT)).not.toThrow()
    expect(() => assertArtifactRetrievable(external, 'different text')).toThrow(/does not match/)
  })

  it('requires a rollback target before anything reaches traffic', () => {
    for (const approvalState of ['canary', 'promoted'] as const) {
      expect(ArtifactEntrySchema.safeParse({ ...artifact(), approvalState }).success, approvalState).toBe(false)
      expect(ArtifactEntrySchema.safeParse({
        ...artifact(), approvalState, rollbackTarget: OTHER_ID,
      }).success, approvalState).toBe(true)
    }
    // shadow is not exposed to traffic, so it does not need one.
    expect(ArtifactEntrySchema.safeParse({ ...artifact(), approvalState: 'shadow' }).success).toBe(true)
  })

  it('rejects a rollback target or base that points at itself', () => {
    expect(ArtifactEntrySchema.safeParse({
      ...artifact(), approvalState: 'canary', rollbackTarget: ID,
    }).success).toBe(false)
    expect(ArtifactEntrySchema.safeParse({ ...artifact(), baseArtifactId: ID }).success).toBe(false)
  })

  it('does not let a draft claim a deploy scope', () => {
    expect(ArtifactEntrySchema.safeParse({ ...artifact(), deployScope: ['ws-1'] }).success).toBe(false)
  })

  it('names which dimensions differ between two candidate surfaces', () => {
    const incumbent = ArtifactSetSchema.parse({
      prompt: 'a', tool_schema: 't', runtime_version: 'r', model_config: 'm', evaluator_bundle: 'e',
    })
    expect(differingArtifactKinds(incumbent, incumbent)).toEqual([])
    const candidate = ArtifactSetSchema.parse({ ...incumbent, prompt: 'b', playbook: ['p1'] })
    expect(differingArtifactKinds(incumbent, candidate)).toEqual(['playbook', 'prompt'])
  })
})

const ARTIFACTS = ArtifactSetSchema.parse({
  prompt: 'a', tool_schema: 't', runtime_version: 'r', model_config: 'm', evaluator_bundle: 'e',
})

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'experiment-run-1.0',
    experimentId: `experiment_${'0'.repeat(24)}`,
    createdAt: 2_000,
    evalSetId: 'evalset-1',
    split: 'validation',
    caseIds: ['case-1'],
    baseSnapshotRefs: { 'case-1': 'snap-1' },
    evaluatorBundleRef: 'bundle-1',
    evaluatorTier: 'T2',
    arms: [
      { label: 'incumbent', artifacts: ARTIFACTS },
      { label: 'candidate', artifacts: { ...ARTIFACTS, prompt: 'b' } },
    ],
    runnerVersion: 'runner-1',
    environmentFingerprint: 'env-1',
    ...overrides,
  }
}

const PRE_REGISTRATION = {
  primaryMetric: 'case_success_rate',
  guardMetrics: ['false_success_precision'],
  minimumDetectableEffect: 0.1,
  confidenceLevel: 0.95,
  plannedRepeats: 3,
  plannedSampleSize: 30,
  stoppingRule: 'stop after 3 repeats of the frozen case set',
  rollbackThreshold: 'roll back if false_success_precision regresses at all',
  multipleComparisonControl: 'preregistered_single',
  registeredAt: 1_500,
}

const RESULTS = [
  {
    metric: 'case_success_rate', incumbent: 0.6, candidate: 0.72, delta: 0.12,
    confidenceIntervalLow: 0.02, confidenceIntervalHigh: 0.22, sampleSize: 30, verdict: 'candidate_better',
  },
  {
    metric: 'false_success_precision', incumbent: 0.1, candidate: 0.1, delta: 0,
    confidenceIntervalLow: -0.03, confidenceIntervalHigh: 0.03, sampleSize: 30, verdict: 'equivalent',
  },
]

describe('experiment manifest', () => {
  it('accepts a well-formed comparison', () => {
    expect(ExperimentRunManifestSchema.safeParse(manifest()).success).toBe(true)
  })

  it('refuses results without a pre-registration', () => {
    const parsed = ExperimentRunManifestSchema.safeParse(manifest({ results: RESULTS }))
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/frozen beforehand/)
  })

  it('refuses a pre-registration written after the run started', () => {
    const parsed = ExperimentRunManifestSchema.safeParse(manifest({
      results: RESULTS,
      preRegistration: { ...PRE_REGISTRATION, registeredAt: 2_500 },
    }))
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/no later than the run it governs/)
  })

  it('refuses results that quietly drop the primary or a guard metric', () => {
    for (const kept of [[RESULTS[1]], [RESULTS[0]]]) {
      const parsed = ExperimentRunManifestSchema.safeParse(manifest({
        results: kept, preRegistration: PRE_REGISTRATION,
      }))
      expect(parsed.success).toBe(false)
      expect(JSON.stringify(parsed.error?.issues)).toMatch(/results omit the pre-registered/)
    }
  })

  it('makes a sealed test single-use by requiring a recorded opening', () => {
    const sealed = manifest({ split: 'sealed_test', results: RESULTS, preRegistration: PRE_REGISTRATION })
    expect(ExperimentRunManifestSchema.safeParse(sealed).success).toBe(false)

    const opened = ExperimentRunManifestSchema.safeParse({
      ...sealed,
      sealedTestOpening: {
        openedAt: 2_100, openedBy: 'micah',
        frozenCandidateHash: 'a'.repeat(64),
        reason: 'release decision for candidate prompt b',
      },
    })
    expect(opened.success).toBe(true)
  })

  it('does not let a non-sealed run claim a sealed opening', () => {
    expect(ExperimentRunManifestSchema.safeParse(manifest({
      sealedTestOpening: {
        openedAt: 2_100, openedBy: 'micah', frozenCandidateHash: 'a'.repeat(64), reason: 'x',
      },
    })).success).toBe(false)
  })

  it('does not let the support split produce comparison results', () => {
    expect(ExperimentRunManifestSchema.safeParse(manifest({
      split: 'support', results: RESULTS, preRegistration: PRE_REGISTRATION,
    })).success).toBe(false)
  })

  it('refuses a case with no base snapshot', () => {
    const parsed = ExperimentRunManifestSchema.safeParse(manifest({
      caseIds: ['case-1', 'case-2'],
    }))
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/would start from an unknown state/)
  })

  it('needs one incumbent and one candidate', () => {
    expect(ExperimentRunManifestSchema.safeParse(manifest({
      arms: [
        { label: 'candidate', artifacts: ARTIFACTS },
        { label: 'candidate', artifacts: ARTIFACTS },
      ],
    })).success).toBe(false)
  })

  describe('promotion blockers', () => {
    const complete = ExperimentRunManifestSchema.parse(manifest({
      split: 'canary', results: RESULTS, preRegistration: PRE_REGISTRATION,
    })) as ExperimentRunManifest

    it('clears a canary run backed by a T2 evaluator', () => {
      expect(promotionBlockers(complete)).toEqual([])
    })

    it('blocks validation-only evidence', () => {
      const validationOnly = { ...complete, split: 'validation' as const }
      expect(promotionBlockers(validationOnly).join(' ')).toMatch(/cannot license a promotion on its own/)
    })

    it('blocks an LLM judge as the primary metric', () => {
      expect(promotionBlockers({ ...complete, evaluatorTier: 'T1' }).join(' '))
        .toMatch(/T1 evaluator; T2 is the minimum/)
    })

    it('treats inconclusive as blocking, not as equivalence', () => {
      const inconclusive = {
        ...complete,
        results: [{ ...RESULTS[0]!, verdict: 'inconclusive' as const }, RESULTS[1]!],
      }
      expect(promotionBlockers(inconclusive as ExperimentRunManifest).join(' '))
        .toMatch(/underpowered comparison is not equivalence/)
    })
  })
})

describe('risk tiering', () => {
  const shadow: RiskInputs = {
    effectiveCapability: 'read_only',
    dataScope: 'synthetic',
    reversibility: 'instant',
    blastRadius: 'shadow',
  }

  it('reserves R1 for shadow, read-only, instantly reversible candidates', () => {
    expect(assessRisk(shadow).tier).toBe('R1')
    expect(isShadowEligible(shadow)).toBe(true)
  })

  it('raises anything that can write a real workspace to at least R2', () => {
    expect(assessRisk({ ...shadow, effectiveCapability: 'workspace_write' }).tier).toBe('R2')
    expect(assessRisk({ ...shadow, blastRadius: 'workspace' }).tier).toBe('R2')
  })

  it('raises external side effects, cross-workspace data and irreversibility to R3', () => {
    expect(assessRisk({ ...shadow, effectiveCapability: 'external_side_effect' }).tier).toBe('R3')
    expect(assessRisk({ ...shadow, dataScope: 'cross_workspace' }).tier).toBe('R3')
    expect(assessRisk({ ...shadow, reversibility: 'irreversible' }).tier).toBe('R3')
    expect(assessRisk({ ...shadow, blastRadius: 'fleet' }).tier).toBe('R3')
  })

  it('explains which input forced the tier', () => {
    const assessment = assessRisk({ ...shadow, effectiveCapability: 'workspace_write' })
    expect(assessment.drivers.join(' ')).toMatch(/write the real workspace/)
    expect(assessRisk(shadow).drivers.join(' ')).toMatch(/shadow or sandboxed/)
  })

  it('rejects calling injected context R1 because it is only text', () => {
    // The P1-5 mistake: a prompt reaching an agent that holds write tools.
    expect(() => assertInjectionRiskTier('R1', {
      effectiveCapability: 'workspace_write',
      dataScope: 'single_workspace',
      reversibility: 'bounded',
      blastRadius: 'single_session',
    })).toThrow(/risk follows what the receiving agent can reach/)

    expect(() => assertInjectionRiskTier('R2', {
      effectiveCapability: 'workspace_write',
      dataScope: 'single_workspace',
      reversibility: 'bounded',
      blastRadius: 'single_session',
    })).not.toThrow()
  })

  it('allows a declaration stricter than the assessment', () => {
    expect(() => assertInjectionRiskTier('R3', shadow)).not.toThrow()
  })
})
