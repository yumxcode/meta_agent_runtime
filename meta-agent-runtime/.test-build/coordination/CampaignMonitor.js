/**
 * CampaignMonitor — non-blocking background phase watcher.
 *
 * Responsibilities:
 *   1. Poll CampaignStateStore until all pending task IDs are cleared.
 *   2. When complete: run ParetoAnalyzer (no LLM) → build Capsule → persist.
 *   3. Transition phase (e.g., EVALUATING_L0 → PARETO_READY_L0).
 *   4. Refresh MetaAgentContextStore so the next session sees the new status.
 *   5. Optionally enqueue a notification via the provided callback.
 *
 * Design constraints:
 *   • Zero LLM calls — deterministic, fast, runs in background.
 *   • Non-blocking: watchAsync() returns immediately; polling runs via setInterval.
 *   • Multiple campaigns can be watched concurrently (one interval per campaign).
 *   • Safe to call watchAsync() multiple times for the same campaign (idempotent).
 */
import { CampaignStateStore } from './CampaignStateStore.js';
import { buildCapsule } from './CapsuleBuilder.js';
import { FidelityLadder } from './FidelityLadder.js';
import { MetaAgentContextStore } from './MetaAgentContextStore.js';
import { ParetoAnalyzer } from './ParetoAnalyzer.js';
import { WorkerCoordinator } from './WorkerCoordinator.js';
import { USER_CHECKPOINT_PHASES } from './types.js';
// ── Configuration ─────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 5_000; // 5 s between state.json reloads
const MAX_POLL_DURATION_MS = 24 * 60 * 60 * 1_000; // 24 h safety ceiling
// ── Active watchers registry (prevents duplicate intervals) ──────────────────
// WatchOptions are captured in the setInterval closure — no separate map needed.
const _active = new Map();
const _phaseEntries = new Map();
// ── P1-7: Per-campaign consecutive error counter ──────────────────────────────
// Distinguishes transient disk errors (retry silently) from fatal errors (stop).
const _consecutiveErrors = new Map();
const MAX_TRANSIENT_ERRORS = 10; // stop after 10 consecutive transient failures
/** Returns true for OS-level errors that are safe to retry next tick. */
function _isTransientError(err) {
    const code = err.code;
    return code === 'ENOENT' || code === 'ETIMEDOUT' || code === 'EBUSY' || code === 'EAGAIN';
}
// ── Public API ────────────────────────────────────────────────────────────────
export class CampaignMonitor {
    /**
     * Start watching a campaign in the background. Returns immediately.
     * Idempotent — calling again for the same campaignId is a no-op.
     *
     * Phase 4: pass `evaluationHandler` + `ladderConfig` to enable auto-escalation.
     */
    static watchAsync(campaignId, notifyOrOpts) {
        if (_active.has(campaignId))
            return; // already watching
        // Normalise old single-arg API (notify fn) and new options object
        const opts = typeof notifyOrOpts === 'function'
            ? { notify: notifyOrOpts }
            : (notifyOrOpts ?? {});
        const startedAt = Date.now();
        const effectivePollMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
        const interval = setInterval(async () => {
            // _tick() returns the phase it observed (or null when the campaign stopped
            // or the store was unavailable).  We reuse this value in the timeout checks
            // below to avoid a second CampaignStateStore.load() call per tick.
            let tickPhase = null;
            try {
                tickPhase = await CampaignMonitor._tick(campaignId, opts);
                // Reset consecutive error count on a successful tick
                _consecutiveErrors.delete(campaignId);
            }
            catch (err) {
                // P1-7: Tiered error handling — transient errors are retried; fatal
                // errors stop the watcher immediately to avoid infinite bad-state loops.
                const consecutive = (_consecutiveErrors.get(campaignId) ?? 0) + 1;
                _consecutiveErrors.set(campaignId, consecutive);
                if (_isTransientError(err) && consecutive < MAX_TRANSIENT_ERRORS) {
                    console.warn(`[CampaignMonitor:${campaignId}] Transient error ` +
                        `(${consecutive}/${MAX_TRANSIENT_ERRORS}, will retry next tick):`, err);
                }
                else {
                    console.error(`[CampaignMonitor:${campaignId}] ` +
                        (_isTransientError(err)
                            ? `Too many consecutive transient errors (${consecutive}) — stopping watcher:`
                            : `Fatal error — stopping watcher:`), err);
                    CampaignMonitor._stop(campaignId);
                }
            }
            // ── Timeout checks ──────────────────────────────────────────────────────
            //
            // Two levels:
            //   1. Per-phase timeout (opts.phaseTimeouts) — fires when the campaign has
            //      been in its *current* machine-driven phase too long.
            //   2. Global ceiling (MAX_POLL_DURATION_MS) — 24 h safety net for the
            //      entire watch duration.
            //
            // User-checkpoint phases (PARETO_READY_*) are never timed out here —
            // they block waiting for user input and have no meaningful deadline.
            //
            // We use `tickPhase` (returned by _tick) to avoid a second state load.
            // If tickPhase is null the campaign has already stopped — skip checks.
            if (tickPhase === null)
                return;
            const now = Date.now();
            let timedOut = false;
            let timeoutReason = '';
            // Per-phase timeout check — reuses tickPhase from _tick(); no extra I/O.
            if (opts.phaseTimeouts) {
                const currentPhase = tickPhase;
                // Skip user-checkpoint phases (they block on user input indefinitely)
                if (!USER_CHECKPOINT_PHASES.has(currentPhase)) {
                    const phaseLimit = opts.phaseTimeouts[currentPhase];
                    if (phaseLimit !== undefined) {
                        // Record when we first observed this phase
                        const entry = _phaseEntries.get(campaignId);
                        if (!entry || entry.phase !== currentPhase) {
                            _phaseEntries.set(campaignId, { phase: currentPhase, enteredAt: now });
                        }
                        else if (now - entry.enteredAt > phaseLimit) {
                            timedOut = true;
                            timeoutReason =
                                `Phase timeout: campaign has been in phase ${currentPhase} for ` +
                                    `${Math.round((now - entry.enteredAt) / 60_000)} min ` +
                                    `(limit: ${Math.round(phaseLimit / 60_000)} min)`;
                        }
                    }
                }
            }
            // Global watch-duration ceiling
            if (!timedOut && now - startedAt > MAX_POLL_DURATION_MS) {
                timedOut = true;
                timeoutReason = 'Watch timeout: campaign did not complete within 24 h of monitoring';
            }
            if (timedOut) {
                try {
                    const s = await CampaignStateStore.load(campaignId);
                    if (s.phase !== 'DONE' && s.phase !== 'FAILED') {
                        await s.markFailed(timeoutReason);
                        await CampaignMonitor._refreshContext();
                    }
                }
                catch {
                    // best-effort — stop watching regardless
                }
                CampaignMonitor._stop(campaignId);
            }
        }, effectivePollMs);
        // Allow the Node.js process to exit even if this interval is running
        interval.unref?.();
        _active.set(campaignId, interval);
    }
    /** Stop watching a specific campaign. */
    static stop(campaignId) {
        CampaignMonitor._stop(campaignId);
    }
    /** Stop all active watchers. */
    static stopAll() {
        for (const id of _active.keys()) {
            CampaignMonitor._stop(id);
        }
    }
    /** Returns true if a watcher is currently active for this campaign. */
    static isWatching(campaignId) {
        return _active.has(campaignId);
    }
    // ── Internal ─────────────────────────────────────────────────────────────────
    static _stop(campaignId) {
        const interval = _active.get(campaignId);
        if (interval) {
            clearInterval(interval);
            _active.delete(campaignId);
        }
        _consecutiveErrors.delete(campaignId); // P1-7: clean up error counter
        _phaseEntries.delete(campaignId); // P1-31: clean up per-phase timeout tracking
        // Release all per-campaign runtime state (eval cache + mutation lock)
        CampaignStateStore.cleanup(campaignId);
    }
    /**
     * One poll tick: reload state, check completion, act if done.
     *
     * Returns the campaign phase observed during this tick, or null when the
     * campaign has stopped (terminal phase or store unavailable).  The caller
     * uses this return value for per-phase timeout checks so it does not need to
     * issue a second CampaignStateStore.load() call.
     */
    static async _tick(campaignId, opts) {
        let store;
        try {
            store = await CampaignStateStore.load(campaignId);
        }
        catch {
            // Campaign directory gone — stop watching
            CampaignMonitor._stop(campaignId);
            return null;
        }
        // Terminal phases — nothing left to watch
        if (store.phase === 'DONE' || store.phase === 'FAILED') {
            CampaignMonitor._stop(campaignId);
            await CampaignMonitor._refreshContext();
            return null;
        }
        // Reload to pick up Worker writes
        await store.reload();
        // Capture phase after reload — this is the value returned to the caller.
        const currentPhase = store.phase;
        // PARETO_READY phases are user-checkpoint phases.
        // If autoEscalate is enabled and an evaluationHandler is provided,
        // the monitor can automatically escalate without waiting for user input.
        const ladder = new FidelityLadder(opts.ladderConfig ?? {});
        if (ladder.autoEscalate &&
            opts.evaluationHandler &&
            (store.phase === 'PARETO_READY_L0' || store.phase === 'PARETO_READY_L1')) {
            await CampaignMonitor._autoEscalate(store, opts, ladder);
            return currentPhase;
        }
        // Phase not complete yet
        if (!store.isCurrentPhaseComplete())
            return currentPhase;
        // All tasks done → transition
        await CampaignMonitor._onPhaseComplete(store, opts);
        return currentPhase;
    }
    /**
     * Auto-escalation path: when autoEscalate=true and we're at a PARETO_READY
     * checkpoint, select top-K candidates from the current Pareto front and
     * dispatch them to the next fidelity level via WorkerCoordinator.
     *
     * Flow:
     *   PARETO_READY_L0 → select candidates → ESCALATING_L1 → runParallel(L1)
     *   PARETO_READY_L1 → select candidates → ESCALATING_L2 → runParallel(L2)
     */
    static async _autoEscalate(store, opts, ladder) {
        // Stop watcher while we do async work (prevent re-entry)
        CampaignMonitor._stop(store.campaignId);
        try {
            // Get current best-fidelity evaluations and run Pareto analysis
            const evaluations = await store.getBestFidelityEvaluations(true);
            if (evaluations.length === 0) {
                // No evaluations yet — restart watcher and wait
                CampaignMonitor.watchAsync(store.campaignId, opts);
                return;
            }
            const analyzer = new ParetoAnalyzer(store.designSpace.objectives);
            const front = analyzer.analyze(evaluations);
            // Plan the escalation: select candidates + determine next phase + fidelity
            const plan = ladder.planEscalation(store.phase, front, store.designSpace.objectives);
            if (!plan || plan.candidates.length === 0) {
                // No escalation path from current phase (e.g., PARETO_READY_L2)
                // Fall through to normal completion handling
                await CampaignMonitor._onPhaseComplete(store, opts);
                return;
            }
            const { candidates, targetFidelity, nextPhase } = plan;
            // Transition to the ESCALATING phase before dispatching work
            await store.transitionPhase(nextPhase);
            // Dispatch escalation evaluations in parallel via WorkerCoordinator
            const coordinator = new WorkerCoordinator(store, {
                workerId: `escalate_${nextPhase.toLowerCase()}`,
                maxConcurrent: opts.maxConcurrent ?? 4,
            });
            await coordinator.runParallel(candidates, targetFidelity, opts.evaluationHandler);
            // Refresh context so sessions see the new phase
            await CampaignMonitor._refreshContext();
            // Notify user about escalation
            if (opts.notify) {
                opts.notify(`Campaign: ${store.projectName}`, `Auto-escalating ${candidates.length} candidates to fidelity L${targetFidelity}`);
            }
            // Restart watcher to poll completion of the new ESCALATING phase
            CampaignMonitor.watchAsync(store.campaignId, opts);
        }
        catch (err) {
            try {
                await store.transitionPhase('FAILED');
                await store.failTask('__monitor_escalate__', String(err));
            }
            catch {
                // last-ditch — ignore secondary failure
            }
            if (opts.notify) {
                opts.notify(`Campaign failed: ${store.projectName}`, `Auto-escalation error: ${String(err).slice(0, 120)}`);
            }
            await CampaignMonitor._refreshContext();
        }
    }
    /**
     * Called when all pending tasks for the current phase have finished.
     * Runs Pareto analysis, builds capsule, transitions phase, refreshes context.
     */
    static async _onPhaseComplete(store, opts) {
        // Stop interval for this campaign before doing async work
        // (prevents re-entry if work takes > POLL_INTERVAL_MS)
        CampaignMonitor._stop(store.campaignId);
        const { notify } = opts;
        try {
            // 1. Collect best-fidelity evaluations for each design point
            const evaluations = await store.getBestFidelityEvaluations(true);
            // 2. Run Pareto analysis (pure algorithm, no LLM)
            const analyzer = new ParetoAnalyzer(store.designSpace.objectives);
            const front = evaluations.length > 0 ? analyzer.analyze(evaluations) : null;
            // 3. Build context capsule (deterministic, no LLM)
            const capsule = buildCapsule(store, front);
            // 4. Persist capsule
            await store.saveCapsule(capsule);
            // 5. Transition to next phase
            const nextPhase = CampaignMonitor._nextPhase(store.phase);
            if (nextPhase) {
                await store.transitionPhase(nextPhase);
            }
            // 6. Refresh the global active-context.metaagent
            await CampaignMonitor._refreshContext();
            // 7. Notify user (e.g., via CC's notification system)
            if (notify) {
                notify(`Campaign: ${store.projectName}`, capsule.contextBlock.split('\n').slice(0, 3).join(' '));
            }
            // 8. If the new phase is also a machine-driven phase (shouldn't happen
            //    given current state machine, but guard anyway), re-watch.
            const newPhase = (await CampaignStateStore.load(store.campaignId)).phase;
            if (newPhase !== 'DONE' && newPhase !== 'FAILED') {
                CampaignMonitor.watchAsync(store.campaignId, opts);
            }
        }
        catch (err) {
            // On unexpected error, mark campaign failed and notify
            try {
                await store.transitionPhase('FAILED');
                // Force-write a failure reason to state
                await store.failTask('__monitor__', String(err));
            }
            catch {
                // last-ditch — ignore secondary failure
            }
            if (notify) {
                notify(`Campaign failed: ${store.projectName}`, `Error during phase transition: ${String(err).slice(0, 120)}`);
            }
            await CampaignMonitor._refreshContext();
        }
    }
    /**
     * Re-read all active campaigns and rewrite active-context.metaagent.
     */
    static async _refreshContext() {
        const active = await CampaignStateStore.listActive();
        const summaries = [];
        for (const store of active) {
            const capsule = await store.getCapsule();
            if (capsule) {
                summaries.push({
                    campaignId: store.campaignId,
                    projectName: store.projectName,
                    phase: store.phase,
                    contextBlock: capsule.contextBlock,
                });
            }
            else {
                // No capsule yet (early phases) — generate a minimal status line
                summaries.push({
                    campaignId: store.campaignId,
                    projectName: store.projectName,
                    phase: store.phase,
                    contextBlock: `### ⏳ Campaign: ${store.projectName} [${store.phase}]\nInitializing...`,
                });
            }
        }
        await MetaAgentContextStore.refresh(summaries);
    }
    /**
     * Determine the next phase after current phase completes.
     * Returns null for terminal and user-checkpoint phases
     * (user-checkpoint phases wait for user input — Monitor doesn't advance them).
     */
    static _nextPhase(current) {
        // Machine-to-ready transitions
        const autoTransitions = {
            SAMPLING: 'EVALUATING_L0',
            EVALUATING_L0: 'PARETO_READY_L0',
            ESCALATING_L1: 'PARETO_READY_L1',
            ESCALATING_L2: 'PARETO_READY_L2',
            REPORTING: 'DONE',
        };
        return autoTransitions[current] ?? null;
    }
}
//# sourceMappingURL=CampaignMonitor.js.map