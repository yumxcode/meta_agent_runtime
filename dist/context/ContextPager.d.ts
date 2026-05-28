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
import type { PageSlot, ContextPagerOptions } from './types.js';
export declare class ContextPager {
    private readonly slots;
    private readonly maxBudget;
    constructor(opts?: ContextPagerOptions);
    /**
     * Schedule a knowledge page for injection in the next turn's prompt.
     *
     * If the budget would be exceeded after adding this slot, lower-priority
     * pages are evicted to make room (LRU within priority tier).
     * If the slot already exists it is refreshed (content + TTL updated).
     */
    checkout(slot: Omit<PageSlot, 'remainingTurns' | 'checkedOutAt'>): void;
    /**
     * Explicitly release a slot.
     * Useful when a task completes and its context is no longer relevant.
     */
    checkin(id: string): void;
    /**
     * Render the always-visible Manifest layer (~100 tokens).
     *
     * Shows: what knowledge sources are available, how many failures are on
     * record, and which slots are currently checked out.
     * Never exceeds ~120 tokens regardless of slot count.
     */
    renderManifest(extraLines?: string[]): string;
    /**
     * Render all checked-out slot content for the current turn.
     *
     * Slots are rendered in priority order (sticky → high → medium → low),
     * stopping when the token budget is exhausted.
     * Low-priority slots are always rendered (they expire after this turn anyway).
     */
    renderForTurn(): string;
    /**
     * Age all non-sticky slots by one turn.
     *
     * Call this at the END of each submit() turn.
     *
     * @param referencedIds  Set of slot IDs the agent mentioned in its response.
     *   Referenced slots have their TTL reset to preserve useful context.
     */
    tick(referencedIds?: Set<string>): void;
    /** Release all non-sticky slots (e.g. on task context switch). */
    flush(): void;
    /** Release ALL slots including sticky ones (e.g. on session end). */
    flushAll(): void;
    /** Current token usage across all active slots. */
    get usedTokens(): number;
    /** Number of currently active slots. */
    get slotCount(): number;
    /**
     * Evict slots to free at least `needed` tokens.
     * Eviction order: low → medium → high, LRU within each tier.
     * sticky slots are never evicted.
     */
    private _evictToFit;
}
//# sourceMappingURL=ContextPager.d.ts.map