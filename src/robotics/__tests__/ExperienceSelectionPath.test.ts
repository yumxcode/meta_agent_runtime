/**
 * Why the selector chose what it chose (G0-2, prerequisite A).
 *
 * Five different situations used to end at the same `return localFallback`: no
 * client, a timeout, an unreadable answer, invented ids, and an explicit "none
 * apply". The selection is identical in all five — which is exactly why the
 * reason has to be recorded rather than inferred from the outcome.
 *
 * The one that matters most is `flash_empty`. It is the only informative
 * negative in the set: the judge looked at the pool and said none applied. If
 * it is indistinguishable from a timeout, then "experience rarely applies here"
 * and "the relevance call is broken" look the same in the data.
 *
 * Every test also asserts the selection itself is unchanged: G0 records, it
 * does not steer.
 */
import { describe, expect, it } from 'vitest'
import { ExperienceWorkingSetManager } from '../ExperienceWorkingSet.js'
import { ContextPager } from '../../context/ContextPager.js'
import type { ExperienceMatch } from '../../context/sources/IKnowledgeSource.js'
import type { ExperienceSource } from '../../context/sources/ExperienceSource.js'
import type { FlashClient } from '../../core/flash/FlashClient.js'
import type { QueryIntent } from '../../context/QueryAnalyzer.js'

const HASH = 'a'.repeat(64)

function match(id: string, overrides: Partial<ExperienceMatch> = {}): ExperienceMatch {
  return {
    id,
    contentHash: HASH,
    title: `lesson ${id}`,
    domain: 'perception',
    outcome: 'failure',
    abstractPrinciple: 'Estimate memory before allocating.',
    ...overrides,
  }
}

const INTENT: QueryIntent = {
  intent: 'debug',
  domains: ['perception'],
  searchKeywords: ['voxel'],
  hasHardware: false,
} as QueryIntent

/** Scores 120 (same domain) + 70 (observed) → clears the threshold. */
const ELIGIBLE = match('exp-eligible')
/** Different domain, no keyword hit → no applicability signal at all. */
const INELIGIBLE = match('exp-ineligible', { domain: 'planning', title: 'unrelated', abstractPrinciple: 'unrelated' })

function makeManager(opts: {
  candidates: ExperienceMatch[]
  flashAnswer?: string | null
  noFlashClient?: boolean
}) {
  const source = {
    listExperiences: async () => opts.candidates,
  } as unknown as ExperienceSource

  const flashClient = opts.noFlashClient
    ? null
    : ({ query: async () => opts.flashAnswer ?? null } as unknown as FlashClient)

  return new ExperienceWorkingSetManager({
    experienceSource: source,
    contextPager: new ContextPager({ maxBudget: 1500 }),
    flashClient,
    robot: undefined,
    selectWaitBudgetMs: 50,
  })
}

async function pathFor(opts: Parameters<typeof makeManager>[0]) {
  const mgr = makeManager(opts)
  await mgr.preload('why did the voxel grid run out of memory', INTENT)
  return { path: mgr.lastPreloadTrace!.selectionPath, selected: mgr.current.map(s => s.experience.id) }
}

describe('ExperienceWorkingSet — selection path', () => {
  it('reports no_flash_client when there is no relevance pass at all', async () => {
    const { path, selected } = await pathFor({ candidates: [ELIGIBLE], noFlashClient: true })
    expect(path).toBe('no_flash_client')
    expect(selected).toEqual(['exp-eligible'])
  })

  it('reports flash_timeout when the call loses the wait budget', async () => {
    const mgr = new ExperienceWorkingSetManager({
      experienceSource: { listExperiences: async () => [ELIGIBLE] } as unknown as ExperienceSource,
      contextPager: new ContextPager({ maxBudget: 1500 }),
      flashClient: { query: () => new Promise(() => {}) } as unknown as FlashClient,
      robot: undefined,
      selectWaitBudgetMs: 20,
    })
    await mgr.preload('why did the voxel grid run out of memory', INTENT)
    expect(mgr.lastPreloadTrace!.selectionPath).toBe('flash_timeout')
    // Losing the race costs precision, not the working set.
    expect(mgr.current.map(s => s.experience.id)).toEqual(['exp-eligible'])
  })

  it('reports flash_unparseable when the answer is not readable', async () => {
    const { path, selected } = await pathFor({ candidates: [ELIGIBLE], flashAnswer: 'I think maybe the first one?' })
    expect(path).toBe('flash_unparseable')
    expect(selected).toEqual(['exp-eligible'])
  })

  it('reports flash_empty when the judge explicitly declines every candidate', async () => {
    // The informative negative. Same fallback selection as a timeout, opposite
    // meaning — this is the distinction the whole change exists to preserve.
    const { path, selected } = await pathFor({ candidates: [ELIGIBLE], flashAnswer: '{"applicable":[]}' })
    expect(path).toBe('flash_empty')
    expect(selected).toEqual(['exp-eligible'])
  })

  it('reports flash_invalid_ids when the judge names entries that do not exist', async () => {
    // A hallucinated id set is a malfunction, not a judgement, and it is not
    // the same malfunction as an unreadable answer.
    const { path } = await pathFor({ candidates: [ELIGIBLE], flashAnswer: '{"applicable":["exp-does-not-exist"]}' })
    expect(path).toBe('flash_invalid_ids')
  })

  it('reports flash_selected when the judge picks something', async () => {
    const { path, selected } = await pathFor({
      candidates: [ELIGIBLE, INELIGIBLE],
      flashAnswer: '{"applicable":["exp-ineligible"]}',
    })
    expect(path).toBe('flash_selected')
    // The judge sees the whole pool, threshold included: it can and does select
    // entries local ranking would have discarded.
    expect(selected).toEqual(['exp-ineligible'])
  })

  it('reports no_candidates when the store returned nothing', async () => {
    const { path, selected } = await pathFor({ candidates: [] })
    expect(path).toBe('no_candidates')
    expect(selected).toEqual([])
  })

  it('reports preload_error when the pool could not be read', async () => {
    // Distinct from no_candidates: the pool is unknown, not empty.
    const mgr = new ExperienceWorkingSetManager({
      experienceSource: { listExperiences: async () => { throw new Error('store unavailable') } } as unknown as ExperienceSource,
      contextPager: new ContextPager({ maxBudget: 1500 }),
      flashClient: null,
      robot: undefined,
    })
    await mgr.preload('why did the voxel grid run out of memory', INTENT)
    expect(mgr.lastPreloadTrace!.selectionPath).toBe('preload_error')
  })
})

