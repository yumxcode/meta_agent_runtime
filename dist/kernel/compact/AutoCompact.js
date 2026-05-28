import { compactConversation } from './CompactConversation.js';
import { calculateTokenWarningState, isAutoCompactDisabled } from '../utils/Context.js';
import { tokenCountWithEstimation } from '../api/TokenCount.js';
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
const SKIPPED_QUERY_SOURCES = new Set(['compact', 'session_memory']);
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
export async function autoCompactIfNeeded(messagesForQuery, model, fileCache, querySource, tracking, maxOutputTokens, compactOptions, force = false) {
    const currentTracking = tracking ?? {
        compacted: false,
        turnId: crypto.randomUUID(),
        turnCounter: 0,
        consecutiveFailures: 0,
    };
    // ── Recursion guard ───────────────────────────────────────────────────────
    if (querySource && SKIPPED_QUERY_SOURCES.has(querySource)) {
        return { wasCompacted: false, tracking: currentTracking };
    }
    // ── Global disable ────────────────────────────────────────────────────────
    if (isAutoCompactDisabled()) {
        return { wasCompacted: false, tracking: currentTracking };
    }
    // ── Circuit breaker ───────────────────────────────────────────────────────
    if (currentTracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
        return { wasCompacted: false, tracking: currentTracking };
    }
    // ── Token threshold check ─────────────────────────────────────────────────
    const tokenCount = tokenCountWithEstimation(messagesForQuery);
    const { isAtCompactThreshold } = calculateTokenWarningState(tokenCount, model, maxOutputTokens);
    if (!force && !isAtCompactThreshold) {
        return { wasCompacted: false, tracking: { ...currentTracking, turnCounter: currentTracking.turnCounter + 1 } };
    }
    // ── Run compact ───────────────────────────────────────────────────────────
    try {
        const result = await compactConversation(messagesForQuery, fileCache, compactOptions);
        const newTracking = {
            compacted: true,
            turnId: crypto.randomUUID(),
            turnCounter: 0,
            consecutiveFailures: 0, // success → reset
        };
        return {
            wasCompacted: true,
            postCompactMessages: result.postCompactMessages,
            summaryTokenEstimate: result.summaryTokenEstimate,
            tracking: newTracking,
        };
    }
    catch (_error) {
        // Compact failed — increment circuit breaker, continue without compacting
        const newTracking = {
            ...currentTracking,
            consecutiveFailures: currentTracking.consecutiveFailures + 1,
        };
        return { wasCompacted: false, tracking: newTracking };
    }
}
//# sourceMappingURL=AutoCompact.js.map