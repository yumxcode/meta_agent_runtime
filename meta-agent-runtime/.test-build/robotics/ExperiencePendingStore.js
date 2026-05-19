/**
 * ExperiencePendingStore — session-scoped buffer for AI-proposed experiences.
 *
 * When the AI calls experience_write, the entry is held here instead of
 * committing directly to the shared ExperienceStore.  The user reviews
 * pending entries via the `/experience review` REPL command (or at session
 * end when cleanup is triggered).
 *
 * Only approved entries are committed to the cross-session ExperienceStore.
 * This prevents low-quality, premature, or incorrect experiences from
 * polluting the shared knowledge base.
 *
 * Storage: in-memory only (pending entries don't survive a crash — that is
 * intentional; a crashed session's unreviewed entries are simply lost rather
 * than auto-committed).
 */
// ── ExperiencePendingStore ────────────────────────────────────────────────────
export class ExperiencePendingStore {
    _pending = [];
    /** Queue an experience for later review. Returns the temporary pending ID. */
    add(input) {
        const pendingId = `pending_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        this._pending.push({ pendingId, proposedAt: Date.now(), input });
        return pendingId;
    }
    /** All pending entries in proposal order. */
    list() {
        return this._pending;
    }
    /** Number of pending entries awaiting review. */
    get count() {
        return this._pending.length;
    }
    /** Remove one pending entry (after commit or discard). */
    remove(pendingId) {
        const idx = this._pending.findIndex(p => p.pendingId === pendingId);
        if (idx < 0)
            return false;
        this._pending.splice(idx, 1);
        return true;
    }
    /** Clear all pending entries (e.g. on session end after review). */
    clear() {
        this._pending.length = 0;
    }
    /**
     * Commit one pending entry to the ExperienceStore.
     * Returns the committed experience ID, or null on failure.
     */
    async commit(pendingId, store) {
        const entry = this._pending.find(p => p.pendingId === pendingId);
        if (!entry)
            return null;
        try {
            const input = entry.input;
            const id = await store.write({
                domain: input['domain'] ?? 'general',
                title: String(input['title'] ?? ''),
                problem: String(input['problem'] ?? ''),
                solution: String(input['solution'] ?? ''),
                outcome: {
                    success: Boolean(input['success']),
                    summary: String(input['outcome_summary'] ?? ''),
                    failureReason: input['failure_reason'],
                    workarounds: input['workarounds'],
                },
                algorithm: input['algorithm'],
                tags: input['tags'] ?? [],
                robot: input['robot'],
                difficulty: input['difficulty'] ?? 'medium',
                metrics: input['metrics'],
                relatedPapers: input['related_papers'],
                sourceTaskId: input['source_task_id'],
                fullReport: input['full_report'],
            });
            this.remove(pendingId);
            return id;
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=ExperiencePendingStore.js.map