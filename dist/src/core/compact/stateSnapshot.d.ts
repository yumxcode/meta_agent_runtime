/**
 * Pre-compact state snapshot for the KernelBridge path.
 *
 * Problem:
 *   KernelBridge builds `## Compact Instructions` at the START of each
 *   submit() call, before any tool calls happen.  When CC auto-compacts
 *   mid-turn (after several tool calls), the instructions already written
 *   into the system prompt are stale — they're missing every provenance
 *   record produced during that turn.
 *
 * Solution:
 *   After every tool call (via the `wrapMetaAgentTool` hook) we fire a
 *   fire-and-forget save of the current session state to a JSON file at
 *   ~/.claude/meta-agent/compact-state-<sessionId>.json.
 *   When `_buildEnrichedSuffix()` rebuilds compact instructions it loads
 *   the snapshot and merges any provenance IDs that don't yet appear in
 *   the live tracker.  The snapshot is deleted on interrupt().
 *
 * Used by:
 *   KernelBridge — wrapMetaAgentTool (post-call hook) + _buildEnrichedSuffix
 *   MetaAgentSession — pre-compact save before runCompact()
 *   buildCompactInstructions — snapshot parameter for merge
 */
import type { RuntimeContext } from '../../runtime/RuntimeContext.js';
/** A single provenance record snapshot (minimal — only what compact needs). */
export type CompactStateSnapshotRecord = {
    id: string;
    toolName: string;
    fidelityLevel: number;
    /** V&V pass/warn/fail */
    vv: '✓' | '⚠' | '✗';
    /** Short key=val summary of the 3 most significant inputs */
    inputSummary: string;
};
/** Minimal campaign state snapshot (phase + identity + drift-guard fields). */
export type CompactStateSnapshotCampaign = {
    campaignId: string;
    projectName: string | undefined;
    phase: string;
    /**
     * Pre-rendered contextBlock from the campaign capsule.
     * Reproduced verbatim in compact instructions so the compact model has the
     * full campaign state even when no live context store is available.
     */
    contextBlock?: string;
    /**
     * Human-readable objective strings, e.g. "maximize efficiency (W/kg)".
     * Preserved across compaction so the model never forgets what it is optimising.
     */
    objectives?: string[];
    /**
     * Human-readable constraint strings, e.g. "mass ≤ 5.0 kg (inequality)".
     * Preserved across compaction to prevent drift from constraint-violating proposals.
     */
    constraints?: string[];
};
/** Full snapshot written to disk after each tool call. */
export type CompactStateSnapshot = {
    sessionId: string;
    /** Unix timestamp (ms) when this snapshot was written. */
    capturedAt: number;
    provenanceRecords: CompactStateSnapshotRecord[];
    activeCampaigns: CompactStateSnapshotCampaign[];
};
export declare function getSnapshotPath(sessionId: string): string;
/**
 * Capture current session state and enqueue a serialised disk write.
 *
 * Fix #2 (concurrent writes): instead of firing an independent Promise per
 * tool call, we chain each write behind the previous one for this sessionId.
 * Only the last write in the chain actually matters, so we don't try to
 * coalesce — the overhead of a redundant write is negligible compared to the
 * correctness benefit of never interleaving writes to the same file.
 *
 * Fix #7 (silent mkdir failure): the first write failure is logged once so
 * operators can detect a misconfigured home directory.
 *
 * Fire-and-forget safe: this function never throws.  Callers should use
 * `void saveStateSnapshot(...).catch(() => {})`.
 */
export declare function saveStateSnapshot(sessionId: string, rtx: RuntimeContext | undefined, sessionStartMs: number): Promise<void>;
/**
 * Load a previously saved snapshot.  Returns null if no snapshot exists or
 * if the file is corrupt / unreadable.
 */
export declare function loadStateSnapshot(sessionId: string): Promise<CompactStateSnapshot | null>;
/**
 * Delete the snapshot file for a session and remove its write chain.
 * Called on interrupt() so stale state from a cancelled turn isn't picked up
 * by a subsequent submit().
 */
export declare function cleanupStateSnapshot(sessionId: string): Promise<void>;
//# sourceMappingURL=stateSnapshot.d.ts.map