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
 * Storage: in-memory + best-effort project-local persistence.  Pending entries
 * survive normal restarts so the user can review them after resuming the
 * robotics project; they are never auto-committed.
 */
import type { ExperienceStore } from './ExperienceStore.js';
export interface PendingExperience {
    /** Temporary pending ID (not the final ExperienceStore ID). */
    pendingId: string;
    proposedAt: number;
    /** Raw input exactly as the AI provided to experience_write. */
    input: Record<string, unknown>;
}
export declare class ExperiencePendingStore {
    private readonly _pending;
    private readonly _filePath;
    constructor(projectDir?: string);
    /** Load pending entries persisted for this project, if any. */
    load(): Promise<void>;
    /** Queue an experience for later review. Returns the temporary pending ID. */
    add(input: Record<string, unknown>): string;
    /** All pending entries in proposal order. */
    list(): readonly PendingExperience[];
    /** Number of pending entries awaiting review. */
    get count(): number;
    /** Remove one pending entry (after commit or discard). */
    remove(pendingId: string): boolean;
    /** Clear all pending entries (e.g. on session end after review). */
    clear(): void;
    /**
     * Commit one pending entry to the ExperienceStore.
     * Returns the committed experience ID, or null on failure.
     */
    commit(pendingId: string, store: ExperienceStore): Promise<string | null>;
    private _persistSoon;
    private _persist;
}
//# sourceMappingURL=ExperiencePendingStore.d.ts.map