import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlashClient, FlashQueryOpts } from '../../core/flash/FlashClient.js'
import { ExperienceStore } from '../ExperienceStore.js'
import { PhysicalAnchorStore } from '../PhysicalAnchorStore.js'
import { PhysicalAnchorPendingStore } from '../PhysicalAnchorPendingStore.js'
import { PrincipleStore } from '../PrincipleStore.js'
import { PrinciplePendingStore } from '../PrinciplePendingStore.js'
import { ExperiencePendingStore, validateExperienceInput } from '../ExperiencePendingStore.js'
import { createExperienceWriteTool } from '../tools/experience_write/index.js'
import { proposePrincipleFromCluster } from '../PrinciplePromotion.js'
import { claimAnchorsForExperience, evaluatePromotion } from '../PrincipleConvergence.js'
import type { ExperienceEntry, PhysicalAnchorEntry } from '../types.js'

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-anchor-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function writeAnchor(store: PhysicalAnchorStore, over: Partial<PhysicalAnchorEntry> = {}): Promise<string> {
  return store.write({
    domain: 'locomotion', scope: 'robot', title: over.title ?? 'actuator lag',
    fact: over.fact ?? 'actuator latency ≈ 8ms under load', implication: 'budget latency',
    tags: [], confidenceTier: over.confidenceTier ?? 'observed', evidenceRefs: [],
    principleIds: over.principleIds,
    ...over,
  } as Omit<PhysicalAnchorEntry, 'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'>)
}

async function writeExperience(store: ExperienceStore, over: Partial<ExperienceEntry> = {}): Promise<string> {
  return store.write({
    domain: 'locomotion', title: 't', tags: [], difficulty: 'high',
    problem: 'p', solution: 's',
    outcome: over.outcome ?? { success: true, summary: 'ok' },
    abstractPrinciple: 'bound latency', confidenceTier: 'observed',
    observationCount: 1, contradictionCount: 0,
    robot: over.robot, anchorIds: over.anchorIds,
    ...over,
  } as Omit<ExperienceEntry, 'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'>)
}

// ─────────────────────────────────────────────────────────────────────────────
// PhysicalAnchorStore signal methods + score
// ─────────────────────────────────────────────────────────────────────────────

