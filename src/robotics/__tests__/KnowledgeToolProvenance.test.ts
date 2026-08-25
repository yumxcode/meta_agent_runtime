/**
 * The explicit knowledge channel (G0-3).
 *
 * All six tools used to record `action: 'recalled'`. For the three search tools
 * that is true but incomplete; for the three load tools it is simply wrong —
 * nothing is retrieved, the model already has the id, and the call drops an
 * entire entry into context. A query for "what was this run exposed to" that
 * filters on `injected` therefore skipped every entry the model fetched itself.
 *
 * What is pinned here:
 *
 *   - load emits `injected` and no longer claims a recall;
 *   - search still emits its `recalled` item unchanged, and adds an `injected`
 *     one because these tools print entry bodies rather than an index;
 *   - a search that found nothing injects nothing;
 *   - every emitted hash reconciles against the store it came from.
 */
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ExperienceStore } from '../ExperienceStore.js'
import { PrincipleStore } from '../PrincipleStore.js'
import { PhysicalAnchorStore } from '../PhysicalAnchorStore.js'
import { createExperienceLoadTool } from '../tools/experience_load/index.js'
import { createExperienceSearchTool } from '../tools/experience_search/index.js'
import { createPrincipleLoadTool } from '../tools/principle_load/index.js'
import { createPrincipleSearchTool } from '../tools/principle_search/index.js'
import { createPhysicalAnchorLoadTool } from '../tools/physical_anchor_load/index.js'
import { createPhysicalAnchorSearchTool } from '../tools/physical_anchor_search/index.js'
import {
  experienceContentHash,
  principleContentHash,
  physicalAnchorContentHash,
} from '../../infra/knowledge/contentHash.js'
import { KnowledgeItemSchema } from '../../trajectory/types.js'
import { reduceTrajectoryLine } from '../../reviewer/TrajectoryReviewScanner.js'
import type { PreservedTrajectoryLine, TrajectoryItem } from '../../trajectory/types.js'
import type { ToolResult } from '../../core/types.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `meta-agent-${prefix}-`))
  tempDirs.push(dir)
  return dir
}

type KnowledgeItem = Extract<TrajectoryItem, { type: 'knowledge' }>

function items(result: ToolResult): KnowledgeItem[] {
  return (result.trajectoryItems ?? []) as KnowledgeItem[]
}

function pick(result: ToolResult, action: string): KnowledgeItem | undefined {
  return items(result).find(item => item.action === action)
}

async function seedExperience() {
  const store = new ExperienceStore(await tempDir('exp'))
  const id = await store.write({
    domain: 'perception',
    tags: ['voxel'],
    difficulty: 'medium',
    title: 'Voxel grid OOM',
    problem: 'Voxelising a 50m map at 5cm exhausted RAM',
    solution: 'Coarsen to 10cm',
    outcome: { success: false, summary: 'Out of memory', failureReason: 'Resolution too fine' },
    fullReport: '# Report\n\nDetail.',
  })
  return { store, id }
}

async function seedPrinciple() {
  const store = new PrincipleStore(await tempDir('pr'))
  const id = await store.write({
    title: 'Estimate peak memory before allocating grids',
    statement: 'Spatial resolution × extent determines peak memory.',
    mechanism: 'Cell count grows cubically with inverse resolution.',
    firstPrinciplesSupport: ['Volume scales with r^-3'],
    domains: ['perception'],
    abstractionLevel: 'mechanism',
    preconditions: [],
    applicabilityBounds: ['dense grid representations'],
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
  })
  return { store, id }
}

async function seedAnchor() {
  const store = new PhysicalAnchorStore(await tempDir('pa'))
  const id = await store.write({
    domain: 'hardware_interface',
    scope: 'robot',
    title: 'J3 torque ceiling',
    fact: 'Joint 3 saturates at 40 Nm.',
    implication: 'Plans requiring more will stall silently.',
    tags: ['torque'],
    confidenceTier: 'reproduced',
    evidenceRefs: ['datasheet://j3'],
  })
  return { store, id }
}

describe('knowledge load tools — a load is an injection', () => {
  it('experience_load records injected, not recalled', async () => {
    const { store, id } = await seedExperience()
    const result = await createExperienceLoadTool(store).call({ id })

    expect(pick(result, 'recalled')).toBeUndefined()
    const injected = pick(result, 'injected')!
    expect(injected.entryIds).toEqual([id])
    expect(injected.injected?.[0]?.selectorVersion).toBe('tool:experience_load')
  })

  it('principle_load records injected', async () => {
    const { store, id } = await seedPrinciple()
    const result = await createPrincipleLoadTool(store).call({ id })
    const injected = pick(result, 'injected')!
    expect(injected.kind).toBe('principle')
    expect(injected.injected?.[0]?.selectorVersion).toBe('tool:principle_load')
  })

  it('physical_anchor_load records injected', async () => {
    const { store, id } = await seedAnchor()
    const result = await createPhysicalAnchorLoadTool(store).call({ id })
    const injected = pick(result, 'injected')!
    expect(injected.kind).toBe('anchor')
    expect(injected.injected?.[0]?.selectorVersion).toBe('tool:physical_anchor_load')
  })

  it('reconciles the recorded hash against the stored entry', async () => {
    // The acceptance check, on the explicit channel: an auditor holding the
    // trajectory item must be able to recover which version was injected.
    const { store, id } = await seedExperience()
    const result = await createExperienceLoadTool(store).call({ id })
    const recorded = pick(result, 'injected')!.injected![0]!.contentHash
    expect(recorded).toBe(experienceContentHash((await store.load(id))!))
  })

  it('hashes the exact content handed to the model', async () => {
    // These tools declare no maxResultSizeChars, so ToolResultBudget leaves the
    // result alone and this hash really is what reached the context.
    const { store, id } = await seedAnchor()
    const result = await createPhysicalAnchorLoadTool(store).call({ id })
    expect(pick(result, 'injected')!.contextHash)
      .toBe(createHash('sha256').update(String(result.content)).digest('hex'))
    expect(pick(result, 'injected')!.tokenCost).toBeGreaterThan(0)
  })

  it('emits nothing when the entry does not exist', async () => {
    const { store } = await seedExperience()
    const result = await createExperienceLoadTool(store).call({ id: 'exp_zzzzzzzz_00000000' })
    expect(result.isError).toBe(true)
    expect(items(result)).toEqual([])
  })
})

