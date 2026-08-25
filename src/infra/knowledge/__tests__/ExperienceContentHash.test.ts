/**
 * The content hash is a cross-version contract: trajectories record it, and a
 * later analysis compares it against the store to answer "which version of this
 * lesson did that run actually see". Two properties therefore have to hold, and
 * they pull in opposite directions:
 *
 *   1. It must NOT move when bookkeeping moves (or every touch looks like a
 *      rewrite and the signal is worthless).
 *   2. It MUST move when anything the model saw, or anything the ranker used,
 *      moves (or two different exposures become indistinguishable).
 *
 * The retrieval-path test is the one that would have bitten us: `search()`
 * returns fullReport-stripped entries and `load()` does not.
 */
import { describe, expect, it } from 'vitest'
import {
  experienceContentHash,
  experienceCanonicalForm,
  principleContentHash,
  physicalAnchorContentHash,
} from '../contentHash.js'
import type { ExperienceEntry } from '../types.js'
import type { PhysicalAnchorEntry, PrincipleEntry } from '../../../robotics/types.js'

function entry(overrides: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return {
    id: 'exp_1700000000000_abcd1234',
    schemaVersion: '1.0',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    domain: 'perception',
    tags: ['voxel', 'memory'],
    difficulty: 'medium',
    title: 'OOM in point cloud voxelisation',
    problem: 'Grid resolution too fine for a 50m map',
    solution: 'Coarsen voxel size to 5cm',
    outcome: {
      success: false,
      summary: 'Ran out of memory during voxelisation',
      failureReason: 'Grid resolution too fine',
      workarounds: ['Coarsen voxel size', 'Reduce map extent'],
    },
    ...overrides,
  }
}