describe('ExperienceWorkingSet — candidate eligibility is recorded, not pre-filtered', () => {
  it('keeps the local threshold verdict for every candidate in the pool', async () => {
    // Both definitions of "eligible" stay recoverable: the local route treats
    // this flag as the gate, the judge route ignores it entirely. Recording the
    // raw verdict avoids freezing one definition into the trajectory.
    const mgr = makeManager({
      candidates: [ELIGIBLE, INELIGIBLE],
      flashAnswer: '{"applicable":["exp-eligible"]}',
    })
    await mgr.preload('why did the voxel grid run out of memory', INTENT)

    const pool = mgr.lastPreloadTrace!.pool
    expect(pool).toHaveLength(2)
    const verdicts = Object.fromEntries(pool.map(c => [c.entryId, c.eligibleByThreshold]))
    expect(verdicts).toEqual({ 'exp-eligible': true, 'exp-ineligible': false })
  })

  it('carries the content hash through to the trace', async () => {
    const mgr = makeManager({ candidates: [ELIGIBLE], noFlashClient: true })
    await mgr.preload('why did the voxel grid run out of memory', INTENT)
    expect(mgr.lastPreloadTrace!.pool[0]!.contentHash).toBe(HASH)
  })

  it('stamps slots with the query that retrieved them and the effective selector', async () => {
    const pager = new ContextPager({ maxBudget: 1500 })
    const mgr = new ExperienceWorkingSetManager({
      experienceSource: { listExperiences: async () => [ELIGIBLE] } as unknown as ExperienceSource,
      contextPager: pager,
      flashClient: null,
      robot: undefined,
    })
    await mgr.preload('why did the voxel grid run out of memory', INTENT)
    pager.renderForTurn()

    const rendered = pager.lastRenderTrace!.rendered[0]!
    expect(rendered.provenance?.entryId).toBe('exp-eligible')
    expect(rendered.provenance?.queryHash).toBe(mgr.lastPreloadTrace!.queryHash)
    // The route is part of the effective selector identity.
    expect(rendered.provenance?.selectorVersion).toBe('working-set-v1/no_flash_client')
  })
})

describe('ExperienceWorkingSet — refused checkouts are reported', () => {
  it('records a selection the pager refused instead of losing it', async () => {
    // Pre-existing behaviour: an experience larger than the whole budget is
    // dropped and the model never sees it. The drop is unchanged; it is now
    // visible in the trace.
    const big = match('exp-big', {
      abstractPrinciple: 'x'.repeat(20_000),
    })
    const mgr = new ExperienceWorkingSetManager({
      experienceSource: { listExperiences: async () => [big] } as unknown as ExperienceSource,
      contextPager: new ContextPager({ maxBudget: 100 }),
      flashClient: null,
      robot: undefined,
    })
    await mgr.preload('why did the voxel grid run out of memory', INTENT)

    expect(mgr.lastPreloadTrace!.checkoutRejected.map(c => c.entryId)).toEqual(['exp-big'])
    // Still selected — the selector's verdict did not change.
    expect(mgr.current.map(s => s.experience.id)).toEqual(['exp-big'])
  })
})
