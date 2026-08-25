/**
 * Injection provenance, from traces to trajectory items.
 *
 * Three things are pinned here, in rough order of how expensive they are to get
 * wrong:
 *
 *   1. Everything emitted validates against KnowledgeItemSchema and survives
 *      the Reviewer's renderer. A record the read side cannot parse is worse
 *      than no record — it looks like coverage.
 *   2. `injected` is not `selected`. Slots outlive the selection that created
 *      them and a second producer feeds the same pager, so a turn can inject an
 *      entry it never selected. That is the case attribution gets wrong.
 *   3. A turn with no injection produces no items at all.
 */
import { describe, expect, it } from 'vitest'
import {
  buildInjectionProvenanceItems,
  INJECTION_EXCLUSION_REASONS,
  type InjectionProvenanceInput,
  type SelectionTraceInput,
} from '../InjectionProvenance.js'
import { KnowledgeItemSchema } from '../../trajectory/types.js'
import { reduceTrajectoryLine } from '../../reviewer/TrajectoryReviewScanner.js'
import type { PreservedTrajectoryLine } from '../../trajectory/types.js'
import type { PagerRenderTrace, SlotDropRecord, SlotProvenance } from '../../context/types.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)

function provenance(overrides: Partial<SlotProvenance> = {}): SlotProvenance {
  return {
    entryId: 'exp-1',
    contentHash: HASH_A,
    queryHash: 'query-1',
    selectorVersion: 'working-set-v1/flash_selected',
    ...overrides,
  }
}

function renderTrace(overrides: Partial<PagerRenderTrace> = {}): PagerRenderTrace {
  return {
    renderedAt: 1_000,
    rendered: [{
      slotId: 'experience:exp-1',
      provenance: provenance(),
      source: 'experience',
      priority: 'medium',
      tokenEst: 120,
      order: 0,
      turnsSurvived: 0,
    }],
    skippedForBudget: [],
    tokens: 120,
    contentHash: HASH_C,
    ...overrides,
  }
}

function selectionTrace(overrides: Partial<SelectionTraceInput> = {}): SelectionTraceInput {
  return {
    queryHash: 'query-1',
    selectorVersion: 'working-set-v1',
    candidateSource: 'store',
    judgementObtained: true,
    pool: [
      { entryId: 'exp-1', contentHash: HASH_A, eligibleByThreshold: true },
      { entryId: 'exp-2', contentHash: HASH_B, eligibleByThreshold: false },
    ],
    selectedEntryIds: ['exp-1'],
    checkoutRejected: [],
    ...overrides,
  }
}

function build(overrides: Partial<InjectionProvenanceInput> = {}) {
  return buildInjectionProvenanceItems({
    selection: selectionTrace(),
    render: renderTrace(),
    drops: [],
    ...overrides,
  })
}

function byAction(items: ReturnType<typeof build>, action: string) {
  return items.find(item => item.action === action)
}

