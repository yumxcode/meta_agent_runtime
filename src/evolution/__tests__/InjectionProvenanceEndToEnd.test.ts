/**
 * The G0 acceptance criterion, end to end, against a real store.
 *
 * "一次带自动注入的运行，轨迹里能查到五个状态的记录，entryId + contentHash 与
 * ExperienceStore 对得上，contextHash 可对账。"
 *
 * The unit tests above all feed the builder hand-made traces, which proves the
 * builder and proves nothing about the chain. This one runs the real path —
 * ExperienceStore → ExperienceSource → ExperienceWorkingSetManager →
 * ContextPager → builder — and then does the reconciliation an auditor would
 * actually perform: take the contentHash out of the trajectory item, recompute
 * it from the stored entry, and require them to match.
 */
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ExperienceStore } from '../../infra/knowledge/ExperienceStore.js'
import { experienceContentHash } from '../../infra/knowledge/contentHash.js'
import { ExperienceSource } from '../../context/sources/ExperienceSource.js'
import { ExperienceWorkingSetManager } from '../../robotics/ExperienceWorkingSet.js'
import { ContextPager } from '../../context/ContextPager.js'
import { buildInjectionProvenanceItems } from '../InjectionProvenance.js'
import { KnowledgeItemSchema } from '../../trajectory/types.js'
import type { QueryIntent } from '../../context/QueryAnalyzer.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function seededStore(): Promise<{ store: ExperienceStore; entryId: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-injprov-'))
  tempDirs.push(dir)
  const store = new ExperienceStore(dir)
  const entryId = await store.write({
    domain: 'perception',
    title: 'Voxel grid OOM at 5cm resolution',
    tags: ['voxel', 'memory'],
    difficulty: 'medium',
    problem: 'Voxelising a 50m map at 5cm exhausted RAM',
    solution: 'Coarsen to 10cm and stream tiles',
    outcome: {
      success: false,
      summary: 'Ran out of memory during voxelisation',
      failureReason: 'Grid resolution too fine for the map extent',
      workarounds: ['Coarsen voxel size', 'Stream tiles'],
    },
    abstractPrinciple: 'Spatial resolution × map size determines peak memory.',
  })
  return { store, entryId }
}

const INTENT: QueryIntent = {
  intent: 'debug',
  domains: ['perception'],
  searchKeywords: ['voxel'],
  hasHardware: false,
} as QueryIntent

async function runOneTurn(store: ExperienceStore) {
  const pager = new ContextPager({ maxBudget: 1500 })
  const manager = new ExperienceWorkingSetManager({
    experienceSource: new ExperienceSource(store),
    contextPager: pager,
    // No flash client: selection falls back to local ranking, which is a real
    // production path (no API key) and keeps the test free of model stubs.
    flashClient: null,
    robot: undefined,
  })

  await manager.preload('why did the voxel grid run out of memory', INTENT)
  const rendered = pager.renderForTurn()
  const preload = manager.lastPreloadTrace!

  const items = buildInjectionProvenanceItems({
    selection: {
      queryHash: preload.queryHash,
      selectorVersion: preload.selectorVersion,
      candidateSource: preload.candidateSource,
      judgementObtained: false,
      pool: preload.pool,
      selectedEntryIds: preload.injectedIds,
      checkoutRejected: preload.checkoutRejected,
    },
    render: pager.lastRenderTrace,
    drops: pager.drainDrops(),
  })

  return { items, rendered, pager }
}

describe('injection provenance — real store to trajectory item', () => {
  it('records the entry that was injected, and every state is queryable', async () => {
    const { store } = await seededStore()
    const { items } = await runOneTurn(store)

    const actions = items.map(item => item.action)
    // recalled (store was queried) → selected (local ranking chose it) →
    // injected (the pager rendered it). eligible lives on the selected item as
    // a reason code, and rendered coincides with injected at the emit point.
    expect(actions).toEqual(['recalled', 'selected', 'injected'])
    for (const item of items) {
      expect(() => KnowledgeItemSchema.parse(item)).not.toThrow()
    }
  })

  it('reconciles entryId + contentHash back to the stored entry', async () => {
    // This is the acceptance check: an auditor holding only the trajectory item
    // must be able to find the entry and confirm which version was injected.
    const { store, entryId } = await seededStore()
    const { items } = await runOneTurn(store)

    const injected = items.find(item => item.action === 'injected')!
    const record = injected.injected!.find(entry => entry.entryId === entryId)
    expect(record).toBeDefined()

    const stored = await store.load(entryId)
    expect(stored).not.toBeNull()
    expect(record!.contentHash).toBe(experienceContentHash(stored!))
  })

  it('moves the recorded hash when the stored entry is rewritten', async () => {
    // The whole point of recording a hash rather than just an id: a later
    // rewrite has to be distinguishable from the version the run actually saw.
    const { store, entryId } = await seededStore()
    const before = (await runOneTurn(store)).items
      .find(item => item.action === 'injected')!.injected![0]!.contentHash

    const stored = await store.load(entryId)
    await store.delete(entryId)
    const rewrittenId = await store.write({
      ...stored!,
      abstractPrinciple: 'Estimate peak memory before allocating any grid.',
    })
    const rewritten = await store.load(rewrittenId)

    expect(experienceContentHash(rewritten!)).not.toBe(before)
  })

  it('produces a contextHash that matches the rendered block', async () => {
    const { store } = await seededStore()
    const { items, rendered } = await runOneTurn(store)

    const injected = items.find(item => item.action === 'injected')!
    expect(injected.contextHash).toBe(createHash('sha256').update(rendered).digest('hex'))
    expect(injected.tokenCost).toBeGreaterThan(0)
  })

  it('emits nothing at all when the store is empty', async () => {
    // No injection, no records — a session that never touches experience must
    // not accumulate bookkeeping lines.
    const dir = await mkdtemp(join(tmpdir(), 'meta-agent-injprov-empty-'))
    tempDirs.push(dir)
    const { items, rendered } = await runOneTurn(new ExperienceStore(dir))
    expect(items).toEqual([])
    expect(rendered).toBe('')
  })

  it('keeps injecting a slot on later turns without re-selecting it', async () => {
    // ttlTurns=4 means a slot outlives its selection. A second turn that
    // selects nothing still injects the surviving entry — the case that makes
    // injected a superset of selected, verified here against the real pager
    // rather than a hand-built trace.
    const { store, entryId } = await seededStore()
    const pager = new ContextPager({ maxBudget: 1500 })
    const manager = new ExperienceWorkingSetManager({
      experienceSource: new ExperienceSource(store),
      contextPager: pager,
      flashClient: null,
      robot: undefined,
    })

    await manager.preload('why did the voxel grid run out of memory', INTENT)
    pager.renderForTurn()
    pager.tick()

    // Second turn: an intent that matches nothing, so nothing is selected.
    await manager.preload('unrelated question about paperwork', {
      intent: 'chat', domains: [], searchKeywords: [], hasHardware: false,
    } as QueryIntent)
    pager.renderForTurn()

    const items = buildInjectionProvenanceItems({
      selection: null,
      render: pager.lastRenderTrace,
      drops: pager.drainDrops(),
    })

    const injected = items.find(item => item.action === 'injected')
    expect(injected?.entryIds).toEqual([entryId])
    // And it still points at the query that actually retrieved it.
    expect(injected?.injected?.[0]?.queryHash)
      .toBe(createHash('sha256').update('why did the voxel grid run out of memory').digest('hex').slice(0, 12))
  })
})
