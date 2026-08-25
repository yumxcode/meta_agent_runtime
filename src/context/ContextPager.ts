/**
 * ContextPager — demand-paged knowledge injection for LLM prompts.
 *
 * Manages a virtual knowledge space that is selectively materialised into
 * the prompt context window, analogous to Linux demand paging:
 *
 *   checkout()  ← mmap(): bring a knowledge page into the active window
 *   checkin()   ← munmap(): explicitly release a page
 *   tick()      ← page aging: decrement TTL counters, evict expired pages
 *   renderForTurn()  ← page-table walk: render all active pages within budget
 *   renderManifest() ← /proc/meminfo: ultra-compact always-visible index
 *
 * Budget enforcement:
 *   When a new checkout() would exceed maxBudget, pages are evicted in order:
 *   low → medium → high priority, with LRU ordering within each tier.
 *   'sticky' pages are never evicted.
 *
 * Integration points:
 *   - VV hooks call checkout() to schedule content for next-turn injection
 *   - QueryAnalyzer calls checkout() for intent-based pre-loading
 *   - RoboticsSession.submit() calls renderManifest() + renderForTurn()
 *   - RoboticsSession.submit() calls tick() after each turn completes
 */

import { createHash } from 'crypto'
import type {
  PageSlot,
  ContextPagerOptions,
  SlotPriority,
  PagerRenderTrace,
  SlotDropRecord,
  SlotDropReason,
} from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_BUDGET = 1500   // tokens reserved for checked-out slots
const EVICTION_ORDER: SlotPriority[] = ['low', 'medium', 'high']  // sticky excluded

/**
 * Cap on undrained drop records.
 *
 * Drops are drained once per turn by the provenance emitter. The cap exists so
 * that a caller which never drains (any pager built without provenance wiring,
 * including every existing test) cannot grow this list without bound. Oldest
 * records are discarded first: a drop that was never drained for many turns has
 * already lost the turn context that made it meaningful.
 */
const MAX_UNDRAINED_DROPS = 64

// ─────────────────────────────────────────────────────────────────────────────
// ContextPager
// ─────────────────────────────────────────────────────────────────────────────

export class ContextPager {
  private readonly slots = new Map<string, PageSlot>()
  private readonly maxBudget: number
  private _lastRenderTrace: PagerRenderTrace | null = null
  private _drops: SlotDropRecord[] = []

  constructor(opts: ContextPagerOptions = {}) {
    this.maxBudget = opts.maxBudget ?? DEFAULT_MAX_BUDGET
  }

  // ── Injection provenance (G0-2) ───────────────────────────────────────────

  /**
   * What the last renderForTurn() actually emitted, or null if it has not run.
   *
   * Read by the provenance emitter after the turn's context is assembled. Pure
   * observation: nothing in the pager's behaviour depends on it.
   */
  get lastRenderTrace(): PagerRenderTrace | null {
    return this._lastRenderTrace
  }

  /**
   * Take the drop records accumulated since the last drain.
   *
   * Draining rather than reading, because a drop belongs to exactly one turn's
   * provenance — reporting it twice would double-count an exclusion.
   */
  drainDrops(): SlotDropRecord[] {
    const drained = this._drops
    this._drops = []
    return drained
  }

  private _recordDrop(slot: Pick<PageSlot, 'id' | 'provenance' | 'source'>, reason: SlotDropReason): void {
    if (this._drops.length >= MAX_UNDRAINED_DROPS) this._drops.shift()
    this._drops.push({
      slotId: slot.id,
      provenance: slot.provenance,
      source: slot.source,
      reason,
      at: Date.now(),
    })
  }

  // ── Checkout / Checkin ────────────────────────────────────────────────────

  /**
   * Schedule a knowledge page for injection in the next turn's prompt.
   *
   * If the budget would be exceeded after adding this slot, lower-priority
   * pages are evicted to make room (LRU within priority tier).
   * If the slot already exists it is refreshed (content + TTL updated).
   * Returns false when a non-sticky slot cannot fit even after eviction.
   */
  checkout(slot: Omit<PageSlot, 'remainingTurns' | 'checkedOutAt'>): boolean {
    const existing = this.slots.get(slot.id)

    if (slot.priority !== 'sticky') {
      const nonStickyCapacity = this.maxBudget - this._stickyTokens(slot.id)
      if (slot.tokenEst > nonStickyCapacity) {
        // Pre-existing silent drop: ExperienceWorkingSet._refreshSlots() calls
        // checkout() as a bare statement and never reads this `false`, so an
        // over-budget experience disappears without a trace. G0-2 makes it
        // traceable; changing the drop itself is out of scope for a gate whose
        // contract is "no behaviour change".
        this._recordDrop({ ...slot }, 'oversized')
        return false
      }
    }

    if (existing) this.slots.delete(slot.id)

    // Evict if needed before adding
    this._evictToFit(slot.tokenEst)

    this.slots.set(slot.id, {
      ...slot,
      remainingTurns: slot.ttlTurns,
      checkedOutAt: Date.now(),
    })
    return true
  }