describe('PhysicalAnchorStore signals', () => {
  it('records observation/contradiction and back-links principles', async () => {
    const store = new PhysicalAnchorStore(await tempDir())
    const id = await writeAnchor(store)
    expect((await store.recordObservation(id))?.observationCount).toBe(1)
    expect((await store.recordContradiction(id))?.contradictionCount).toBe(1)
    expect(await store.appendPrincipleReference(id, 'pr_x_00000001')).toBe(true)
    expect(await store.appendPrincipleReference(id, 'pr_x_00000001')).toBe(true) // idempotent
    const loaded = await store.load(id)
    expect(loaded?.principleIds).toEqual(['pr_x_00000001'])
    expect(await store.recordObservation('pa_bogus_00000000')).toBeNull()
  })

  it('sinks a contradicted anchor below a clean one in search', async () => {
    const store = new PhysicalAnchorStore(await tempDir())
    const clean = await writeAnchor(store, { title: 'clean' })
    const bad = await writeAnchor(store, { title: 'bad' })
    await store.recordContradiction(bad)
    const results = await store.search({ domain: 'locomotion' })
    expect(results[0]?.id).toBe(clean)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// experience_write — combined distillation
// ─────────────────────────────────────────────────────────────────────────────

describe('experience_write combined distillation', () => {
  function makeTool(flashResponse: string | null) {
    const expDir = ''
    void expDir
    return async () => {
      const store = new ExperienceStore(await tempDir())
      const pending = new ExperiencePendingStore('/proj/d', await tempDir())
      const anchorStore = new PhysicalAnchorStore(await tempDir())
      const anchorPending = new PhysicalAnchorPendingStore('/proj/d', await tempDir())
      const flash = { query: vi.fn().mockResolvedValue(flashResponse) } as unknown as FlashClient
      const tool = createExperienceWriteTool(store, pending, flash, anchorStore, anchorPending)
      return { store, pending, anchorPending, tool }
    }
  }

  const validInput = {
    domain: 'locomotion', title: 'gait latency', problem: 'unstable gait',
    solution: 'bound latency', success: true, outcome_summary: 'stabilized',
  }

  it('extracts principle and queues a strict anchor candidate', async () => {
    const { pending, anchorPending, tool } = await makeTool(JSON.stringify({
      abstract_principle: 'bound latency vs control freq',
      anchors: [{ title: 'go2 latency', domain: 'locomotion', scope: 'robot', fact: 'latency ≈ 8ms', implication: 'budget it', confidence_tier: 'observed', evidence_refs: [] }],
    }))()
    await tool.call(validInput, {})
    expect(pending.list()[0]!.input['abstract_principle']).toBe('bound latency vs control freq')
    expect(anchorPending.count).toBe(1)
    await pending.flush(); await anchorPending.flush()
  })

  it('caps anchor candidates at 2', async () => {
    const mk = (n: number) => ({ title: `a${n}`, domain: 'locomotion', scope: 'robot', fact: `fact ${n}`, implication: 'i', confidence_tier: 'observed', evidence_refs: [] })
    const { anchorPending, tool } = await makeTool(JSON.stringify({
      abstract_principle: 'x', anchors: [mk(1), mk(2), mk(3)],
    }))()
    await tool.call(validInput, {})
    expect(anchorPending.count).toBe(2)
    await anchorPending.flush()
  })

  it('defaults to no anchor and still queues the experience when flash fails', async () => {
    const { pending, anchorPending, tool } = await makeTool(null)()
    await tool.call(validInput, {})
    expect(pending.count).toBe(1)
    expect(anchorPending.count).toBe(0)
    await pending.flush()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// anchor claim + contradiction propagation
// ─────────────────────────────────────────────────────────────────────────────

function anchorClaimFlash(verdicts: Array<{ id: string; verdict: string }>): FlashClient {
  return {
    query: vi.fn(async (opts: FlashQueryOpts) =>
      opts.cacheKey?.startsWith('anchor-claim:') ? JSON.stringify({ verdicts }) : null),
  } as unknown as FlashClient
}

describe('claimAnchorsForExperience', () => {
  it('corroborates an anchor on a consistent experiment and links it', async () => {
    const anchorStore = new PhysicalAnchorStore(await tempDir())
    const expStore = new ExperienceStore(await tempDir())
    const principleStore = new PrincipleStore(await tempDir())
    const aid = await writeAnchor(anchorStore)
    const exp = await expStore.load(await writeExperience(expStore))
    const signals = await claimAnchorsForExperience(exp!, expStore, anchorStore, principleStore,
      anchorClaimFlash([{ id: aid, verdict: 'corroborated' }]))
    expect(signals).toEqual([{ anchorId: aid, verdict: 'corroborated' }])
    expect((await anchorStore.load(aid))?.observationCount).toBe(1)
    expect((await expStore.load(exp!.id))?.anchorIds).toContain(aid)
  })

  it('propagates a contradiction to principles that depend on the anchor', async () => {
    const anchorStore = new PhysicalAnchorStore(await tempDir())
    const expStore = new ExperienceStore(await tempDir())
    const principleStore = new PrincipleStore(await tempDir())
    const pid = await principleStore.write({
      title: 't', statement: 's', mechanism: 'm', firstPrinciplesSupport: ['x'],
      domains: ['locomotion'], abstractionLevel: 'physical', preconditions: ['p'],
      applicabilityBounds: ['b'], nonApplicableWhen: ['n'], derivedFromExperienceIds: [],
      anchoredByPhysicalAnchorIds: [], evidenceRefs: [], invalidatedAssumptions: [],
      counterExamples: [], confidenceTier: 'observed', observationCount: 1,
      contradictionCount: 0, promotionReason: 'confidence_threshold',
    } as never)
    const aid = await writeAnchor(anchorStore, { principleIds: [pid] })
    const exp = await expStore.load(await writeExperience(expStore, { outcome: { success: false, summary: 'fact broke' } }))

    const signals = await claimAnchorsForExperience(exp!, expStore, anchorStore, principleStore,
      anchorClaimFlash([{ id: aid, verdict: 'contradicted' }]))
    expect(signals[0]?.verdict).toBe('contradicted')
    expect(signals[0]?.propagated).toContain(pid)
    expect((await anchorStore.load(aid))?.contradictionCount).toBe(1)
    expect((await principleStore.load(pid))?.contradictionCount).toBe(1)
  })

  it('links but does not signal on a neutral verdict', async () => {
    const anchorStore = new PhysicalAnchorStore(await tempDir())
    const expStore = new ExperienceStore(await tempDir())
    const principleStore = new PrincipleStore(await tempDir())
    const aid = await writeAnchor(anchorStore)
    const exp = await expStore.load(await writeExperience(expStore))
    const signals = await claimAnchorsForExperience(exp!, expStore, anchorStore, principleStore,
      anchorClaimFlash([{ id: aid, verdict: 'neutral' }]))
    expect(signals[0]?.verdict).toBe('neutral')
    expect((await anchorStore.load(aid))?.observationCount ?? 0).toBe(0)
    expect((await expStore.load(exp!.id))?.anchorIds).toContain(aid)
  })
})

describe('evaluatePromotion attaches anchor signals', () => {
  it('surfaces anchorSignals alongside the principle outcome', async () => {
    const anchorStore = new PhysicalAnchorStore(await tempDir())
    const expStore = new ExperienceStore(await tempDir())
    const principleStore = new PrincipleStore(await tempDir())
    const pendingStore = new PrinciplePendingStore('/proj/a', await tempDir())
    const aid = await writeAnchor(anchorStore)
    const expId = await writeExperience(expStore)
    const flash = {
      query: vi.fn(async (opts: FlashQueryOpts) => {
        if (opts.cacheKey?.startsWith('anchor-claim:')) return JSON.stringify({ verdicts: [{ id: aid, verdict: 'corroborated' }] })
        if (opts.cacheKey?.startsWith('principle-claim:')) return JSON.stringify({ applicable: [] })
        if (opts.cacheKey?.startsWith('principle-cluster-members:')) return JSON.stringify({ cluster: [] })
        return null
      }),
    } as unknown as FlashClient

    const res = await evaluatePromotion(expId, { experienceStore: expStore, principleStore, anchorStore, pendingStore, flash })
    expect(res.kind).toBe('none') // single experience, no convergence
    expect(res.anchorSignals?.[0]).toEqual({ anchorId: aid, verdict: 'corroborated' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// anchor_ids passthrough + cluster anchoring + commit validation
// ─────────────────────────────────────────────────────────────────────────────

describe('anchor_ids passthrough', () => {
  it('keeps only well-formed anchor IDs and commits them', async () => {
    const out = validateExperienceInput({
      domain: 'locomotion', title: 't', problem: 'p', solution: 's',
      success: true, outcome_summary: 'o',
      anchor_ids: ['pa_abc123_0011aaff', 'bad', 'pa_abc123_0011aaff'],
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.value.anchorIds).toEqual(['pa_abc123_0011aaff'])

    const store = new ExperienceStore(await tempDir())
    const pending = new ExperiencePendingStore('/proj/p', await tempDir())
    pending.add({ domain: 'locomotion', title: 't', problem: 'p', solution: 's', success: true, outcome_summary: 'o', anchor_ids: ['pa_abc123_0011aaff'] })
    const id = await pending.commit(pending.list()[0]!.pendingId, store)
    expect((await store.load(id!))?.anchorIds).toEqual(['pa_abc123_0011aaff'])
    await pending.flush()
  })
})

describe('proposePrincipleFromCluster grounds on shared anchors', () => {
  it('fills anchored_by from cluster experiences anchorIds', async () => {
    const anchorStore = new PhysicalAnchorStore(await tempDir())
    const pendingStore = new PrinciplePendingStore('/proj/c', await tempDir())
    const aid = await writeAnchor(anchorStore)
    const cluster = [
      { id: 'exp_1', domain: 'locomotion', outcome: { success: true, summary: 'o' }, anchorIds: [aid] },
      { id: 'exp_2', domain: 'locomotion', outcome: { success: true, summary: 'o' }, anchorIds: [aid] },
      { id: 'exp_3', domain: 'locomotion', outcome: { success: true, summary: 'o' } },
    ] as ExperienceEntry[]
    const flash = {
      query: vi.fn().mockResolvedValue(JSON.stringify({
        promote: true, title: 't', statement: 's', mechanism: 'm',
        first_principles_support: ['x'], domains: ['locomotion'], abstraction_level: 'system',
        preconditions: ['p'], applicability_bounds: ['b'], non_applicable_when: ['n'],
      })),
    } as unknown as FlashClient

    const res = await proposePrincipleFromCluster({
      cluster, trigger: cluster[0], anchorStore, pendingStore, flash, tier: 'observed',
    })
    expect(res.promoted).toBe(true)
    expect(pendingStore.list()[0]!.input['anchored_by_physical_anchor_ids']).toEqual([aid])
    await pendingStore.flush()
  })
})

describe('PrinciplePendingStore.commit anchor validation + backlink', () => {
  it('drops dangling anchor IDs and back-links the real one', async () => {
    const anchorStore = new PhysicalAnchorStore(await tempDir())
    const principleStore = new PrincipleStore(await tempDir())
    const pending = new PrinciplePendingStore('/proj/v', await tempDir())
    const aid = await writeAnchor(anchorStore)
    pending.add({
      title: 't', statement: 's', mechanism: 'm', first_principles_support: ['x'],
      domains: ['locomotion'], abstraction_level: 'physical', preconditions: ['p'],
      applicability_bounds: ['b'], non_applicable_when: ['n'],
      anchored_by_physical_anchor_ids: [aid, 'pa_bogus_00000000'],
      promotion_reason: 'confidence_threshold', source_experience_id: 'exp_1',
    })
    const id = await pending.commit(pending.list()[0]!.pendingId, principleStore, undefined, anchorStore)
    expect(id).toBeTruthy()
    expect((await principleStore.load(id!))?.anchoredByPhysicalAnchorIds).toEqual([aid])
    expect((await anchorStore.load(aid))?.principleIds).toContain(id)
    await pending.flush()
  })
})
