/**
 * The pager's provenance surface (G0-2a).
 *
 * The pager is the authority on what reached the prompt, so these tests pin the
 * two claims the emitter relies on: the render trace describes the exact string
 * that was returned, and slots that leave the pager without being rendered are
 * accounted for rather than vanishing.
 *
 * The oversized-slot case is the pre-existing silent drop — checkout() has
 * always returned false and the caller has always ignored it. It stays a drop;
 * it stops being silent.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { ContextPager } from '../ContextPager.js'
import type { SlotProvenance } from '../types.js'

function provenance(entryId: string): SlotProvenance {
  return {
    entryId,
    contentHash: 'a'.repeat(64),
    queryHash: `q-${entryId}`,
    selectorVersion: 'working-set-v1/flash_selected',
  }
}

function slot(entryId: string, tokenEst: number, priority: 'sticky' | 'high' | 'medium' | 'low' = 'medium') {
  return {
    id: `experience:${entryId}`,
    tag: `[EXP] ${entryId}`,
    content: `content of ${entryId}`,
    tokenEst,
    priority,
    ttlTurns: 4,
    source: 'experience' as const,
    provenance: provenance(entryId),
  }
}

describe('ContextPager — render trace', () => {
  it('hashes exactly the string it returned', () => {
    // contextHash is only useful if it can be recomputed from the prompt.
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout(slot('exp-1', 50))
    const output = pager.renderForTurn()
    expect(pager.lastRenderTrace?.contentHash)
      .toBe(createHash('sha256').update(output).digest('hex'))
  })

  it('carries slot identity and render order into the trace', () => {
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout(slot('exp-1', 50))
    pager.checkout(slot('exp-2', 50))
    pager.renderForTurn()
    const rendered = pager.lastRenderTrace!.rendered
    expect(rendered.map(r => [r.provenance?.entryId, r.order])).toEqual([
      ['exp-1', 0],
      ['exp-2', 1],
    ])
    expect(pager.lastRenderTrace!.tokens).toBe(100)
  })

  it('reports how many turns a slot has already survived', () => {
    // Non-zero means the slot is being injected again without having been
    // re-selected — the reason injected is a superset of selected.
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout(slot('exp-1', 50))
    pager.tick()
    pager.tick()
    pager.renderForTurn()
    expect(pager.lastRenderTrace!.rendered[0]!.turnsSurvived).toBe(2)
  })

  it('clears the trace when there is nothing to render', () => {
    // An empty pager is not an injection event; a stale trace here would make
    // the emitter report an injection on a turn that had none.
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout(slot('exp-1', 50))
    pager.renderForTurn()
    expect(pager.lastRenderTrace).not.toBeNull()

    pager.checkin('experience:exp-1')
    pager.renderForTurn()
    expect(pager.lastRenderTrace).toBeNull()
  })

  it('renders every checked-out slot in the current configuration', () => {
    // checkout() already enforces the budget and nothing checks out sticky
    // slots in production, so renderForTurn's skip branch is unreachable. If
    // this ever fails, an assumption changed and the emitter should say so.
    const pager = new ContextPager({ maxBudget: 300 })
    for (let i = 0; i < 6; i++) pager.checkout(slot(`exp-${i}`, 100))
    pager.renderForTurn()
    expect(pager.lastRenderTrace!.skippedForBudget).toEqual([])
  })
})

describe('ContextPager — drop records', () => {
  it('records a slot too large to ever fit', () => {
    const pager = new ContextPager({ maxBudget: 100 })
    expect(pager.checkout(slot('exp-huge', 500))).toBe(false)

    const drops = pager.drainDrops()
    expect(drops).toHaveLength(1)
    expect(drops[0]!.reason).toBe('oversized')
    expect(drops[0]!.provenance?.entryId).toBe('exp-huge')
  })

  it('records an experience evicted to make room for another', () => {
    // Experiences all check out at 'medium', so this is one experience
    // displacing another inside a single _refreshSlots() loop.
    const pager = new ContextPager({ maxBudget: 200 })
    pager.checkout(slot('exp-1', 100))
    pager.checkout(slot('exp-2', 100))
    pager.checkout(slot('exp-3', 100))

    const evicted = pager.drainDrops().filter(d => d.reason === 'evicted_for_room')
    expect(evicted.map(d => d.provenance?.entryId)).toEqual(['exp-1'])
  })

  it('drains, so one drop is never reported for two turns', () => {
    const pager = new ContextPager({ maxBudget: 100 })
    pager.checkout(slot('exp-huge', 500))
    expect(pager.drainDrops()).toHaveLength(1)
    expect(pager.drainDrops()).toHaveLength(0)
  })

  it('bounds undrained drops instead of growing without limit', () => {
    // Every pager built without provenance wiring never drains. That must not
    // become a leak.
    const pager = new ContextPager({ maxBudget: 100 })
    for (let i = 0; i < 200; i++) pager.checkout(slot(`exp-${i}`, 500))
    expect(pager.drainDrops().length).toBeLessThanOrEqual(64)
  })

  it('does not record TTL expiry as a drop', () => {
    // An expired slot was rendered on its last turn and excluded from none —
    // reporting it as an exclusion would invent a candidate that never applied.
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout({ ...slot('exp-1', 50), ttlTurns: 1 })
    pager.tick()
    expect(pager.drainDrops()).toEqual([])
  })

  it('does not record an explicit checkin as a drop', () => {
    const pager = new ContextPager({ maxBudget: 1000 })
    pager.checkout(slot('exp-1', 50))
    pager.checkin('experience:exp-1')
    expect(pager.drainDrops()).toEqual([])
  })
})
