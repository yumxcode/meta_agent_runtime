/**
 * How the Reviewer reads injection provenance.
 *
 * The Reviewer is the read side of attribution, so provenance that it cannot
 * see is provenance that was recorded for nothing. But it is also the owner of
 * TaskCase window identity: `windowHash` is derived from these rendered lines,
 * so a rendering change silently invalidates every stored incremental identity.
 *
 * Hence the two things pinned here — it must *see* the new fields, and it must
 * render pre-injection lines byte-identically.
 */
import { describe, expect, it } from 'vitest'
import { reduceTrajectoryLine } from '../TrajectoryReviewScanner.js'
import type { PreservedTrajectoryLine } from '../../trajectory/types.js'

function line(item: Record<string, unknown>): PreservedTrajectoryLine {
  return {
    schemaVersion: 'trajectory-line-1.0',
    ts: 1,
    ordinal: 7,
    trajectoryId: '00000000-0000-4000-8000-000000000001',
    item: item as PreservedTrajectoryLine['item'],
    knownItem: true,
    rawLine: JSON.stringify(item),
  }
}

function injectedEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entryId: 'exp-1',
    contentHash: 'a1b2c3d4'.repeat(8),
    versionChain: ['exp-1@2'],
    selectorVersion: 'cue-match-v1',
    queryHash: 'b'.repeat(64),
    slot: 0,
    order: 0,
    ...overrides,
  }
}

describe('reviewer rendering of injection provenance', () => {
  it('renders pre-injection knowledge lines byte-identically', () => {
    // Every knowledge shape production wrote before 1.2.0. If any of these
    // change, stored TaskCase window identities move and the whole corpus is
    // re-analysed for no reason.
    const legacy = [
      { type: 'knowledge', kind: 'experience', action: 'recalled', entryIds: ['exp-1'], query: 'controller', operation: 'recall' },
      { type: 'knowledge', kind: 'experience', action: 'proposed', entryIds: [], pendingId: 'pending-1' },
      { type: 'knowledge', kind: 'principle', action: 'recalled', entryIds: ['p-1', 'p-2'], operation: 'recall' },
      { type: 'knowledge', kind: 'anchor', action: 'deleted', entryIds: ['a-1'], operation: 'delete' },
    ]
    const expected = [
      'knowledge experience/recalled entries=exp-1',
      'knowledge experience/proposed entries=',
      'knowledge principle/recalled entries=p-1,p-2',
      'knowledge anchor/deleted entries=a-1',
    ]
    legacy.forEach((item, index) => {
      expect(reduceTrajectoryLine(line(item)).text).toBe(expected[index])
    })
  })

  it('surfaces version, selector and cost for an injected entry', () => {
    const text = reduceTrajectoryLine(line({
      type: 'knowledge', kind: 'experience', action: 'injected',
      entryIds: ['exp-1'], operation: 'inject',
      injected: [injectedEntry()],
      contextHash: 'c'.repeat(64),
      tokenCost: 420,
    })).text
    expect(text).toContain('injected=1[exp-1@a1b2c3d4]')
    expect(text).toContain('selector=cue-match-v1')
    expect(text).toContain('tokens=420')
    expect(text).toContain('context=cccccccc')
  })

  it('reports excluded candidates by count and reason code, never by body', () => {
    const text = reduceTrajectoryLine(line({
      type: 'knowledge', kind: 'experience', action: 'injected',
      entryIds: ['exp-1'],
      injected: [injectedEntry()],
      excludedCandidates: [
        { entryId: 'exp-2', contentHash: 'd'.repeat(64), reasonCode: 'excluded_boundary' },
        { entryId: 'exp-3', contentHash: 'e'.repeat(64), reasonCode: 'excluded_boundary' },
        { entryId: 'exp-4', contentHash: 'f'.repeat(64), reasonCode: 'token_budget' },
      ],
    })).text
    expect(text).toContain('excluded=3(excluded_boundary,token_budget)')
    // Ids of excluded entries are not worth the tokens; the codes are.
    expect(text).not.toContain('exp-3')
  })

  it('shows assignment propensity only when the selector actually randomised', () => {
    const deterministic = reduceTrajectoryLine(line({
      type: 'knowledge', kind: 'experience', action: 'injected',
      entryIds: ['exp-1'], injected: [injectedEntry()],
    })).text
    // Absence is meaningful: off-policy estimation is impossible without it,
    // so it must not read as an implicit 1.0.
    expect(deterministic).not.toContain('propensity')

    const randomised = reduceTrajectoryLine(line({
      type: 'knowledge', kind: 'experience', action: 'injected',
      entryIds: ['exp-1'], injected: [injectedEntry({ assignmentProbability: 0.25 })],
    })).text
    expect(randomised).toContain('propensity=0.250')
  })

  it('caps a large injection set instead of flooding the window budget', () => {
    const text = reduceTrajectoryLine(line({
      type: 'knowledge', kind: 'experience', action: 'injected',
      entryIds: ['exp-1'],
      injected: Array.from({ length: 10 }, (_, i) => injectedEntry({ entryId: `exp-${i}` })),
    })).text
    expect(text).toContain('injected=10[')
    expect(text).toContain('+4]')
    expect(text).not.toContain('exp-9')
  })

  it('collapses repeated selector versions rather than repeating them', () => {
    const text = reduceTrajectoryLine(line({
      type: 'knowledge', kind: 'experience', action: 'injected',
      entryIds: ['exp-1'],
      injected: [
        injectedEntry({ entryId: 'exp-1' }),
        injectedEntry({ entryId: 'exp-2' }),
        injectedEntry({ entryId: 'exp-3', selectorVersion: 'workflow-v2' }),
      ],
    })).text
    expect(text).toContain('selector=cue-match-v1|workflow-v2')
  })

  it('stays well inside the per-line budget at the schema maximum', () => {
    const text = reduceTrajectoryLine(line({
      type: 'knowledge', kind: 'experience', action: 'injected',
      entryIds: Array.from({ length: 32 }, (_, i) => `exp-${i}`),
      injected: Array.from({ length: 32 }, (_, i) => injectedEntry({ entryId: `exp-${i}` })),
      excludedCandidates: Array.from({ length: 64 }, (_, i) => ({
        entryId: `exp-x-${i}`, contentHash: 'd'.repeat(64), reasonCode: `code_${i % 5}`,
      })),
      contextHash: 'c'.repeat(64),
      tokenCost: 4_096,
    })).text
    expect(text).not.toContain('[truncated]')
    expect(text.length).toBeLessThan(800)
  })
})
