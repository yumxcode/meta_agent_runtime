/**
 * Public type definitions for team mode (v2.0).
 *
 * Three entities, no modules / no paths / no decisions:
 *   - TeamUnit:    a participant
 *   - TeamTask:    something someone is doing
 *   - TeamAttempt: an append-only entry: direction + outcome + ref
 *
 * Re-exported from TeamStore.ts so the existing
 *   import { ... } from './team/TeamStore.js'
 * imports continue to resolve.
 */
/** ms threshold for "claim has gone stale" board warnings (7 days). */
export const STALE_CLAIM_MS = 7 * 24 * 60 * 60 * 1000;
export const VALID_TASK_STATUSES = ['open', 'paused', 'done'];
/** A task is active when someone owns it AND it's not done. */
export function isActiveTask(task) {
    return Boolean(task.ownerUnit) && task.status !== 'done';
}
/** Returns true when the claim is older than STALE_CLAIM_MS. */
export function isStaleClaim(task) {
    if (task.status === 'done')
        return false;
    if (!task.claimedAt)
        return false;
    const claimed = Date.parse(task.claimedAt);
    if (Number.isNaN(claimed))
        return false;
    return Date.now() - claimed > STALE_CLAIM_MS;
}
//# sourceMappingURL=types.js.map