describe('experienceContentHash', () => {
  it('produces a 64-hex digest matching the schema constraint', () => {
    // InjectedKnowledgeEntrySchema pins contentHash to /^[a-f0-9]{64}$/ — a
    // hash that does not satisfy it would be rejected at the emit site.
    expect(experienceContentHash(entry())).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is stable across repeated computation', () => {
    expect(experienceContentHash(entry())).toBe(experienceContentHash(entry()))
  })

  // ── Property 1: bookkeeping must not move the hash ────────────────────────

  it('ignores id, timestamps and linkage fields', () => {
    const base = experienceContentHash(entry())
    const bookkeepingOnly = entry({
      id: 'exp_1799999999999_zzzz9999',
      createdAt: 1,
      updatedAt: 2,
      lastVerifiedAt: 3,
      sourceTaskId: 'task-9',
      sourceSessionId: 'session-9',
      principleIds: ['p-1'],
      anchorIds: ['a-1'],
    })
    expect(experienceContentHash(bookkeepingOnly)).toBe(base)
  })

  it('is independent of the retrieval path that produced the entry', () => {
    // store.search() strips fullReport; store.load() keeps it. Injection goes
    // through search(), so a fullReport-sensitive hash would disagree with the
    // one an auditor later computes from load(). This is why the field is out.
    const stripped = entry()
    const full = entry({ fullReport: '# Full report\n\nLots of detail.' })
    expect(experienceContentHash(full)).toBe(experienceContentHash(stripped))
  })

  it('treats an absent field and an explicit undefined identically', () => {
    // Older entries simply lack these keys; newer code paths may set them to
    // undefined. Both must hash alike or the corpus splits on schema age.
    expect(experienceContentHash(entry({ algorithm: undefined })))
      .toBe(experienceContentHash(entry()))
  })

  it('treats a defaulted count and an explicit default identically', () => {
    // ExperienceSource.toMatch surfaces observationCount ?? 1, so an entry
    // written before the field existed is rendered exactly like one carrying 1.
    expect(experienceContentHash(entry({ observationCount: 1, contradictionCount: 0 })))
      .toBe(experienceContentHash(entry()))
  })

  it('does not depend on metrics key order', () => {
    const a = entry({ metrics: { latencyMs: 12, memoryMb: 900 } })
    const b = entry({ metrics: { memoryMb: 900, latencyMs: 12 } })
    expect(experienceContentHash(a)).toBe(experienceContentHash(b))
  })

  // ── Property 2: anything the model or the ranker saw must move it ─────────

  it.each([
    ['title',              { title: 'Different title' }],
    ['problem',            { problem: 'Different problem' }],
    ['solution',           { solution: 'Different solution' }],
    ['domain',             { domain: 'control' as ExperienceEntry['domain'] }],
    ['algorithm',          { algorithm: 'icp' }],
    ['robot',              { robot: 'g1' }],
    ['tags',               { tags: ['voxel'] }],
    ['difficulty',         { difficulty: 'high' as const }],
    ['abstractPrinciple',  { abstractPrinciple: 'Estimate memory first.' }],
    ['confidenceTier',     { confidenceTier: 'reproduced' as ExperienceEntry['confidenceTier'] }],
    ['evidenceRefs',       { evidenceRefs: ['log://run-1'] }],
    ['invalidatedAssumptions', { invalidatedAssumptions: ['dense maps are cheap'] }],
    ['metrics',            { metrics: { memoryMb: 901 } }],
    ['relatedPapers',      { relatedPapers: ['arxiv:1234'] }],
  ])('moves when %s changes', (_field, overrides) => {
    expect(experienceContentHash(entry(overrides as Partial<ExperienceEntry>)))
      .not.toBe(experienceContentHash(entry()))
  })

  it('moves when the outcome body changes', () => {
    const base = experienceContentHash(entry())
    expect(experienceContentHash(entry({
      outcome: { ...entry().outcome, summary: 'Something else happened' },
    }))).not.toBe(base)
    expect(experienceContentHash(entry({
      outcome: { ...entry().outcome, success: true },
    }))).not.toBe(base)
  })

  it('moves when observation or contradiction counts change', () => {
    // Not a word of the lesson changed, but the injected block renders
    // "Confidence: observed (3 observations)" and the ranker scores it
    // differently — a run that saw that did not see the same thing.
    const base = experienceContentHash(entry())
    expect(experienceContentHash(entry({ observationCount: 3 }))).not.toBe(base)
    expect(experienceContentHash(entry({ contradictionCount: 1 }))).not.toBe(base)
  })

  it('moves when workarounds are reordered', () => {
    // Order survives into the rendered block, so it is content, not noise.
    expect(experienceContentHash(entry({
      outcome: { ...entry().outcome, workarounds: ['Reduce map extent', 'Coarsen voxel size'] },
    }))).not.toBe(experienceContentHash(entry()))
  })

  it('distinguishes an empty list from an absent one', () => {
    expect(experienceContentHash(entry({ evidenceRefs: [] })))
      .not.toBe(experienceContentHash(entry()))
  })

  it('hashes identical content under different ids alike', () => {
    // Deliberate: duplicate knowledge should be visible as duplicate rather
    // than hidden behind two ids.
    expect(experienceContentHash(entry({ id: 'exp_1700000000001_bbbb2222' })))
      .toBe(experienceContentHash(entry()))
  })

  it('carries the version tag in the hashed bytes', () => {
    // The version is inside the input, so a future field-list change can never
    // collide with a hash produced by this version.
    expect(experienceCanonicalForm(entry())).toContain('exp-content-1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Principles and physical anchors (G0-3)
// ─────────────────────────────────────────────────────────────────────────────

function principle(overrides: Partial<PrincipleEntry> = {}): PrincipleEntry {
  return {
    id: 'pr_1700000000000_abcd1234',
    schemaVersion: '1.0',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    title: 'Estimate peak memory before allocating grids',
    statement: 'Spatial resolution × extent determines peak memory.',
    mechanism: 'Cell count grows cubically with inverse resolution.',
    firstPrinciplesSupport: ['Volume scales with r^-3'],
    domains: ['perception'],
    abstractionLevel: 'mechanism',
    preconditions: [],
    applicabilityBounds: ['dense grids'],
    nonApplicableWhen: ['sparse octrees'],
    derivedFromExperienceIds: [],
    anchoredByPhysicalAnchorIds: [],
    evidenceRefs: [],
    invalidatedAssumptions: [],
    counterExamples: [],
    confidenceTier: 'reproduced',
    observationCount: 3,
    contradictionCount: 0,
    promotionReason: 'confidence_threshold',
    ...overrides,
  } as PrincipleEntry
}

function anchor(overrides: Partial<PhysicalAnchorEntry> = {}): PhysicalAnchorEntry {
  return {
    id: 'pa_1700000000000_abcd1234',
    schemaVersion: '1.0',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    domain: 'hardware_interface',
    scope: 'robot',
    title: 'J3 torque ceiling',
    fact: 'Joint 3 saturates at 40 Nm.',
    implication: 'Plans requiring more will stall silently.',
    tags: ['torque'],
    confidenceTier: 'reproduced',
    evidenceRefs: ['datasheet://j3'],
    ...overrides,
  } as PhysicalAnchorEntry
}

describe('principleContentHash', () => {
  it('produces a 64-hex digest', () => {
    expect(principleContentHash(principle())).toMatch(/^[a-f0-9]{64}$/)
  })

  it('ignores identity, timestamps and non-rendered bookkeeping', () => {
    const base = principleContentHash(principle())
    expect(principleContentHash(principle({
      id: 'pr_1799999999999_zzzz9999',
      createdAt: 1,
      updatedAt: 2,
      lastVerifiedAt: 3,
      // Neither renderer prints these two.
      promotionReason: 'explicit_user_request',
      sourceExperienceId: 'exp_1',
    }))).toBe(base)
  })

  it.each([
    ['statement',   { statement: 'Something else entirely.' }],
    ['mechanism',   { mechanism: 'A different reason.' }],
    ['bounds',      { applicabilityBounds: ['sparse grids'] }],
    ['support',     { firstPrinciplesSupport: [] }],
    ['confidence',  { confidenceTier: 'observed' as PrincipleEntry['confidenceTier'] }],
    ['observations', { observationCount: 9 }],
    ['linked anchors', { anchoredByPhysicalAnchorIds: ['pa_1'] }],
  ])('moves when %s changes', (_field, overrides) => {
    expect(principleContentHash(principle(overrides as Partial<PrincipleEntry>)))
      .not.toBe(principleContentHash(principle()))
  })
})

describe('physicalAnchorContentHash', () => {
  it('produces a 64-hex digest', () => {
    expect(physicalAnchorContentHash(anchor())).toMatch(/^[a-f0-9]{64}$/)
  })

  it('ignores identity and creation time', () => {
    // createdAt is rendered by physical_anchor_load but is fixed at creation,
    // so excluding it can never make two versions of one anchor collide.
    expect(physicalAnchorContentHash(anchor({
      id: 'pa_1799999999999_zzzz9999',
      createdAt: 1,
      updatedAt: 2,
    }))).toBe(physicalAnchorContentHash(anchor()))
  })

  it('moves when lastVerifiedAt changes', () => {
    // The exception to the timestamp rule, and the reason the rule is phrased
    // as "mutable" rather than "not a timestamp": the anchor renderer prints
    // this, and for a physical fact how recently it was checked is the claim.
    expect(physicalAnchorContentHash(anchor({ lastVerifiedAt: 1_800_000_000_000 })))
      .not.toBe(physicalAnchorContentHash(anchor()))
  })

  it.each([
    ['fact',        { fact: 'Joint 3 saturates at 55 Nm.' }],
    ['implication', { implication: 'Plans will now report an error.' }],
    ['mechanism',   { mechanism: 'Thermal derating in the driver.' }],
    ['scope',       { scope: 'global' as PhysicalAnchorEntry['scope'] }],
    ['robot',       { robot: 'g1' }],
    ['source',      { source: 'vendor datasheet rev B' }],
    ['contradictions', { contradictionCount: 2 }],
  ])('moves when %s changes', (_field, overrides) => {
    expect(physicalAnchorContentHash(anchor(overrides as Partial<PhysicalAnchorEntry>)))
      .not.toBe(physicalAnchorContentHash(anchor()))
  })

  it('treats defaulted counts as the renderer does', () => {
    expect(physicalAnchorContentHash(anchor({ observationCount: 0, contradictionCount: 0 })))
      .toBe(physicalAnchorContentHash(anchor()))
  })
})

describe('hash domains do not collide', () => {
  it('gives the three knowledge kinds independent hash spaces', () => {
    // A principle and an experience that happen to share a title must not hash
    // alike — entryId plus contentHash is the identity, and the kinds live in
    // one trajectory stream together.
    const shared = 'Estimate peak memory before allocating grids'
    expect(principleContentHash(principle({ title: shared })))
      .not.toBe(physicalAnchorContentHash(anchor({ title: shared })))
  })
})
