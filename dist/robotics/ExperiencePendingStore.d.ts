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
import { type KnowledgeConfidenceTier, type RoboticsDomain } from './types.js';
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
    private _persistTail;
    constructor(projectDir?: string, root?: string);
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
    /** Wait for queued persistence writes to drain. Primarily useful in tests and graceful shutdown. */
    flush(): Promise<void>;
    /**
     * Commit one pending entry to the ExperienceStore.
     * Returns the committed experience ID, or null on failure.
     */
    commit(pendingId: string, store: ExperienceStore): Promise<string | null>;
    private _persistSoon;
    private _trimToLimit;
    private _persist;
}
type NormalizedExperienceInput = {
    domain: RoboticsDomain;
    title: string;
    problem: string;
    solution: string;
    success: boolean;
    outcomeSummary: string;
    difficulty: 'low' | 'medium' | 'high';
    tags: string[];
    algorithm?: string;
    robot?: string;
    failureReason?: string;
    workarounds?: string[];
    metrics?: Record<string, number | string>;
    relatedPapers?: string[];
    sourceTaskId?: string;
    fullReport?: string;
    abstractPrinciple?: string;
    confidenceTier: KnowledgeConfidenceTier;
    evidenceRefs?: string[];
    observationCount?: number;
    contradictionCount?: number;
    invalidatedAssumptions?: string[];
    lastVerifiedAt?: number;
};
export declare function validateExperienceInput(input: Record<string, unknown>): {
    ok: true;
    value: NormalizedExperienceInput;
} | {
    ok: false;
};
export {};
//# sourceMappingURL=ExperiencePendingStore.d.ts.map