import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlashClient, FlashQueryOpts } from '../../core/flash/FlashClient.js'
import { ExperienceStore } from '../ExperienceStore.js'
import { PhysicalAnchorStore } from '../PhysicalAnchorStore.js'
import { PrincipleStore } from '../PrincipleStore.js'
import { PrinciplePendingStore } from '../PrinciplePendingStore.js'
import { proposePrincipleFromExperience } from '../PrinciplePromotion.js'
import { ExperiencePendingStore, validateExperienceInput } from '../ExperiencePendingStore.js'
import {
  diversityTier,
  evaluatePromotion,
  type EvaluatePromotionDeps,
} from '../PrincipleConvergence.js'
import type { ExperienceEntry } from '../types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-converge-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

type FlashHandlers = {
  claim?: (opts: FlashQueryOpts) => string | null
  cluster?: (opts: FlashQueryOpts) => string | null
  promote?: (opts: FlashQueryOpts) => string | null
}

function makeFlash(h: FlashHandlers): FlashClient {
  return {
    query: vi.fn(async (opts: FlashQueryOpts) => {
      const key = opts.cacheKey ?? ''
      if (key.startsWith('principle-claim:')) return h.claim?.(opts) ?? JSON.stringify({ applicable: [] })
      if (key.startsWith('principle-cluster-members:')) return h.cluster?.(opts) ?? JSON.stringify({ cluster: [] })
      if (key.startsWith('principle-cluster:')) return h.promote?.(opts) ?? null
      return null
    }),
  } as unknown as FlashClient
}

const FULL_PRINCIPLE = {
  promote: true,
  title: 'Control-loop latency must be bounded',
  statement: 'Algorithm latency must stay bounded relative to control-loop frequency or state estimation diverges.',
  mechanism: 'Stale state feedback accumulates phase lag beyond the stability margin.',
  first_principles_support: ['Feedback stability requires phase lag below the control margin.'],
  domains: ['locomotion'],
  abstraction_level: 'system',
  preconditions: ['Online feedback control is in the loop.'],
  applicability_bounds: ['Latency evaluated against actuator and estimator time constants.'],
  non_applicable_when: ['Offline planning without live feedback.'],
  anchored_by_physical_anchor_ids: [],
  evidence_refs: [],
  invalidated_assumptions: [],
  counter_examples: [],
  confidence_tier: 'observed',
  observation_count: 3,
  contradiction_count: 0,
}

async function writeExperience(
  store: ExperienceStore,
  over: Partial<ExperienceEntry> = {},
): Promise<string> {
  return store.write({
    domain: 'locomotion',
    title: over.title ?? 'latency experiment',
    tags: [],
    difficulty: 'high',
    problem: 'gait unstable when perception latency rises',
    solution: 'bound end-to-end latency before raising gait speed',
    outcome: over.outcome ?? { success: true, summary: 'bounded latency stabilized gait' },
    abstractPrinciple: 'bound latency relative to control frequency',
    confidenceTier: 'observed',
    observationCount: 1,
    contradictionCount: over.contradictionCount ?? 0,
    robot: over.robot,
    sourceSessionId: over.sourceSessionId,
    principleIds: over.principleIds,
    ...over,
  } as Omit<ExperienceEntry, 'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'>)
}

async function makeDeps(flash: FlashClient, n?: number): Promise<EvaluatePromotionDeps & {
  experienceStore: ExperienceStore; principleStore: PrincipleStore; pendingStore: PrinciplePendingStore
}> {
  return {
    experienceStore: new ExperienceStore(await tempDir()),
    principleStore: new PrincipleStore(await tempDir()),
    anchorStore: new PhysicalAnchorStore(await tempDir()),
    pendingStore: new PrinciplePendingStore('/proj/converge', await tempDir()),
    flash,
    n,
  }
}

