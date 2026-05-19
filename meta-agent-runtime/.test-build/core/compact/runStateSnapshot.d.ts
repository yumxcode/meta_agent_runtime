/**
 * RunStateSnapshot — persisted recovery state for circuit-breaker exits.
 *
 * Written to disk immediately before MetaAgentSession yields an
 * `error_max_budget` or `error_max_turns` result event.  Allows callers
 * (parent workflows, resumed sessions, retry logic) to understand what
 * was accomplished, what remains, and what should happen next — without
 * having to re-parse the conversation history.
 *
 * Storage:
 *   - When a TaskContract is active:  ~/.claude/meta-agent/tasks/<contractId>/run-state.json
 *   - Standalone (no contract):       ~/.claude/meta-agent/run-state-<sessionId>.json
 *
 * Design invariants:
 *   - Written fire-and-forget; never throws from the caller's perspective.
 *   - Deleted (or superseded) by a successful terminal result so stale
 *     snapshots from prior circuit-breaker hits don't surface on resume.
 *   - Reading returns null on any error so callers can degrade gracefully.
 */
import type { RuntimeContext } from '../../runtime/RuntimeContext.js';
export type RunStateStopReason = 'max_budget' | 'max_turns' | 'timeout' | 'cancelled';
/**
 * Structured recovery state written on circuit-breaker exits.
 *
 * Fields are best-effort — populated from whatever data is available at
 * stop time.  Callers must never rely on completeness; treat as orientation
 * cues for safe resumption.
 */
export interface RunStateSnapshot {
    schemaVersion: '1.0';
    sessionId: string;
    /** Linked TaskContract ID, if any was active when the session stopped. */
    taskContractId?: string;
    /** ISO 8601 timestamp when the snapshot was written. */
    savedAt: string;
    stopReason: RunStateStopReason;
    /** Turns completed before the circuit breaker fired. */
    turnsUsed: number;
    /** Approximate cost at stop time (USD). */
    costUsd: number;
    /**
     * Provenance IDs produced during this session, newest-first.
     * Enables resume logic to call `get_provenance()` on prior work.
     */
    latestProvenanceIds: string[];
    /**
     * Provenance IDs whose V&V produced warnings or failures.
     * Must be reviewed and resolved before safe continuation.
     */
    unresolvedWarnings: string[];
    /**
     * Heuristic: numbered step markers found in accumulated output text.
     * 0 when no step-marker patterns were detected.
     */
    stepsDetected: number;
    /**
     * Last 500 characters of accumulated output text at stop time.
     * Gives context for what the session was working on.
     */
    lastTextSlice: string;
    /** Human-readable suggestion for resuming safely. */
    recommendedNextAction: string;
}
export declare function getRunStateSnapshotPath(sessionId: string, taskContractId?: string): string;
/**
 * Build and persist a `RunStateSnapshot` before a circuit-breaker exit.
 *
 * Fire-and-forget safe — awaiting is optional; errors are swallowed.
 * Callers should `void saveRunStateSnapshot(...).catch(() => {})`.
 */
export declare function saveRunStateSnapshot(opts: {
    sessionId: string;
    taskContractId?: string;
    stopReason: RunStateStopReason;
    turnsUsed: number;
    costUsd: number;
    accumulatedText: string;
    sessionStartMs: number;
    rtx?: RuntimeContext;
}): Promise<void>;
/**
 * Load the most recent run-state snapshot for a session.
 *
 * Checks contract path first (if `taskContractId` provided), then standalone.
 * Returns null if no snapshot exists, is corrupt, or its sessionId does not
 * match the expected session.
 *
 * The sessionId check prevents stale snapshots from a prior session (which
 * shared the same TaskContract via resume) from being mistaken for the current
 * session's circuit-breaker state.
 *
 * @param sessionId       The current session ID to match against.
 * @param taskContractId  Optional contract ID — used to locate contract-scoped
 *                        snapshots (checked before the standalone path).
 */
export declare function loadRunStateSnapshot(sessionId: string, taskContractId?: string): Promise<RunStateSnapshot | null>;
/**
 * Delete any run-state snapshot for a session.
 * Called on successful terminal result so stale snapshots don't mislead
 * resumed sessions about prior circuit-breaker hits.
 */
export declare function cleanupRunStateSnapshot(sessionId: string, taskContractId?: string): Promise<void>;
//# sourceMappingURL=runStateSnapshot.d.ts.map