/**
 * ContextPager — type definitions
 *
 * The ContextPager manages a virtual knowledge space that is selectively
 * paged into the LLM prompt, mirroring Linux demand-paging:
 *
 *   PageSlot   ≈ memory page (unit of knowledge with a token cost)
 *   Manifest   ≈ /proc/meminfo (always-visible compact index, ~100 tokens)
 *   checkout() ≈ mmap() — bring a page into the active window
 *   checkin()  ≈ munmap() — explicitly release a page
 *   tick()     ≈ page-aging — decrement TTL, evict expired pages
 *   maxBudget  ≈ physical memory limit for the dynamic knowledge window
 */

// ─────────────────────────────────────────────────────────────────────────────
// Priority
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Eviction priority (highest-to-lowest resistance to eviction):
 *
 *   sticky  — never evicted (hardware safety limits, current task context)
 *   high    — survive up to ttlTurns turns without reference (VV-triggered warnings)
 *   medium  — 1-2 turns, general knowledge lookups
 *   low     — released at end of current turn
 */
export type SlotPriority = 'sticky' | 'high' | 'medium' | 'low'

// ─────────────────────────────────────────────────────────────────────────────
// Slot source tag
// ─────────────────────────────────────────────────────────────────────────────

export type SlotSource = 'experience' | 'hardware' | 'memory' | 'vv_hook' | 'query_analysis'

// ─────────────────────────────────────────────────────────────────────────────
// PageSlot
// ─────────────────────────────────────────────────────────────────────────────

export interface PageSlot {
  /** Unique stable key, e.g. 'exp:exp_abc123' | 'hw:safety_limits' */
  id: string
  /** Short display label shown in the Manifest, e.g. '⚠️ [FAILURE] J3 Joint Limit' */
  tag: string
  /** Full Markdown content injected into the prompt when this slot is active */
  content: string
  /** Rough token estimate (used for budget enforcement) */
  tokenEst: number
  priority: SlotPriority
  /**
   * Maximum number of turns this slot survives without being referenced.
   * Ignored for 'sticky' slots (they survive indefinitely).
   */
  ttlTurns: number
  /** Countdown: decremented each tick(), reset when the agent references the slot. */
  remainingTurns: number
  /** Unix timestamp of last checkout() call */
  checkedOutAt: number
  source: SlotSource

  /**
   * Injection provenance (G0-2), when this slot is backed by a knowledge entry.
   *
   * The pager is the only component that knows what actually reached the
   * prompt: slots outlive the selection that created them (ttlTurns), and more
   * than one producer checks into the same pager. So identity has to travel
   * with the slot — by render time the selection behind it may be several turns
   * old, or may belong to a different producer entirely.
   *
   * Optional as a whole, never partially filled: a producer either knows the
   * full identity or records nothing. Half-identified injections are worse than
   * unidentified ones, because they look attributable and are not.
   */
  provenance?: SlotProvenance
}

/**
 * Everything needed to attribute one injected slot back to its source.
 *
 * All four fields are required together. In particular `queryHash` is captured
 * at checkout rather than at render: a slot rendered on turn N+2 was caused by
 * the query on turn N, and stamping it with the current turn's query would
 * quietly invent a retrieval that never happened.
 */
export interface SlotProvenance {
  /** Store id of the entry behind this slot. */
  entryId: string
  /** 64-hex content hash of that entry, as retrieved. */
  contentHash: string
  /** Hash of the query that caused this slot to be checked out. */
  queryHash: string
  /** Which selector chose it, including the route it took on that turn. */
  selectorVersion: string
}

// ─────────────────────────────────────────────────────────────────────────────
// ContextPager options
// ─────────────────────────────────────────────────────────────────────────────

export interface ContextPagerOptions {
  /**
   * Maximum tokens reserved for the checked-out slots section.
   * The Manifest is always shown in addition to this budget.
   * Default: 1500
   */
  maxBudget?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Injection provenance traces (G0-2)
// ─────────────────────────────────────────────────────────────────────────────

/** One slot as it appeared in the rendered turn output. */
export interface RenderedSlotRecord {
  slotId: string
  provenance?: SlotProvenance
  source: SlotSource
  priority: SlotPriority
  tokenEst: number
  /** Position in the rendered output, 0-based. */
  order: number
  /**
   * How many turns this slot had already survived when it was rendered.
   *
   * 0 means it was checked out for this turn. Anything above 0 means the slot
   * outlived the selection that produced it and is being injected again without
   * having been re-selected — the reason `injected` is a superset of `selected`
   * and cannot be derived from the selector's view alone.
   */
  turnsSurvived: number
}

/**
 * What `renderForTurn()` actually emitted.
 *
 * This is the authoritative answer to "what did the model see", which is why
 * injection provenance is emitted from here and not from the selector.
 */
export interface PagerRenderTrace {
  renderedAt: number
  rendered: RenderedSlotRecord[]
  /**
   * Slots present in the pager that the render dropped for budget.
   *
   * Expected to stay empty in the current configuration: checkout() already
   * enforces the budget and no production caller checks out sticky slots, so
   * the skip branch in renderForTurn() is unreachable today. It is recorded
   * anyway — if this ever becomes non-empty, an assumption changed and the
   * provenance should say so rather than silently agree.
   */
  skippedForBudget: Array<{ slotId: string; provenance?: SlotProvenance; tokenEst: number }>
  /** Sum of tokenEst over rendered slots. */
  tokens: number
  /** sha256 of the exact rendered string, for reconciliation against context. */
  contentHash: string
}

/** Why a slot never made it into the pager, or left it before being rendered. */
export type SlotDropReason =
  /**
   * checkout() refused it: the slot alone exceeds the non-sticky budget.
   * NOTE this is a pre-existing silent drop — the caller ignores the return
   * value. G0-2 records it; it deliberately does not change the behaviour.
   */
  | 'oversized'
  /** Evicted by a later checkout() needing room (LRU within priority tier). */
  | 'evicted_for_room'

export interface SlotDropRecord {
  slotId: string
  provenance?: SlotProvenance
  source: SlotSource
  reason: SlotDropReason
  at: number
}
