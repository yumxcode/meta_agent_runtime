/**
 * Async Job System — core types
 *
 * Engineering simulations can run for hours. The job system decouples
 * tool submission from result delivery so the agent main loop stays
 * responsive while long-running work executes in the background.
 *
 * State machine:
 *
 *   SUBMITTED → QUEUED → RUNNING → COMPLETED
 *                                └→ FAILED
 *              cancel() from any non-terminal state → CANCELLED
 */
/** Generate a job ID from a domain + tool name pair */
export function makeJobId(domain, toolName) {
    const uuid8 = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const safe = (s) => s.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    return `${safe(domain)}-${safe(toolName)}-${uuid8}`;
}
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
export const ACTIVE_STATUSES = new Set(['submitted', 'queued', 'running']);
//# sourceMappingURL=types.js.map