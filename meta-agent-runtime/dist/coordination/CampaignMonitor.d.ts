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
import type { FidelityLadderConfig } from './FidelityLadder.js';
import type { EvaluationHandler } from './WorkerCoordinator.js';
import type { CampaignPhase } from './types.js';
/** Callback type for user-facing notifications (e.g., CC's enqueuePendingNotification) */
export type NotifyFn = (title: string, body: string) => void;
/** Options for watchAsync — Phase 4 additions. */
export interface WatchOptions {
    notify?: NotifyFn;
    /**
     * When provided, Monitor can auto-escalate to higher fidelity levels
     * using this handler.  Required for autoEscalate to work.
     */
    evaluationHandler?: EvaluationHandler;
    /** Fidelity-ladder configuration (auto-escalation thresholds). */
    ladderConfig?: Partial<FidelityLadderConfig>;
    /** Max parallel evaluations during auto-escalation. Default: 4. */
    maxConcurrent?: number;
    /**
     * Override the default poll interval (5 s) for this watcher.
     * Useful for testing (set to 100 ms) or slow-polling high-cost campaigns
     * (set to 60_000 ms).
     */
    pollIntervalMs?: number;
    /**
     * Per-phase timeout in milliseconds.  When a machine-driven phase exceeds
     * its configured timeout the campaign is marked FAILED.
     *
     * Example:
     *   phaseTimeouts: {
     *     EVALUATING_L0:  30 * 60 * 1_000,   // 30 min
     *     ESCALATING_L1:  2 * 60 * 60 * 1_000, // 2 h
     *     ESCALATING_L2:  6 * 60 * 60 * 1_000, // 6 h
     *   }
     *
     * Phases not listed fall back to the global MAX_POLL_DURATION_MS (24 h).
     * User-checkpoint phases (PARETO_READY_*) are never timed out by the Monitor
     * — they wait indefinitely for user input.
     */
    phaseTimeouts?: Partial<Record<CampaignPhase, number>>;
}
export declare class CampaignMonitor {
    /**
     * Start watching a campaign in the background. Returns immediately.
     * Idempotent — calling again for the same campaignId is a no-op.
     *
     * Phase 4: pass `evaluationHandler` + `ladderConfig` to enable auto-escalation.
     */
    static watchAsync(campaignId: string, notifyOrOpts?: NotifyFn | WatchOptions): void;
    /** Stop watching a specific campaign. */
    static stop(campaignId: string): void;
    /** Stop all active watchers. */
    static stopAll(): void;
    /** Returns true if a watcher is currently active for this campaign. */
    static isWatching(campaignId: string): boolean;
    private static _stop;
    /**
     * One poll tick: reload state, check completion, act if done.
     *
     * Returns the campaign phase observed during this tick, or null when the
     * campaign has stopped (terminal phase or store unavailable).  The caller
     * uses this return value for per-phase timeout checks so it does not need to
     * issue a second CampaignStateStore.load() call.
     */
    private static _tick;
    /**
     * Auto-escalation path: when autoEscalate=true and we're at a PARETO_READY
     * checkpoint, select top-K candidates from the current Pareto front and
     * dispatch them to the next fidelity level via WorkerCoordinator.
     *
     * Flow:
     *   PARETO_READY_L0 → select candidates → ESCALATING_L1 → runParallel(L1)
     *   PARETO_READY_L1 → select candidates → ESCALATING_L2 → runParallel(L2)
     */
    private static _autoEscalate;
    /**
     * Called when all pending tasks for the current phase have finished.
     * Runs Pareto analysis, builds capsule, transitions phase, refreshes context.
     */
    private static _onPhaseComplete;
    /**
     * Re-read all active campaigns and rewrite active-context.metaagent.
     */
    private static _refreshContext;
    /**
     * Determine the next phase after current phase completes.
     * Returns null for terminal and user-checkpoint phases
     * (user-checkpoint phases wait for user input — Monitor doesn't advance them).
     */
    private static _nextPhase;
}
//# sourceMappingURL=CampaignMonitor.d.ts.map