describe('buildInjectionProvenanceItems — schema and read-side compatibility', () => {
  it('emits items that all validate against KnowledgeItemSchema', () => {
    // The write side has to satisfy the schema the read side already ships,
    // otherwise G0-1 and G0-2 describe two different formats.
    for (const item of build()) {
      expect(() => KnowledgeItemSchema.parse(item)).not.toThrow()
    }
  })

  it('produces content hashes the injected-entry schema accepts', () => {
    const injected = byAction(build(), 'injected')
    for (const entry of injected?.injected ?? []) {
      expect(entry.contentHash).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('renders through the Reviewer without losing the provenance', () => {
    // renderInjectionProvenance() is what a human or a later analysis actually
    // reads. Emitting records it cannot surface would be silent coverage.
    const injected = byAction(build(), 'injected')!
    const line: PreservedTrajectoryLine = {
      schemaVersion: 'trajectory-line-1.0',
      ts: 1,
      ordinal: 7,
      trajectoryId: '00000000-0000-4000-8000-000000000001',
      item: injected as PreservedTrajectoryLine['item'],
      knownItem: true,
      rawLine: JSON.stringify(injected),
    }
    const text = reduceTrajectoryLine(line).text
    expect(text).toContain('knowledge experience/injected')
    expect(text).toContain('exp-1@aaaaaaaa')
    expect(text).toContain('selector=working-set-v1/flash_selected')
    expect(text).toContain('tokens=120')
  })

  it('omits propensity when the selector is deterministic', () => {
    // assignmentProbability absent is information: writing 1.0 would let a
    // later off-policy analysis mistake a fixed selector for a logged policy.
    const injected = byAction(build(), 'injected')!
    for (const entry of injected.injected ?? []) {
      expect(entry.assignmentProbability).toBeUndefined()
    }
  })

  it('leaves versionChain empty rather than synthesising one', () => {
    // The store keeps no revision history. A one-element chain would imply
    // there is something to walk.
    const injected = byAction(build(), 'injected')!
    expect(injected.injected?.[0]?.versionChain).toEqual([])
  })
})

describe('buildInjectionProvenanceItems — no noise when nothing happened', () => {
  it('emits nothing when there is neither selection nor render', () => {
    expect(buildInjectionProvenanceItems({ selection: null, render: null, drops: [] })).toEqual([])
  })

  it('emits nothing when the candidate pool was empty', () => {
    expect(build({
      selection: selectionTrace({ pool: [], selectedEntryIds: [], candidateSource: 'none' }),
      render: null,
    })).toEqual([])
  })

  it('emits nothing when the pager rendered only slots without identity', () => {
    // Hardware profiles and query-analysis pages reach the prompt but are not
    // knowledge entries; they must not manufacture an injection record.
    const items = build({
      selection: null,
      render: renderTrace({
        rendered: [{
          slotId: 'hw:limits',
          source: 'hardware',
          priority: 'sticky',
          tokenEst: 40,
          order: 0,
          turnsSurvived: 0,
        }],
      }),
    })
    expect(items).toEqual([])
  })

  it('does not emit recalled when the cached pool was reused', () => {
    // A turn served from cache did not query the store. Recording a recall
    // would inflate every retrieval statistic computed later.
    const items = build({ selection: selectionTrace({ candidateSource: 'cache' }) })
    expect(byAction(items, 'recalled')).toBeUndefined()
    expect(byAction(items, 'selected')).toBeDefined()
  })
})

describe('buildInjectionProvenanceItems — exclusion reasons', () => {
  it('attributes unselected candidates to the judge when one ran', () => {
    const selected = byAction(build(), 'selected')!
    expect(selected.excludedCandidates).toEqual([
      { entryId: 'exp-2', contentHash: HASH_B, reasonCode: INJECTION_EXCLUSION_REASONS.NOT_SELECTED_BY_JUDGE },
    ])
  })

  it('distinguishes "no judge ran" from "the judge declined"', () => {
    // The distinction this whole module exists for: a timeout and a considered
    // rejection are opposite facts about the same empty result.
    const items = build({
      selection: selectionTrace({ judgementObtained: false, selectedEntryIds: [] }),
    })
    const codes = byAction(items, 'selected')!.excludedCandidates!.map(c => c.reasonCode)
    expect(codes).toEqual([
      INJECTION_EXCLUSION_REASONS.CROWDED_OUT_BY_RANK,   // cleared threshold, out-ranked
      INJECTION_EXCLUSION_REASONS.BELOW_SCORE_THRESHOLD, // never cleared it
    ])
    expect(codes).not.toContain(INJECTION_EXCLUSION_REASONS.NOT_SELECTED_BY_JUDGE)
  })

  it('records a selected entry the pager refused, without dropping it from entryIds', () => {
    // The pre-existing silent drop. It was selected — that is a true fact — and
    // it never reached the model, which is also true. Both are recorded.
    const items = build({
      selection: selectionTrace({
        checkoutRejected: [{ entryId: 'exp-1', contentHash: HASH_A, eligibleByThreshold: true }],
      }),
    })
    const selected = byAction(items, 'selected')!
    expect(selected.entryIds).toContain('exp-1')
    expect(selected.excludedCandidates).toContainEqual({
      entryId: 'exp-1',
      contentHash: HASH_A,
      reasonCode: INJECTION_EXCLUSION_REASONS.SLOT_OVERSIZED,
    })
  })

  it('carries pager evictions onto the injected item', () => {
    const drops: SlotDropRecord[] = [{
      slotId: 'experience:exp-9',
      provenance: provenance({ entryId: 'exp-9', contentHash: HASH_B }),
      source: 'experience',
      reason: 'evicted_for_room',
      at: 1,
    }]
    const injected = byAction(build({ drops }), 'injected')!
    expect(injected.excludedCandidates).toContainEqual({
      entryId: 'exp-9',
      contentHash: HASH_B,
      reasonCode: INJECTION_EXCLUSION_REASONS.EVICTED_FOR_ROOM,
    })
  })

  it('never copies entry bodies into exclusions', () => {
    // Exclusions exist to reconstruct the candidate set, not to duplicate
    // knowledge text into trajectories with their own retention story.
    const selected = byAction(build(), 'selected')!
    for (const candidate of selected.excludedCandidates ?? []) {
      expect(Object.keys(candidate).sort()).toEqual(['contentHash', 'entryId', 'reasonCode'])
    }
  })
})

describe('buildInjectionProvenanceItems — injected is not selected', () => {
  it('records an entry that was injected without being selected this turn', () => {
    // A slot checked out on turn N is still rendered on turn N+1 without going
    // through selection again. Deriving injection from the selector would miss
    // it entirely — this is the case that makes the pager the authority.
    const items = build({
      selection: selectionTrace({ selectedEntryIds: ['exp-1'], pool: [
        { entryId: 'exp-1', contentHash: HASH_A, eligibleByThreshold: true },
      ] }),
      render: renderTrace({
        rendered: [
          {
            slotId: 'experience:exp-1',
            provenance: provenance(),
            source: 'experience',
            priority: 'medium',
            tokenEst: 120,
            order: 0,
            turnsSurvived: 0,
          },
          {
            slotId: 'experience:exp-7',
            provenance: provenance({ entryId: 'exp-7', contentHash: HASH_B, queryHash: 'query-older' }),
            source: 'experience',
            priority: 'medium',
            tokenEst: 90,
            order: 1,
            turnsSurvived: 2,
          },
        ],
        tokens: 210,
      }),
    })

    const selected = byAction(items, 'selected')!
    const injected = byAction(items, 'injected')!
    expect(selected.entryIds).toEqual(['exp-1'])
    expect(injected.entryIds).toEqual(['exp-1', 'exp-7'])
  })

  it('keeps a surviving slot pointed at the query that actually retrieved it', () => {
    // Stamping the current turn's query onto a slot selected two turns ago
    // would invent a retrieval that never happened.
    const items = build({
      selection: selectionTrace({ queryHash: 'query-now' }),
      render: renderTrace({
        rendered: [{
          slotId: 'experience:exp-7',
          provenance: provenance({ entryId: 'exp-7', queryHash: 'query-two-turns-ago' }),
          source: 'experience',
          priority: 'medium',
          tokenEst: 90,
          order: 0,
          turnsSurvived: 2,
        }],
      }),
    })
    expect(byAction(items, 'injected')!.injected?.[0]?.queryHash).toBe('query-two-turns-ago')
  })

  it('attributes a VV-hook injection to its own selector', () => {
    // The hook checks out at high priority on a different trigger. Crediting
    // the working-set selector for it would misattribute whatever followed.
    const items = build({
      selection: null,
      render: renderTrace({
        rendered: [{
          slotId: 'experience:exp-5',
          provenance: provenance({ entryId: 'exp-5', selectorVersion: 'vv-failure-pattern-v1' }),
          source: 'vv_hook',
          priority: 'high',
          tokenEst: 80,
          order: 0,
          turnsSurvived: 0,
        }],
        tokens: 80,
      }),
    })
    expect(byAction(items, 'injected')!.injected?.[0]?.selectorVersion).toBe('vv-failure-pattern-v1')
  })

  it('skips slots carrying a malformed content hash rather than emitting them', () => {
    // A row that cannot be resolved back to a stored version reads as
    // attributable and is not. Better absent than misleading.
    const items = build({
      selection: null,
      render: renderTrace({
        rendered: [{
          slotId: 'experience:exp-bad',
          provenance: { entryId: 'exp-bad', contentHash: 'not-a-hash', queryHash: 'q', selectorVersion: 'v' },
          source: 'experience',
          priority: 'medium',
          tokenEst: 10,
          order: 0,
          turnsSurvived: 0,
        }],
      }),
    })
    expect(items).toEqual([])
  })
})

describe('buildInjectionProvenanceItems — reconciliation fields', () => {
  it('reports the whole rendered block, not just the itemised entries', () => {
    // contextHash and tokenCost describe the assembled context so they can be
    // reconciled against the prompt; entries without knowledge identity are
    // part of that context even though they cannot be itemised.
    const injected = byAction(build({
      render: renderTrace({ tokens: 260, contentHash: HASH_C }),
    }), 'injected')!
    expect(injected.contextHash).toBe(HASH_C)
    expect(injected.tokenCost).toBe(260)
  })

  it('numbers slots and preserves render order', () => {
    const injected = byAction(build({
      render: renderTrace({
        rendered: [
          { slotId: 's1', provenance: provenance({ entryId: 'e1' }), source: 'experience', priority: 'high', tokenEst: 10, order: 0, turnsSurvived: 0 },
          { slotId: 's2', provenance: provenance({ entryId: 'e2', contentHash: HASH_B }), source: 'experience', priority: 'medium', tokenEst: 10, order: 1, turnsSurvived: 0 },
        ],
      }),
    }), 'injected')!
    expect(injected.injected?.map(e => [e.entryId, e.slot, e.order])).toEqual([
      ['e1', 0, 0],
      ['e2', 1, 1],
    ])
  })
})
