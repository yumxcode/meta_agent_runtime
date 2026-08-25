/**
 * Injection provenance (G0-1).
 *
 * These fields exist so a later analysis can ask "was this run exposed to that
 * entry, at which version". They record EXPOSURE only. The tests below pin the
 * two properties that make the record trustworthy:
 *
 *   1. adding them broke nothing that already writes knowledge items;
 *   2. excluded candidates cannot smuggle entry bodies into trajectories.
 */
import { describe, expect, it } from 'vitest'
import { KnowledgeItemSchema } from '../types.js'

const HASH = 'a'.repeat(64)

function injectedEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entryId: 'exp-1',
    contentHash: HASH,
    selectorVersion: 'cue-match-v1',
    queryHash: 'b'.repeat(64),
    ...overrides,
  }
}

describe('knowledge injection provenance', () => {
  it('still accepts every pre-1.2.0 knowledge item unchanged', () => {
    // The four shapes production actually writes today (robotics experience /
    // principle / anchor tools and the delete tool factory).
    const legacy = [
      { type: 'knowledge', kind: 'experience', action: 'recalled', entryIds: ['exp-1'], query: 'controller', operation: 'recall' },
      { type: 'knowledge', kind: 'experience', action: 'proposed', entryIds: [], pendingId: 'pending-1' },
      { type: 'knowledge', kind: 'principle', action: 'recalled', entryIds: ['p-1'], operation: 'recall' },
      { type: 'knowledge', kind: 'anchor', action: 'deleted', entryIds: ['a-1'], operation: 'delete' },
    ]
    for (const item of legacy) {
      expect(KnowledgeItemSchema.safeParse(item).success, JSON.stringify(item)).toBe(true)
    }
  })

  it('defaults entryIds when a legacy producer omits it', () => {
    const parsed = KnowledgeItemSchema.parse({ type: 'knowledge', kind: 'experience', action: 'recalled' })
    expect(parsed.entryIds).toEqual([])
  })

  it('accepts all five retrieval and injection states', () => {
    for (const action of ['recalled', 'eligible', 'selected', 'rendered', 'injected'] as const) {
      const parsed = KnowledgeItemSchema.safeParse({
        type: 'knowledge', kind: 'experience', action, entryIds: ['exp-1'],
      })
      expect(parsed.success, action).toBe(true)
    }
  })

  it('records what reached the context, with selector and version identity', () => {
    const parsed = KnowledgeItemSchema.parse({
      type: 'knowledge',
      kind: 'experience',
      action: 'injected',
      entryIds: ['exp-1'],
      operation: 'inject',
      injected: [injectedEntry({ versionChain: ['exp-1@1', 'exp-1@2'], slot: 1, order: 2 })],
      contextHash: 'c'.repeat(64),
      tokenCost: 420,
    })
    expect(parsed.injected?.[0]).toMatchObject({
      entryId: 'exp-1',
      contentHash: HASH,
      selectorVersion: 'cue-match-v1',
      versionChain: ['exp-1@1', 'exp-1@2'],
      slot: 1,
      order: 2,
    })
    expect(parsed.contextHash).toBe('c'.repeat(64))
  })

  it('defaults version chain and position so early producers can adopt incrementally', () => {
    const parsed = KnowledgeItemSchema.parse({
      type: 'knowledge', kind: 'experience', action: 'injected',
      injected: [injectedEntry()],
    })
    expect(parsed.injected?.[0]).toMatchObject({ versionChain: [], slot: 0, order: 0 })
  })

  it('rejects a content hash that cannot identify a version', () => {
    for (const contentHash of ['', 'deadbeef', 'A'.repeat(64), `${HASH}0`]) {
      const parsed = KnowledgeItemSchema.safeParse({
        type: 'knowledge', kind: 'experience', action: 'injected',
        injected: [injectedEntry({ contentHash })],
      })
      expect(parsed.success, contentHash).toBe(false)
    }
  })

  it('requires the selector identity that makes attribution possible', () => {
    for (const missing of ['selectorVersion', 'queryHash', 'entryId', 'contentHash']) {
      const entry = injectedEntry()
      delete entry[missing]
      const parsed = KnowledgeItemSchema.safeParse({
        type: 'knowledge', kind: 'experience', action: 'injected', injected: [entry],
      })
      expect(parsed.success, missing).toBe(false)
    }
  })

  it('keeps assignment probability a probability', () => {
    for (const assignmentProbability of [-0.1, 1.1]) {
      expect(KnowledgeItemSchema.safeParse({
        type: 'knowledge', kind: 'experience', action: 'injected',
        injected: [injectedEntry({ assignmentProbability })],
      }).success, String(assignmentProbability)).toBe(false)
    }
    expect(KnowledgeItemSchema.safeParse({
      type: 'knowledge', kind: 'experience', action: 'injected',
      injected: [injectedEntry({ assignmentProbability: 0.25 })],
    }).success).toBe(true)
  })

  it('refuses to let an excluded candidate carry the entry body', () => {
    // Excluded rows are id/hash/reasonCode only. A `text` or `content` field
    // would turn every run into a copy of the knowledge store.
    for (const smuggled of [{ text: 'full entry body' }, { content: 'full entry body' }, { body: 'x' }]) {
      const parsed = KnowledgeItemSchema.safeParse({
        type: 'knowledge', kind: 'experience', action: 'injected',
        excludedCandidates: [{ entryId: 'exp-2', contentHash: HASH, reasonCode: 'excluded_boundary', ...smuggled }],
      })
      expect(parsed.success, JSON.stringify(smuggled)).toBe(false)
    }
  })

  it('caps reason codes so they stay codes rather than prose', () => {
    expect(KnowledgeItemSchema.safeParse({
      type: 'knowledge', kind: 'experience', action: 'injected',
      excludedCandidates: [{ entryId: 'exp-2', contentHash: HASH, reasonCode: 'x'.repeat(65) }],
    }).success).toBe(false)
  })

  it('rejects unknown fields inside a provenance row', () => {
    expect(KnowledgeItemSchema.safeParse({
      type: 'knowledge', kind: 'experience', action: 'injected',
      injected: [injectedEntry({ rationale: 'because it looked relevant' })],
    }).success).toBe(false)
  })

  it('bounds both provenance arrays', () => {
    expect(KnowledgeItemSchema.safeParse({
      type: 'knowledge', kind: 'experience', action: 'injected',
      injected: Array.from({ length: 33 }, (_, i) => injectedEntry({ entryId: `exp-${i}` })),
    }).success).toBe(false)
    expect(KnowledgeItemSchema.safeParse({
      type: 'knowledge', kind: 'experience', action: 'injected',
      excludedCandidates: Array.from({ length: 65 }, (_, i) => ({
        entryId: `exp-${i}`, contentHash: HASH, reasonCode: 'excluded_boundary',
      })),
    }).success).toBe(false)
  })
})
