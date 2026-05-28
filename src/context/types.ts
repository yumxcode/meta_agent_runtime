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
