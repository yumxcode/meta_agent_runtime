/**
 * V&V (Validation & Verification) — core types
 *
 * Engineering simulations don't "error out" when they're wrong — they just
 * produce incorrect numbers. The V&V hook system provides a structured way
 * to catch those incorrect numbers before they propagate into decisions.
 *
 * Hook lifecycle phases:
 *
 *   pre_call        — runs before a tool is called; can block bad inputs
 *   post_call       — runs after a tool returns; validates the output
 *   pre_compact     — runs before CC context compaction; ensures numbers
 *                     are preserved in the summary
 *   post_session    — runs at session end; cross-simulation consistency
 *
 * Severity / suggested action matrix:
 *
 *   info            → continue (log only)
 *   warning         → warn_user (surface to user, continue)
 *   error           → pause_and_ask (agent pauses and explains the issue)
 *   critical        → abort (halt the tool call / session)
 */
// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
/** Derive a suggestedAction from severity when the hook doesn't specify */
export function defaultAction(severity) {
    switch (severity) {
        case 'info': return 'continue';
        case 'warning': return 'warn_user';
        case 'error': return 'pause_and_ask';
        case 'critical': return 'abort';
    }
}
/** Check whether any result in a set requires stopping */
export function requiresAbort(results) {
    return results.some(r => !r.passed && r.suggestedAction === 'abort');
}
/** Check whether any result requires pausing */
export function requiresPause(results) {
    return results.some(r => !r.passed && r.suggestedAction === 'pause_and_ask');
}
/** Filter to only failed results */
export function failures(results) {
    return results.filter(r => !r.passed);
}
/** Highest severity in a result set */
export function maxSeverity(results) {
    const order = ['critical', 'error', 'warning', 'info'];
    for (const s of order) {
        if (results.some(r => r.severity === s))
            return s;
    }
    return null;
}
//# sourceMappingURL=types.js.map