  /**
   * Explicitly release a slot.
   * Useful when a task completes and its context is no longer relevant.
   */
  checkin(id: string): void {
    this.slots.delete(id)
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /**
   * Render the always-visible Manifest layer (~100 tokens).
   *
   * Shows: what knowledge sources are available, how many failures are on
   * record, and which slots are currently checked out.
   * Never exceeds ~120 tokens regardless of slot count.
   */
  renderManifest(extraLines: string[] = []): string {
    const active = [...this.slots.values()]
    if (active.length === 0 && extraLines.length === 0) {
      return '## Knowledge Library\n*No entries loaded yet.*'
    }

    const lines = ['## Knowledge Library']

    // Extra lines (from ExperienceSource manifest, hardware profile, etc.)
    for (const line of extraLines) {
      lines.push(line)
    }

    // Active slot summary
    if (active.length > 0) {
      const activeLabels = active.map(s => s.tag).join(' | ')
      lines.push(`**Active (${active.length}):** ${activeLabels}`)
    }

    return lines.join('\n')
  }

  /**
   * Render all checked-out slot content for the current turn.
   *
   * Slots are rendered in priority order (sticky → high → medium → low),
   * stopping when the token budget is exhausted.
   * Low-priority slots are always rendered (they expire after this turn anyway).
   */
  renderForTurn(): string {
    if (this.slots.size === 0) {
      // An empty pager is not an injection event. Recording a trace here would
      // make the emitter produce a knowledge item on every turn of every
      // session that never touched experience — the "no noise item when nothing
      // was injected" acceptance criterion.
      this._lastRenderTrace = null
      return ''
    }

    const ordered = [...this.slots.values()].sort((a, b) => {
      const order: Record<SlotPriority, number> = { sticky: 0, high: 1, medium: 2, low: 3 }
      return order[a.priority] - order[b.priority]
    })

    const parts: string[] = []
    const rendered: PagerRenderTrace['rendered'] = []
    const skippedForBudget: PagerRenderTrace['skippedForBudget'] = []
    let usedTokens = 0

    for (const slot of ordered) {
      if (usedTokens + slot.tokenEst > this.maxBudget && slot.priority !== 'sticky') {
        skippedForBudget.push({ slotId: slot.id, provenance: slot.provenance, tokenEst: slot.tokenEst })
        continue  // skip non-sticky slots that would bust the budget
      }
      rendered.push({
        slotId: slot.id,
        provenance: slot.provenance,
        source: slot.source,
        priority: slot.priority,
        tokenEst: slot.tokenEst,
        order: rendered.length,
        // ttlTurns - remainingTurns: how many tick()s this slot has already
        // survived. Non-zero means it is being injected again without having
        // been re-selected this turn.
        turnsSurvived: Math.max(0, slot.ttlTurns - slot.remainingTurns),
      })
      parts.push(slot.content)
      usedTokens += slot.tokenEst
    }

    const output = parts.join('\n\n---\n\n')
    this._lastRenderTrace = {
      renderedAt: Date.now(),
      rendered,
      skippedForBudget,
      tokens: usedTokens,
      // Hash of the exact bytes handed back, so the emitted contextHash can be
      // reconciled against what the section builder assembled.
      contentHash: createHash('sha256').update(output).digest('hex'),
    }
    return output
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Age all non-sticky slots by one turn.
   *
   * Call this at the END of each submit() turn.
   *
   * @param referencedIds  Set of slot IDs the agent mentioned in its response.
   *   Referenced slots have their TTL reset to preserve useful context.
   */
  tick(referencedIds?: Set<string>): void {
    for (const [id, slot] of this.slots) {
      if (slot.priority === 'sticky') continue

      if (referencedIds?.has(id)) {
        // Reset TTL for actively referenced slots
        slot.remainingTurns = slot.ttlTurns
        continue
      }

      slot.remainingTurns--
      if (slot.remainingTurns <= 0) {
        this.slots.delete(id)
      }
    }
  }

  /** Release all non-sticky slots (e.g. on task context switch). */
  flush(): void {
    for (const [id, slot] of this.slots) {
      if (slot.priority !== 'sticky') this.slots.delete(id)
    }
  }

  /** Release ALL slots including sticky ones (e.g. on session end). */
  flushAll(): void {
    this.slots.clear()
  }

  /** Current token usage across all active slots. */
  get usedTokens(): number {
    let total = 0
    for (const slot of this.slots.values()) total += slot.tokenEst
    return total
  }

  /** Number of currently active slots. */
  get slotCount(): number {
    return this.slots.size
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Evict slots to free at least `needed` tokens.
   * Eviction order: low → medium → high, LRU within each tier.
   * sticky slots are never evicted.
   */
  private _evictToFit(needed: number): void {
    if (this.usedTokens + needed <= this.maxBudget) return

    for (const priority of EVICTION_ORDER) {
      if (this.usedTokens + needed <= this.maxBudget) break

      // Collect evictable slots of this priority, sorted oldest-first (LRU)
      const candidates = [...this.slots.values()]
        .filter(s => s.priority === priority)
        .sort((a, b) => a.checkedOutAt - b.checkedOutAt)

      for (const slot of candidates) {
        if (this.usedTokens + needed <= this.maxBudget) break
        this.slots.delete(slot.id)
        // Experiences all check out at 'medium', so this is also how one
        // experience displaces another within a single _refreshSlots() loop.
        this._recordDrop(slot, 'evicted_for_room')
      }
    }
  }

  private _stickyTokens(excludeId?: string): number {
    let total = 0
    for (const slot of this.slots.values()) {
      if (slot.id !== excludeId && slot.priority === 'sticky') total += slot.tokenEst
    }
    return total
  }
}
