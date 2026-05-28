/**
 * AutoCompact — check if auto-compact should trigger and run it.
 * Mirrors CC's autoCompact.ts.
 *
 * Key details:
 * - Circuit breaker: stop after MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES consecutive failures
 * - Recursion guard: skip if querySource is 'compact' or 'session_memory'
 * - DISABLE_AUTO_COMPACT / DISABLE_COMPACT env vars
 */
import type { KernelMessage } from '../types/KernelMessage.js';
import type { FileStateCache } from '../session/FileStateCache.js';
import type { CompactOptions } from './CompactConversation.js';
export interface AutoCompactTrackingState {
    /** Whether this session has been compacted at least once */
    compacted: boolean;
    /** UUID to correlate compact events */
    turnId: string;
    /** Resets to 0 on each compact, increments each loop turn */
    turnCounter: number;
    /** Consecutive compact failures (reset to 0 on success) */
    consecutiveFailures: number;
}
export interface AutoCompactResult {
    wasCompacted: boolean;
    /** New messages if compaction ran (replaces the pre-compact messages in the loop) */
    postCompactMessages?: KernelMessage[];
    /** Estimated token count of the compact summary */
    summaryTokenEstimate?: number;
    /** Updated tracking state */
    tracking: AutoCompactTrackingState;
}
/**
 * Check if auto-compact should trigger, and if so run it.
 *
 * @param messagesForQuery  - The messages that will be sent to the API (after boundary slice)
 * @param model             - Current main loop model
 * @param fileCache         - Session file state cache (will be cleared on compact)
 * @param querySource       - Recursion guard
 * @param tracking          - Current circuit breaker state
 * @param compactOptions    - Options forwarded to compactConversation
 */
export declare function autoCompactIfNeeded(messagesForQuery: readonly KernelMessage[], model: string, fileCache: FileStateCache, querySource: string | undefined, tracking: AutoCompactTrackingState | undefined, maxOutputTokens: number | undefined, compactOptions: CompactOptions, force?: boolean): Promise<AutoCompactResult>;
//# sourceMappingURL=AutoCompact.d.ts.map