async function seedPrinciple(store: PrincipleStore): Promise<string> {
  return store.write({
    title: 'existing latency principle',
    statement: 's', mechanism: 'm',
    firstPrinciplesSupport: ['x'], domains: ['locomotion'], abstractionLevel: 'system',
    preconditions: ['p'], applicabilityBounds: ['b'], nonApplicableWhen: ['n'],
    derivedFromExperienceIds: [], anchoredByPhysicalAnchorIds: [], evidenceRefs: [],
    invalidatedAssumptions: [], counterExamples: [],
    confidenceTier: 'observed', observationCount: 1, contradictionCount: 0,
    promotionReason: 'confidence_threshold',
  } as never)
}

// ─────────────────────────────────────────────────────────────────────────────
// diversityTier
// ─────────────────────────────────────────────────────────────────────────────

describe('diversityTier', () => {
  it('returns observed for a single source, reproduced for multiple', () => {
    const same = [
      { robot: 'go2', sourceSessionId: 's1' },
      { robot: 'go2', sourceSessionId: 's1' },
    ] as ExperienceEntry[]
    const diverse = [
      { robot: 'go2', sourceSessionId: 's1' },
      { robot: 'spot', sourceSessionId: 's2' },
    ] as ExperienceEntry[]
    expect(diversityTier(same)).toBe('observed')
    expect(diversityTier(diverse)).toBe('reproduced')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Claim + reinforce (recognition path)
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluatePromotion — claim + reinforce', () => {
  it('claims an existing principle and reinforces it on success', async () => {
    const deps = await makeDeps(makeFlash({}))
    const pid = await seedPrinciple(deps.principleStore)
    const expId = await writeExperience(deps.experienceStore, { outcome: { success: true, summary: 'ok' } })
    // claim handler returns the seeded principle as applicable
    ;(deps.flash as any).query = vi.fn(async (opts: FlashQueryOpts) =>
      opts.cacheKey?.startsWith('principle-claim:') ? JSON.stringify({ applicable: [pid] }) : null)

    const res = await evaluatePromotion(expId, deps)
    expect(res.kind).toBe('reinforced')
    if (res.kind === 'reinforced') {
      expect(res.principleIds).toContain(pid)
      expect(res.signal).toBe('observation')
    }
    const principle = await deps.principleStore.load(pid)
    expect(principle?.observationCount).toBe(2)
    const exp = await deps.experienceStore.load(expId)
    expect(exp?.principleIds).toContain(pid)
  })

  it('records a contradiction when the claiming experience failed', async () => {
    const deps = await makeDeps(makeFlash({}))
    const pid = await seedPrinciple(deps.principleStore)
    const expId = await writeExperience(deps.experienceStore, {
      outcome: { success: false, summary: 'principle did not hold', failureReason: 'new regime' },
    })
    ;(deps.flash as any).query = vi.fn(async (opts: FlashQueryOpts) =>
      opts.cacheKey?.startsWith('principle-claim:') ? JSON.stringify({ applicable: [pid] }) : null)

    const res = await evaluatePromotion(expId, deps)
    expect(res.kind).toBe('reinforced')
    if (res.kind === 'reinforced') expect(res.signal).toBe('contradiction')
    const principle = await deps.principleStore.load(pid)
    expect(principle?.contradictionCount).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Convergence path
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluatePromotion — convergence', () => {
  it('proposes one principle when ≥ N experiences converge', async () => {
    let others: string[] = []
    const flash = makeFlash({
      cluster: () => JSON.stringify({ cluster: others }),
      promote: () => JSON.stringify(FULL_PRINCIPLE),
    })
    const deps = await makeDeps(flash)
    const a = await writeExperience(deps.experienceStore, { robot: 'go2', sourceSessionId: 's1' })
    const b = await writeExperience(deps.experienceStore, { robot: 'spot', sourceSessionId: 's2' })
    const c = await writeExperience(deps.experienceStore, { robot: 'go2', sourceSessionId: 's3' })
    others = [b, c]

    const res = await evaluatePromotion(a, deps)
    expect(res.kind).toBe('proposed')
    if (res.kind === 'proposed') expect(res.clusterIds).toHaveLength(3)
    expect(deps.pendingStore.count).toBe(1)
    const input = deps.pendingStore.list()[0]!.input
    expect(input['source_experience_id']).toBe(a)
    expect(input['derived_from_experience_ids']).toHaveLength(3)
    // diversity = 3 distinct (robot,session) signatures → reproduced
    expect(input['confidence_tier']).toBe('reproduced')
    await deps.pendingStore.flush()
  })

  it('does not promote below the convergence threshold', async () => {
    let others: string[] = []
    const flash = makeFlash({ cluster: () => JSON.stringify({ cluster: others }) })
    const deps = await makeDeps(flash)
    const a = await writeExperience(deps.experienceStore)
    const b = await writeExperience(deps.experienceStore)
    others = [b] // cluster of 2 < N=3

    const res = await evaluatePromotion(a, deps)
    expect(res.kind).toBe('none')
    if (res.kind === 'none') expect(res.reason).toBe('below_convergence')
    expect(deps.pendingStore.count).toBe(0)
  })

  it('rejects (abstains) when the judge declines to abstract', async () => {
    let others: string[] = []
    const flash = makeFlash({
      cluster: () => JSON.stringify({ cluster: others }),
      promote: () => JSON.stringify({ promote: false, reason: 'merely a version-specific tooling quirk' }),
    })
    const deps = await makeDeps(flash)
    const a = await writeExperience(deps.experienceStore)
    const b = await writeExperience(deps.experienceStore)
    const c = await writeExperience(deps.experienceStore)
    others = [b, c]

    const res = await evaluatePromotion(a, deps)
    expect(res.kind).toBe('rejected')
    if (res.kind === 'rejected') expect(res.reason).toContain('quirk')
    expect(deps.pendingStore.count).toBe(0)
  })

  it('trims judge-rejected members from derived_from but still promotes if ≥ N remain', async () => {
    let others: string[] = []
    let rejected: string[] = []
    const flash = makeFlash({
      cluster: () => JSON.stringify({ cluster: others }),
      promote: () => JSON.stringify({ ...FULL_PRINCIPLE, rejected_members: rejected }),
    })
    const deps = await makeDeps(flash)
    const a = await writeExperience(deps.experienceStore)
    const b = await writeExperience(deps.experienceStore)
    const c = await writeExperience(deps.experienceStore)
    const d = await writeExperience(deps.experienceStore)
    others = [b, c, d] // cluster of 4
    rejected = [d]      // drop one → 3 retained ≥ N

    const res = await evaluatePromotion(a, deps)
    expect(res.kind).toBe('proposed')
    const derived = deps.pendingStore.list()[0]!.input['derived_from_experience_ids'] as string[]
    expect(derived).toHaveLength(3)
    expect(derived).not.toContain(d)
    await deps.pendingStore.flush()
  })

  it('rejects as below_convergence when trimming drops the cluster under N', async () => {
    let others: string[] = []
    let rejected: string[] = []
    const flash = makeFlash({
      cluster: () => JSON.stringify({ cluster: others }),
      promote: () => JSON.stringify({ ...FULL_PRINCIPLE, rejected_members: rejected }),
    })
    const deps = await makeDeps(flash)
    const a = await writeExperience(deps.experienceStore)
    const b = await writeExperience(deps.experienceStore)
    const c = await writeExperience(deps.experienceStore)
    others = [b, c]      // cluster of 3
    rejected = [b, c]    // drop two → 1 retained < N

    const res = await evaluatePromotion(a, deps)
    expect(res.kind).toBe('none')
    if (res.kind === 'none') expect(res.reason).toBe('below_convergence')
    expect(deps.pendingStore.count).toBe(0)
  })

  it('blocks promotion when a cluster member has an unresolved contradiction', async () => {
    let others: string[] = []
    const flash = makeFlash({
      cluster: () => JSON.stringify({ cluster: others }),
      promote: () => JSON.stringify(FULL_PRINCIPLE),
    })
    const deps = await makeDeps(flash)
    const a = await writeExperience(deps.experienceStore)
    const b = await writeExperience(deps.experienceStore)
    const c = await writeExperience(deps.experienceStore, { contradictionCount: 1 })
    others = [b, c]

    const res = await evaluatePromotion(a, deps)
    expect(res.kind).toBe('none')
    if (res.kind === 'none') expect(res.reason).toBe('unresolved_contradiction')
  })

  it('skips when the cluster is already covered by a principle (dedup)', async () => {
    let others: string[] = []
    const flash = makeFlash({
      cluster: () => JSON.stringify({ cluster: others }),
      promote: () => JSON.stringify(FULL_PRINCIPLE),
    })
    const deps = await makeDeps(flash)
    // trigger already linked to a principle (claim returns none → falls to cluster)
    const a = await writeExperience(deps.experienceStore, { principleIds: ['pr_seed_0000abcd'] })
    const b = await writeExperience(deps.experienceStore)
    const c = await writeExperience(deps.experienceStore)
    others = [b, c]

    const res = await evaluatePromotion(a, deps)
    expect(res.kind).toBe('none')
    if (res.kind === 'none') expect(res.reason).toBe('already_covered')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Strict single-experience path (explicit promotion still honors abstain)
// ─────────────────────────────────────────────────────────────────────────────

describe('proposePrincipleFromExperience — strict judge', () => {
  it('returns rejected_by_judge when the judge abstains', async () => {
    const experiences = new ExperienceStore(await tempDir())
    const anchors = new PhysicalAnchorStore(await tempDir())
    const pending = new PrinciplePendingStore('/proj/strict', await tempDir())
    const expId = await writeExperience(experiences, { confidenceTier: 'reproduced', observationCount: 2 })

    const flash = {
      query: vi.fn().mockResolvedValue(JSON.stringify({ promote: false, reason: 'one-off environment fact' })),
    } as unknown as FlashClient

    const res = await proposePrincipleFromExperience({
      experienceId: expId,
      experienceStore: experiences,
      anchorStore: anchors,
      pendingStore: pending,
      flash,
      reason: 'explicit_user_request',
    })
    expect(res.promoted).toBe(false)
    expect(res.reason).toBe('rejected_by_judge')
    expect(res.judgeReason).toContain('one-off')
    expect(pending.count).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// principle_ids plumbing (experience_write → pending → ExperienceStore)
// ─────────────────────────────────────────────────────────────────────────────

describe('principle_ids passthrough', () => {
  it('validateExperienceInput keeps only well-formed principle IDs', () => {
    const out = validateExperienceInput({
      domain: 'locomotion', title: 't', problem: 'p', solution: 's',
      success: true, outcome_summary: 'o',
      principle_ids: ['pr_abc123_0011aaff', 'not-an-id', 'pr_abc123_0011aaff'],
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.value.principleIds).toEqual(['pr_abc123_0011aaff'])
  })

  it('commits principle_ids onto the stored experience', async () => {
    const store = new ExperienceStore(await tempDir())
    const pending = new ExperiencePendingStore('/proj/plumb', await tempDir())
    pending.add({
      domain: 'locomotion', title: 't', problem: 'p', solution: 's',
      success: true, outcome_summary: 'o',
      principle_ids: ['pr_abc123_0011aaff'],
    })
    const committedId = await pending.commit(pending.list()[0]!.pendingId, store)
    expect(committedId).toBeTruthy()
    const exp = await store.load(committedId!)
    expect(exp?.principleIds).toEqual(['pr_abc123_0011aaff'])
    await pending.flush()
  })
})