describe('knowledge search tools — recall and injection are both true', () => {
  it('keeps the recalled item and adds an injected one', async () => {
    // The search tools print problem, solution, failure reason and workarounds
    // for every hit, so a query ran *and* bodies entered context.
    const { store, id } = await seedExperience()
    const result = await createExperienceSearchTool(store).call({ domain: 'perception' })

    const recalled = pick(result, 'recalled')!
    expect(recalled.entryIds).toEqual([id])
    expect(recalled.operation).toBe('recall')

    const injected = pick(result, 'injected')!
    expect(injected.entryIds).toEqual([id])
    expect(injected.injected?.[0]?.selectorVersion).toBe('tool:experience_search')
  })

  it('injects nothing when the search found nothing', async () => {
    // No bodies reached the context, so there is no injection to record — but
    // the query still happened and is still recorded.
    const { store } = await seedExperience()
    const result = await createExperienceSearchTool(store).call({ domain: 'locomotion' })

    expect(pick(result, 'recalled')!.entryIds).toEqual([])
    expect(pick(result, 'injected')).toBeUndefined()
  })

  it('covers principle and anchor searches the same way', async () => {
    const principle = await seedPrinciple()
    const principleResult = await createPrincipleSearchTool(principle.store).call({ domain: 'perception' })
    expect(pick(principleResult, 'recalled')).toBeDefined()
    expect(pick(principleResult, 'injected')!.injected?.[0]?.contentHash)
      .toBe(principleContentHash((await principle.store.load(principle.id))!))

    const anchor = await seedAnchor()
    const anchorResult = await createPhysicalAnchorSearchTool(anchor.store).call({ domain: 'hardware_interface' })
    expect(pick(anchorResult, 'recalled')).toBeDefined()
    expect(pick(anchorResult, 'injected')!.injected?.[0]?.contentHash)
      .toBe(physicalAnchorContentHash((await anchor.store.load(anchor.id))!))
  })

  it('leaves the recalled item byte-identical to what it always was', async () => {
    // Adding the injected record must not change the existing one: the search
    // recall shape predates this work and nothing about the query changed.
    const { store, id } = await seedExperience()
    const result = await createExperienceSearchTool(store).call({ domain: 'perception' })
    const recalled = pick(result, 'recalled')!
    expect(recalled).toEqual({
      type: 'knowledge',
      kind: 'experience',
      action: 'recalled',
      entryIds: [id],
      query: JSON.stringify({ domain: 'perception' }),
      operation: 'recall',
    })
  })
})

describe('explicit channel — schema and read side', () => {
  it('validates every emitted item and renders through the Reviewer', async () => {
    const { store, id } = await seedExperience()
    const result = await createExperienceSearchTool(store).call({ keyword: 'voxel' })

    for (const item of items(result)) {
      expect(() => KnowledgeItemSchema.parse(item)).not.toThrow()
    }

    const injected = pick(result, 'injected')!
    const line: PreservedTrajectoryLine = {
      schemaVersion: 'trajectory-line-1.0',
      ts: 1,
      ordinal: 3,
      trajectoryId: '00000000-0000-4000-8000-000000000001',
      item: injected as PreservedTrajectoryLine['item'],
      knownItem: true,
      rawLine: JSON.stringify(injected),
    }
    const text = reduceTrajectoryLine(line).text
    expect(text).toContain('knowledge experience/injected')
    expect(text).toContain('selector=tool:experience_search')
    expect(text).toContain(id)
  })

  it('keeps the model-driven channel distinguishable from the automatic one', async () => {
    // "The system decided to show this" and "the model went and fetched it" are
    // different mechanisms. An analysis that cannot separate them would credit
    // the wrong one for whatever the run did next.
    const { store, id } = await seedExperience()
    const result = await createExperienceLoadTool(store).call({ id })
    const selector = pick(result, 'injected')!.injected![0]!.selectorVersion
    expect(selector.startsWith('tool:')).toBe(true)
    expect(selector).not.toContain('working-set')
    expect(selector).not.toContain('vv-')
  })
})
