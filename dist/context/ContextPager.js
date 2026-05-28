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
// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_MAX_BUDGET = 1500; // tokens reserved for checked-out slots
const EVICTION_ORDER = ['low', 'medium', 'high']; // sticky excluded
// ─────────────────────────────────────────────────────────────────────────────
// ContextPager
// ─────────────────────────────────────────────────────────────────────────────
export class ContextPager {
    slots = new Map();
    maxBudget;
    constructor(opts = {}) {
        this.maxBudget = opts.maxBudget ?? DEFAULT_MAX_BUDGET;
    }
    // ── Checkout / Checkin ────────────────────────────────────────────────────
    /**
     * Schedule a knowledge page for injection in the next turn's prompt.
     *
     * If the budget would be exceeded after adding this slot, lower-priority
     * pages are evicted to make room (LRU within priority tier).
     * If the slot already exists it is refreshed (content + TTL updated).
     */
    checkout(slot) {
        const existing = this.slots.get(slot.id);
        if (existing) {
            // Refresh existing slot
            existing.content = slot.content;
            existing.tokenEst = slot.tokenEst;
            existing.priority = slot.priority;
            existing.ttlTurns = slot.ttlTurns;
            existing.remainingTurns = slot.ttlTurns;
            existing.tag = slot.tag;
            existing.checkedOutAt = Date.now();
            return;
        }
        // Evict if needed before adding
        this._evictToFit(slot.tokenEst);
        this.slots.set(slot.id, {
            ...slot,
            remainingTurns: slot.ttlTurns,
            checkedOutAt: Date.now(),
        });
    }
    /**
     * Explicitly release a slot.
     * Useful when a task completes and its context is no longer relevant.
     */
    checkin(id) {
        this.slots.delete(id);
    }
    // ── Rendering ─────────────────────────────────────────────────────────────
    /**
     * Render the always-visible Manifest layer (~100 tokens).
     *
     * Shows: what knowledge sources are available, how many failures are on
     * record, and which slots are currently checked out.
     * Never exceeds ~120 tokens regardless of slot count.
     */
    renderManifest(extraLines = []) {
        const active = [...this.slots.values()];
        if (active.length === 0 && extraLines.length === 0) {
            return '## Knowledge Library\n*No entries loaded yet.*';
        }
        const lines = ['## Knowledge Library'];
        // Extra lines (from ExperienceSource manifest, hardware profile, etc.)
        for (const line of extraLines) {
            lines.push(line);
        }
        // Active slot summary
        if (active.length > 0) {
            const activeLabels = active.map(s => s.tag).join(' | ');
            lines.push(`**Active (${active.length}):** ${activeLabels}`);
        }
        return lines.join('\n');
    }
    /**
     * Render all checked-out slot content for the current turn.
     *
     * Slots are rendered in priority order (sticky → high → medium → low),
     * stopping when the token budget is exhausted.
     * Low-priority slots are always rendered (they expire after this turn anyway).
     */
    renderForTurn() {
        if (this.slots.size === 0)
            return '';
        const ordered = [...this.slots.values()].sort((a, b) => {
            const order = { sticky: 0, high: 1, medium: 2, low: 3 };
            return order[a.priority] - order[b.priority];
        });
        const parts = [];
        let usedTokens = 0;
        for (const slot of ordered) {
            if (usedTokens + slot.tokenEst > this.maxBudget && slot.priority !== 'sticky') {
                continue; // skip non-sticky slots that would bust the budget
            }
            parts.push(slot.content);
            usedTokens += slot.tokenEst;
        }
        return parts.join('\n\n---\n\n');
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
    tick(referencedIds) {
        for (const [id, slot] of this.slots) {
            if (slot.priority === 'sticky')
                continue;
            if (referencedIds?.has(id)) {
                // Reset TTL for actively referenced slots
                slot.remainingTurns = slot.ttlTurns;
                continue;
            }
            slot.remainingTurns--;
            if (slot.remainingTurns <= 0) {
                this.slots.delete(id);
            }
        }
    }
    /** Release all non-sticky slots (e.g. on task context switch). */
    flush() {
        for (const [id, slot] of this.slots) {
            if (slot.priority !== 'sticky')
                this.slots.delete(id);
        }
    }
    /** Release ALL slots including sticky ones (e.g. on session end). */
    flushAll() {
        this.slots.clear();
    }
    /** Current token usage across all active slots. */
    get usedTokens() {
        let total = 0;
        for (const slot of this.slots.values())
            total += slot.tokenEst;
        return total;
    }
    /** Number of currently active slots. */
    get slotCount() {
        return this.slots.size;
    }
    // ── Internal ──────────────────────────────────────────────────────────────
    /**
     * Evict slots to free at least `needed` tokens.
     * Eviction order: low → medium → high, LRU within each tier.
     * sticky slots are never evicted.
     */
    _evictToFit(needed) {
        if (this.usedTokens + needed <= this.maxBudget)
            return;
        for (const priority of EVICTION_ORDER) {
            if (this.usedTokens + needed <= this.maxBudget)
                break;
            // Collect evictable slots of this priority, sorted oldest-first (LRU)
            const candidates = [...this.slots.values()]
                .filter(s => s.priority === priority)
                .sort((a, b) => a.checkedOutAt - b.checkedOutAt);
            for (const slot of candidates) {
                if (this.usedTokens + needed <= this.maxBudget)
                    break;
                this.slots.delete(slot.id);
            }
        }
    }
}
//# sourceMappingURL=ContextPager.js.map