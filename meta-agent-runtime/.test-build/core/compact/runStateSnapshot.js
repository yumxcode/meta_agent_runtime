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
import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────
const META_AGENT_DIR = join(homedir(), '.claude', 'meta-agent');
function _standaloneSnapshotPath(sessionId) {
    return join(META_AGENT_DIR, `run-state-${sessionId}.json`);
}
function _contractSnapshotPath(contractId) {
    return join(META_AGENT_DIR, 'tasks', contractId, 'run-state.json');
}
export function getRunStateSnapshotPath(sessionId, taskContractId) {
    return taskContractId
        ? _contractSnapshotPath(taskContractId)
        : _standaloneSnapshotPath(sessionId);
}
// ─────────────────────────────────────────────────────────────────────────────
// Step-marker heuristic (shared with SubAgentRunner)
// ─────────────────────────────────────────────────────────────────────────────
const _STEP_RE = /(?:^|\s)(?:##+ )?(?:\*{0,2})step\s+(\d+)(?:\*{0,2})?(?:[:\s—]|$)/gim;
function _countSteps(text) {
    const nums = new Set();
    for (const m of text.matchAll(_STEP_RE)) {
        if (m[1])
            nums.add(m[1]);
    }
    return nums.size;
}
// ─────────────────────────────────────────────────────────────────────────────
// Save
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build and persist a `RunStateSnapshot` before a circuit-breaker exit.
 *
 * Fire-and-forget safe — awaiting is optional; errors are swallowed.
 * Callers should `void saveRunStateSnapshot(...).catch(() => {})`.
 */
export async function saveRunStateSnapshot(opts) {
    try {
        const { sessionId, taskContractId, stopReason, turnsUsed, costUsd, accumulatedText, sessionStartMs, rtx, } = opts;
        // ── Provenance data ──────────────────────────────────────────────────────
        const latestProvenanceIds = [];
        const unresolvedWarnings = [];
        if (rtx?.provenanceTracker) {
            try {
                const records = await rtx.provenanceTracker.list({ since: sessionStartMs });
                for (const r of [...records].reverse()) {
                    latestProvenanceIds.push(r.id);
                    const hasIssue = r.validationResults.some(v => !v.passed || v.severity === 'warning');
                    if (hasIssue)
                        unresolvedWarnings.push(r.id);
                }
            }
            catch { /* provenanceTracker unavailable */ }
        }
        // ── Recommended action ───────────────────────────────────────────────────
        const recommendedNextAction = _buildRecommendedAction(stopReason, turnsUsed, unresolvedWarnings, costUsd);
        const snapshot = {
            schemaVersion: '1.0',
            sessionId,
            taskContractId,
            savedAt: new Date().toISOString(),
            stopReason,
            turnsUsed,
            costUsd,
            latestProvenanceIds,
            unresolvedWarnings,
            stepsDetected: _countSteps(accumulatedText),
            lastTextSlice: accumulatedText.slice(-500),
            recommendedNextAction,
        };
        const path = getRunStateSnapshotPath(sessionId, taskContractId);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf-8');
    }
    catch {
        // Never propagate — snapshot is advisory
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Schema validation
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Type predicate that validates all required fields of a `RunStateSnapshot`.
 *
 * Guards against truncated writes (disk-full, crash mid-write) that would
 * produce a valid JSON object with the correct schemaVersion but missing
 * critical fields like `stopReason` or `turnsUsed`.
 */
function _isValidSnapshot(parsed) {
    if (typeof parsed !== 'object' || parsed === null)
        return false;
    const p = parsed;
    return (p['schemaVersion'] === '1.0' &&
        typeof p['sessionId'] === 'string' && p['sessionId'].length > 0 &&
        typeof p['savedAt'] === 'string' &&
        typeof p['stopReason'] === 'string' &&
        typeof p['turnsUsed'] === 'number' &&
        typeof p['costUsd'] === 'number' &&
        Array.isArray(p['latestProvenanceIds']) &&
        Array.isArray(p['unresolvedWarnings']) &&
        typeof p['stepsDetected'] === 'number' &&
        typeof p['lastTextSlice'] === 'string' &&
        typeof p['recommendedNextAction'] === 'string');
}
// ─────────────────────────────────────────────────────────────────────────────
// Load
// ─────────────────────────────────────────────────────────────────────────────
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
export async function loadRunStateSnapshot(sessionId, taskContractId) {
    const paths = taskContractId
        ? [_contractSnapshotPath(taskContractId), _standaloneSnapshotPath(sessionId)]
        : [_standaloneSnapshotPath(sessionId)];
    for (const path of paths) {
        try {
            const raw = await readFile(path, 'utf-8');
            const parsed = JSON.parse(raw);
            if (!_isValidSnapshot(parsed))
                continue;
            const snap = parsed;
            // Reject snapshots written by a different session (e.g., a prior resume
            // that used the same contract but a different session ID).
            if (snap.sessionId !== sessionId)
                continue;
            return snap;
        }
        catch { /* file missing or corrupt — try next */ }
    }
    return null;
}
// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Delete any run-state snapshot for a session.
 * Called on successful terminal result so stale snapshots don't mislead
 * resumed sessions about prior circuit-breaker hits.
 */
export async function cleanupRunStateSnapshot(sessionId, taskContractId) {
    const paths = taskContractId
        ? [_contractSnapshotPath(taskContractId), _standaloneSnapshotPath(sessionId)]
        : [_standaloneSnapshotPath(sessionId)];
    await Promise.allSettled(paths.map(p => unlink(p)));
}
// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function _buildRecommendedAction(reason, turnsUsed, unresolvedWarnings, costUsd) {
    const warnSuffix = unresolvedWarnings.length > 0
        ? ` Review unresolved V&V warnings (${unresolvedWarnings.length}) before continuing.`
        : '';
    switch (reason) {
        case 'max_budget':
            return (`Session stopped after ${turnsUsed} turns ($${costUsd.toFixed(4)}) due to budget limit. ` +
                `Increase maxBudgetUsd or resume with a higher allowance.${warnSuffix}`);
        case 'max_turns':
            return (`Session stopped after ${turnsUsed} turns (turn limit reached). ` +
                `Call submit() again to continue; the task history is preserved.${warnSuffix}`);
        case 'timeout':
            return (`Session timed out after ${turnsUsed} turns. ` +
                `Resume with a new submit() call.${warnSuffix}`);
        case 'cancelled':
            return (`Session was cancelled after ${turnsUsed} turns. ` +
                `Inspect the snapshot and restart if needed.${warnSuffix}`);
    }
}
//# sourceMappingURL=runStateSnapshot.js.map