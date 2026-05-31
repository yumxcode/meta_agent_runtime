import { describe, expect, it } from 'vitest'
import { ContextPager } from '../ContextPager.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function slot(
  id: string,
  priority: 'sticky' | 'high' | 'medium' | 'low' = 'medium',
  tokens = 100,
  ttlTurns = 3,
) {
  return {
    id,
    tag:      `[${id}]`,
    content:  `Content of ${id}`,
    tokenEst: tokens,
    priority,
    ttlTurns,
    source:   'experience' as const,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// checkout / checkin
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextPager — checkout / checkin', () => {
  it('stores a slot and exposes it in renderForTurn()', () => {
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout(slot('exp:1'))
    const rendered = pager.renderForTurn()
    expect(rendered).toContain('Content of exp:1')
  })

  it('refresh: same ID updates priority and TTL without creating a duplicate', () => {
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout(slot('exp:1', 'medium', 100, 2))
    pager.checkout(slot('exp:1', 'high',   100, 4))  // same ID, upgraded
    const rendered = pager.renderForTurn()
    // Should only appear once
    const count = (rendered.match(/Content of exp:1/g) ?? []).length
    expect(count).toBe(1)
  })

  it('checkin() removes the slot so renderForTurn() no longer includes it', () => {
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout(slot('exp:1'))
    pager.checkin('exp:1')
    expect(pager.renderForTurn()).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// tick() — TTL aging and eviction
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextPager — tick() TTL aging', () => {
  it('evicts a slot once its TTL reaches 0', () => {
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout(slot('exp:1', 'medium', 100, 1))
    pager.tick()  // remainingTurns → 0 → evicted
    expect(pager.renderForTurn()).toBe('')
  })

  it('does not evict sticky slots regardless of TTL', () => {
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout(slot('sticky:1', 'sticky', 100, 1))
    pager.tick()
    pager.tick()
    pager.tick()
    expect(pager.renderForTurn()).toContain('Content of sticky:1')
  })

  it('resets TTL for slots referenced in the agent response', () => {
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout(slot('exp:1', 'medium', 100, 2))
    pager.tick()                         // remainingTurns → 1
    pager.tick(new Set(['exp:1']))        // referenced → reset to original TTL (2)
    pager.tick()                         // remainingTurns → 1
    expect(pager.renderForTurn()).toContain('Content of exp:1')
    pager.tick()                         // remainingTurns → 0 → evicted
    expect(pager.renderForTurn()).toBe('')
  })

  it('survives multiple ticks for slots with ttlTurns > 1', () => {
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout(slot('exp:2', 'medium', 100, 3))
    pager.tick()  // 2
    pager.tick()  // 1
    expect(pager.renderForTurn()).toContain('Content of exp:2')
    pager.tick()  // 0 → evicted
    expect(pager.renderForTurn()).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Budget enforcement and eviction order
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextPager — budget enforcement', () => {
  it('evicts low-priority slots to make room for a new checkout', () => {
    const pager = new ContextPager({ maxBudget: 200 })
    pager.checkout(slot('low:1', 'low',    150))
    pager.checkout(slot('high:1', 'high', 150))  // low:1 evicted to fit
    const rendered = pager.renderForTurn()
    expect(rendered).toContain('Content of high:1')
    expect(rendered).not.toContain('Content of low:1')
  })

  it('never evicts sticky slots during budget overflow', () => {
    const pager = new ContextPager({ maxBudget: 200 })
    pager.checkout(slot('sticky:1', 'sticky', 180))
    pager.checkout(slot('low:1', 'low', 180))   // low:1 evicted; sticky:1 stays
    const rendered = pager.renderForTurn()
    expect(rendered).toContain('Content of sticky:1')
    expect(rendered).not.toContain('Content of low:1')
  })

  it('rejects oversized non-sticky slots instead of listing unrenderable active pages', () => {
    const pager = new ContextPager({ maxBudget: 100 })
    const loaded = pager.checkout(slot('huge:1', 'high', 150))

    expect(loaded).toBe(false)
    expect(pager.renderForTurn()).toBe('')
    expect(pager.renderManifest()).not.toContain('huge:1')
  })

  it('keeps the previous slot when an oversized refresh cannot fit', () => {
    const pager = new ContextPager({ maxBudget: 100 })
    pager.checkout({ ...slot('exp:1', 'medium', 80), content: 'small content' })
    const refreshed = pager.checkout({ ...slot('exp:1', 'medium', 150), content: 'oversized content' })

    const rendered = pager.renderForTurn()
    expect(refreshed).toBe(false)
    expect(rendered).toContain('small content')
    expect(rendered).not.toContain('oversized content')
  })

  it('renders slots in priority order: sticky → high → medium → low', () => {
    const pager = new ContextPager({ maxBudget: 2000 })
    pager.checkout(slot('low:1',    'low',    10))
    pager.checkout(slot('medium:1', 'medium', 10))
    pager.checkout(slot('high:1',   'high',   10))
    pager.checkout(slot('sticky:1', 'sticky', 10))
    const rendered = pager.renderForTurn()
    const stickyPos  = rendered.indexOf('Content of sticky:1')
    const highPos    = rendered.indexOf('Content of high:1')
    const mediumPos  = rendered.indexOf('Content of medium:1')
    const lowPos     = rendered.indexOf('Content of low:1')
    expect(stickyPos).toBeLessThan(highPos)
    expect(highPos).toBeLessThan(mediumPos)
    expect(mediumPos).toBeLessThan(lowPos)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// P0 fix: slot ID refresh upgrades priority (proactive preload → VV hook)
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextPager — P0 slot ID unification (proactive preload → VV hook upgrade)', () => {
  it('upgrades medium preload to high when VV hook checks out same ID', () => {
    const pager = new ContextPager({ maxBudget: 1000 })

    // Proactive preload: medium priority, ttl 2
    pager.checkout({ ...slot('experience:exp-001', 'medium', 80, 2), content: 'Preload content' })

    // VV hook runs: same canonical ID, high priority, ttl 3
    pager.checkout({ ...slot('experience:exp-001', 'high', 80, 3), content: 'VV hook content' })

    // Only one slot exists, content is the VV hook version, priority high
    const rendered = pager.renderForTurn()
    const occurrences = (rendered.match(/experience:exp-001/g) ?? []).length
    expect(occurrences).toBeLessThanOrEqual(1)
    expect(rendered).toContain('VV hook content')
    expect(rendered).not.toContain('Preload content')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// flush() and renderManifest()
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextPager — flush() and renderManifest()', () => {
  it('flush() removes all non-sticky slots', () => {
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout(slot('medium:1', 'medium'))
    pager.checkout(slot('sticky:1', 'sticky'))
    pager.flush()
    const rendered = pager.renderForTurn()
    expect(rendered).not.toContain('Content of medium:1')
    expect(rendered).toContain('Content of sticky:1')
  })

  it('renderManifest() lists active slot tags', () => {
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout(slot('exp:1', 'high'))
    const manifest = pager.renderManifest(['Experiences: 5 total'])
    expect(manifest).toContain('Knowledge Library')
    expect(manifest).toContain('Experiences: 5 total')
    expect(manifest).toContain('[exp:1]')
  })

  it('renderManifest() with no slots shows empty-state message', () => {
    const pager = new ContextPager({ maxBudget: 1000 })
    const manifest = pager.renderManifest()
    expect(manifest).toContain('No entries loaded yet')
  })
})
