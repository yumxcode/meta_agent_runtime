/**
 * preload() must not hold the user's turn hostage to the relevance LLM call.
 *
 * `RoboticsSession.submit()` awaits the intent (which races a 5s budget) and
 * then awaits `preload()` — which awaited its flash query with NO budget at
 * all, under the client's derived ~41s timeout. So the code took great care to
 * bound the first side-call on the critical path and then handed control to an
 * unbounded second one, on the same path, one line later.
 *
 * `localFallback` is computed before the call either way, so losing the race
 * costs precision (locally-ranked instead of LLM-selected), never correctness.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExperienceWorkingSetManager } from '../ExperienceWorkingSet.js'
import { ExperienceStore } from '../ExperienceStore.js'
import { ExperienceSource } from '../../context/sources/ExperienceSource.js'
import { ContextPager } from '../../context/ContextPager.js'
import type { FlashClient } from '../../core/flash/FlashClient.js'
import type { QueryIntent } from '../../context/QueryAnalyzer.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function storeWithExperiences(n: number): Promise<ExperienceStore> {
  const dir = await mkdtemp(join(tmpdir(), 'ews-budget-'))
  dirs.push(dir)
  const store = new ExperienceStore(dir)
  for (let i = 0; i < n; i++) {
    await store.write({
      domain: 'locomotion',
      title: `latency experiment ${i}`,
      tags: [],
      difficulty: 'high',
      problem: 'gait unstable when perception latency rises',
      solution: 'bound end-to-end latency before raising gait speed',
      outcome: { success: true, summary: 'bounded latency stabilized gait' },
      abstractPrinciple: 'bound latency relative to control frequency',
      confidenceTier: 'observed',
      observationCount: 3,
      contradictionCount: 0,
    } as never)
  }
  return store
}

const INTENT: QueryIntent = {
  domains: ['locomotion'],
  hasHardware: false,
  hasSimulation: false,
  searchKeywords: ['latency', 'gait'],
  intent: 'debug',
}

function managerWith(
  store: ExperienceStore,
  flashClient: FlashClient | null,
  selectWaitBudgetMs?: number,
): ExperienceWorkingSetManager {
  return new ExperienceWorkingSetManager({
    experienceSource: new ExperienceSource(store),
    contextPager: new ContextPager({ maxBudget: 1500 }),
    flashClient,
    robot: undefined,
    ...(selectWaitBudgetMs !== undefined ? { selectWaitBudgetMs } : {}),
  })
}

describe('preload wait budget', () => {
  it('returns within the budget when the relevance call hangs', async () => {
    const store = await storeWithExperiences(3)
    // Never resolves — exactly what a 41s-timeout call looks like from here.
    const flash = { query: () => new Promise<string | null>(() => {}) } as unknown as FlashClient
    const mgr = managerWith(store, flash, 40)

    const started = Date.now()
    await mgr.preload('步态延迟又变高了', INTENT)
    const elapsed = Date.now() - started

    // Pre-fix this awaited the full derived flash timeout (~41s).
    expect(elapsed).toBeLessThan(1_000)
  }, 20_000)

  it('falls back to the locally-ranked selection rather than to nothing', async () => {
    const store = await storeWithExperiences(3)
    const flash = { query: () => new Promise<string | null>(() => {}) } as unknown as FlashClient
    const mgr = managerWith(store, flash, 40)

    await mgr.preload('步态延迟又变高了', INTENT)
    // Losing the race costs precision, not the whole working set: the trace
    // shows candidates were still fetched and considered.
    expect(mgr.lastPreloadTrace?.candidateCount).toBeGreaterThan(0)
  }, 20_000)

  it('uses the LLM selection when it answers in time', async () => {
    const store = await storeWithExperiences(3)
    const ids = (await new ExperienceSource(store).listExperiences({ limit: 5 })).map(e => e.id)
    const flash = {
      query: async () => JSON.stringify({ applicable: [ids[0]] }),
    } as unknown as FlashClient
    const mgr = managerWith(store, flash, 5_000)

    await mgr.preload('步态延迟又变高了', INTENT)
    expect(mgr.current.map(s => s.experience.id)).toEqual([ids[0]])
  })

  it('marks the call speculative so a lost race cannot warn per turn', async () => {
    const store = await storeWithExperiences(2)
    let seen: Record<string, unknown> | undefined
    const flash = {
      query: async (o: unknown) => { seen = o as Record<string, unknown>; return null },
    } as unknown as FlashClient

    await managerWith(store, flash, 200).preload('步态延迟', INTENT)
    expect(seen?.['speculative']).toBe(true)
    expect(seen?.['label']).toBe('experience-working-set')
    // Still no pinned timeout — the derived budget governs the background run.
    expect(seen?.['timeoutMs']).toBeUndefined()
  })

  it('works with no flash client at all', async () => {
    const store = await storeWithExperiences(2)
    const mgr = managerWith(store, null, 40)
    await mgr.preload('步态延迟', INTENT)
    expect(mgr.lastPreloadTrace?.candidateSource).toBe('store')
  })

  it('a null intent short-circuits without touching flash', async () => {
    const store = await storeWithExperiences(2)
    let called = 0
    const flash = { query: async () => { called++; return null } } as unknown as FlashClient
    const mgr = managerWith(store, flash, 40)
    await mgr.preload('随便说点什么', null)
    expect(called).toBe(0)
    expect(mgr.lastPreloadTrace?.candidateSource).toBe('none')
  })
})
