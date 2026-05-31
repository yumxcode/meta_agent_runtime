import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlashClient } from '../../core/flash/FlashClient.js'
import { ExperienceStore } from '../ExperienceStore.js'
import { PhysicalAnchorStore } from '../PhysicalAnchorStore.js'
import { PrinciplePendingStore } from '../PrinciplePendingStore.js'
import { PrincipleStore } from '../PrincipleStore.js'
import {
  proposePrincipleFromExperience,
  shouldTriggerPrinciplePromotion,
} from '../PrinciplePromotion.js'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-principle-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function flashReturning(anchorId: string): FlashClient {
  return {
    query: vi.fn().mockResolvedValue(JSON.stringify({
      title: 'Latency budget bounds closed-loop control',
      statement: 'Closed-loop control fails when sensing and planning latency approaches the plant response time.',
      mechanism: 'The controller acts on stale state and amplifies correction error.',
      first_principles_support: ['Feedback stability requires phase lag to stay below the control margin.'],
      domains: ['locomotion'],
      abstraction_level: 'system',
      preconditions: ['The task uses online feedback control.'],
      applicability_bounds: ['Loop latency must be evaluated relative to actuator and estimator time constants.'],
      non_applicable_when: ['Offline planning without live feedback.'],
      derived_from_experience_ids: [],
      anchored_by_physical_anchor_ids: [anchorId],
      evidence_refs: ['logs/run-12.txt'],
      invalidated_assumptions: ['Planner speed alone determines stability.'],
      counter_examples: [],
      confidence_tier: 'reproduced',
      observation_count: 2,
      contradiction_count: 0,
    })),
  } as unknown as FlashClient
}

describe('Principle promotion', () => {
  it('queues a reviewed principle candidate when confidence reaches the threshold', async () => {
    const expDir = await tempDir()
    const anchorDir = await tempDir()
    const pendingDir = await tempDir()
    const principleDir = await tempDir()
    const experiences = new ExperienceStore(expDir)
    const anchors = new PhysicalAnchorStore(anchorDir)
    const pending = new PrinciplePendingStore('/project/a', pendingDir)
    const principles = new PrincipleStore(principleDir)

    const anchorId = await anchors.write({
      domain: 'locomotion',
      scope: 'robot',
      title: 'Actuator response lag',
      fact: 'The actuator response has measurable lag under load.',
      implication: 'Latency budgets must include actuator lag.',
      tags: ['latency'],
      confidenceTier: 'observed',
      evidenceRefs: ['scope.png'],
    })
    const experienceId = await experiences.write({
      domain: 'locomotion',
      title: 'Repeated gait instability from latency',
      tags: ['latency'],
      difficulty: 'high',
      problem: 'Gait became unstable when perception latency increased.',
      solution: 'Bound end-to-end latency before raising gait speed.',
      outcome: { success: false, summary: 'Latency failure reproduced.', failureReason: 'Stale state feedback.' },
      abstractPrinciple: 'Latency must be bounded relative to response time.',
      confidenceTier: 'reproduced',
      observationCount: 2,
      contradictionCount: 0,
      invalidatedAssumptions: ['Controller gain tuning was the only cause.'],
    })
    const loaded = await experiences.load(experienceId)
    expect(loaded && shouldTriggerPrinciplePromotion(loaded)).toBe(true)

    const result = await proposePrincipleFromExperience({
      experienceId,
      experienceStore: experiences,
      anchorStore: anchors,
      pendingStore: pending,
      flash: flashReturning(anchorId),
      reason: 'confidence_threshold',
    })

    expect(result.promoted).toBe(true)
    expect(pending.count).toBe(1)
    const committedId = await pending.commit(pending.list()[0]!.pendingId, principles, experiences)
    expect(committedId).toMatch(/^pr_/)
    const committed = await principles.load(committedId!)
    expect(committed?.firstPrinciplesSupport[0]).toContain('Feedback stability')
    expect(committed?.anchoredByPhysicalAnchorIds).toContain(anchorId)
    expect(committed?.nonApplicableWhen[0]).toContain('Offline')
    const sourceExperience = await experiences.load(experienceId)
    expect(sourceExperience?.principleIds).toContain(committedId)
  })

  it('allows explicit user-request promotion below the confidence threshold', async () => {
    const expDir = await tempDir()
    const anchorDir = await tempDir()
    const pendingDir = await tempDir()
    const experiences = new ExperienceStore(expDir)
    const anchors = new PhysicalAnchorStore(anchorDir)
    const pending = new PrinciplePendingStore('/project/b', pendingDir)

    const anchorId = await anchors.write({
      domain: 'navigation',
      scope: 'global',
      title: 'Costmap update rate',
      fact: 'Costmap updates can lag obstacle motion.',
      implication: 'Planner assumptions must include map staleness.',
      tags: ['costmap'],
      confidenceTier: 'reported',
      evidenceRefs: [],
    })
    const experienceId = await experiences.write({
      domain: 'navigation',
      title: 'Single navigation hypothesis',
      tags: ['costmap'],
      difficulty: 'medium',
      problem: 'A local planner clipped a dynamic obstacle.',
      solution: 'Account for costmap staleness.',
      outcome: { success: false, summary: 'Single observation.' },
      abstractPrinciple: 'Costmap freshness constrains dynamic obstacle planning.',
      confidenceTier: 'hypothesis',
      observationCount: 1,
    })

    const result = await proposePrincipleFromExperience({
      experienceId,
      experienceStore: experiences,
      anchorStore: anchors,
      pendingStore: pending,
      flash: flashReturning(anchorId),
      reason: 'explicit_user_request',
    })

    expect(result.promoted).toBe(true)
    expect(pending.count).toBe(1)
    expect(pending.list()[0]!.input['promotion_reason']).toBe('explicit_user_request')
  })
})
