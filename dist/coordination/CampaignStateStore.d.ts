/**
 * CampaignStateStore — disk-backed state machine for a DOE campaign.
 *
 * Storage layout under ~/.claude/meta-agent/campaigns/<campaignId>/:
 *   state.json          — phase + metadata (overwrite on each transition)
 *   evaluations.jsonl   — EvaluationResult lines (append-only, concurrent-safe)
 *   capsule.json        — pre-computed CampaignContextCapsule
 *   workers/            — per-worker log files
 *   snapshots/          — immutable phase-boundary snapshots
 *   report.md           — final report (written on DONE)
 *
 * Key invariants:
 *   • evaluations.jsonl is append-only: multiple Workers can write concurrently.
 *   • state.json is overwrite on each phase transition (single writer: Monitor).
 *   • campaignId encodes projectName so directories are human-readable.
 */
import type { CampaignContextCapsule, CampaignPhase, DesignPoint, DesignSpace, EvaluationResult } from './types.js';
export declare const META_AGENT_ROOT: string;
export declare const CAMPAIGNS_ROOT: string;
/** Generate a campaign ID: c_<6-char hash>_<slug> */
export declare function makeCampaignId(projectName: string): string;
export declare class CampaignStateStore {
    private static readonly _evalCache;
    private static readonly _EVAL_CACHE_MAX;
    /**
     * S5: read with LRU touch — caller passes the cached entry to indicate it was
     * just used.  Re-inserting in a Map moves the key to the back of insertion
     * order, which gives us O(1) LRU semantics for free.
     */
    private static _touchEvalCache;
    private static readonly _mutationLock;
    /**
     * Release all per-campaign runtime state (eval cache + mutation lock).
     * Called by CampaignMonitor._stop() when a campaign finishes or is cancelled.
     *
     * The lock entry is self-cleaning: _withLock() decrements count after each
     * operation and removes the entry when count reaches 0.  This call is
     * therefore a best-effort nudge for the case where count is already 0
     * (e.g., no operations ran between campaign start and stop).
     */
    /**
     * Flush ALL static state for test isolation.
     *
     * Clears every campaign's eval cache and lock entry from the process-level maps.
     * Safe to call only when no campaign operations are in flight (i.e., at the start
     * or end of a test — never during a running campaign).
     *
     * @testonly — not intended for production use.
     */
    static resetAllForTest(): void;
    static cleanup(campaignId: string): void;
    readonly campaignId: string;
    readonly projectName: string;
    readonly dir: string;
    readonly paths: {
        state: string;
        evaluations: string;
        capsule: string;
        report: string;
        workers: string;
        snapshots: string;
    };
    private _state;
    /**
     * Serialise an async operation within this campaign's mutation lock.
     *
     * Builds a promise-queue (linked chain of .then() calls) so that only one
     * reload→mutate→write triple runs at a time per campaign, even when multiple
     * WorkerCoordinator tasks or CampaignStateStore instances call concurrently
     * in the same Node.js event loop.
     *
     * Reference-counting (P0 fix):
     *   count is incremented before queuing the operation and decremented when
     *   the operation settles (success or error).  When count reaches 0 the entry
     *   is removed from the pool, freeing the Map entry automatically.
     *
     * Error behaviour: if `fn` rejects, the error propagates to the caller but
     * the lock is still released (the stored tail always resolves).
     */
    private _withLock;
    private static _releaseLock;
    private constructor();
    /** Create a brand-new campaign. Persists state.json immediately. */
    static create(projectName: string, designSpace: DesignSpace): Promise<CampaignStateStore>;
    /** Load an existing campaign from disk. Throws if not found or corrupt. */
    static load(campaignId: string): Promise<CampaignStateStore>;
    /**
     * List campaigns that are genuinely active — not terminal, not zombie.
     *
     * Zombie detection: any non-terminal campaign whose `updatedAt` timestamp
     * is older than the phase-appropriate threshold is automatically marked
     * FAILED on disk and excluded from the result.
     *
     *   Machine phases  (SAMPLING / EVALUATING_* / ESCALATING_* / REPORTING / IDLE)
     *     → 48 h threshold. Workers don't silently run for 2 days; if no update
     *       in that window the campaign was abandoned without a clean shutdown.
     *
     *   User checkpoint phases  (PARETO_READY_*)
     *     → 7-day threshold. The user may be reviewing Pareto results.
     *
     * This is the *only* place zombie expiry fires — historically it was
     * invoked from ModeDetector once per session; that hook has been removed
     * but `listActive()` is still called by CampaignSession bootstrap and by
     * CLI status commands, which is sufficient to keep the disk clean without
     * a dedicated background sweeper.
     */
    static listActive(): Promise<CampaignStateStore[]>;
    /** List ALL campaigns (including DONE/FAILED), sorted by createdAt desc. */
    static listAll(): Promise<CampaignStateStore[]>;
    /**
     * Scan CAMPAIGNS_ROOT and load every campaign directory that can be parsed.
     * Silently skips corrupted or partially-written directories.
     */
    private static _loadAll;
    get phase(): CampaignPhase;
    /** ISO-8601 timestamp of the most recent state mutation. */
    get updatedAt(): string;
    get designSpace(): DesignSpace;
    get sampledPoints(): DesignPoint[];
    get pendingTaskCount(): number;
    get completedTaskCount(): number;
    get failedTaskCount(): number;
    /**
     * True when at least one task has been registered AND all registered tasks
     * have completed or failed (pendingTaskIds is empty).
     *
     * Returns false if no tasks have ever been registered for this phase —
     * distinguishes "not yet started" from "all done".
     */
    isCurrentPhaseComplete(): boolean;
    /** Record the DOE-sampled points and transition IDLE → SAMPLING. */
    setSampledPoints(points: DesignPoint[]): Promise<void>;
    /**
     * Register task IDs that have been dispatched to background Workers.
     * Called by the Coordinator just before spawning Workers.
     */
    registerPendingTasks(taskIds: string[]): Promise<void>;
    /**
     * Mark a task as completed. Called by Worker via submit_evaluation_results tool.
     * Serialised through _withLock so concurrent calls from the same process
     * cannot interleave their reload→mutate→write sequences.
     */
    completeTask(taskId: string): Promise<void>;
    /**
     * Mark a task as failed.
     * Serialised through _withLock (same reason as completeTask).
     */
    failTask(taskId: string, reason?: string): Promise<void>;
    /**
     * Append an EvaluationResult to evaluations.jsonl.
     * POSIX appendFile is atomic for small writes — multiple Workers can call
     * this concurrently without corrupting the file.
     */
    submitResult(result: EvaluationResult): Promise<void>;
    /**
     * Read evaluation results from evaluations.jsonl using incremental byte-offset
     * tracking. Only newly-appended bytes are read on each call — avoiding a full
     * O(N) file read on every 5 s poll tick.
     *
     * The cumulative result set is stored in a static per-campaign cache that
     * persists across CampaignStateStore.load() calls (new instance per tick).
     * Filters are applied at query time over the full accumulated set.
     *
     * Safe to call concurrently with Workers appending to the file: partial last
     * lines (no trailing newline yet) are left for the next call.
     */
    getEvaluations(filter?: {
        feasibleOnly?: boolean;
        fidelity?: number;
    }): Promise<EvaluationResult[]>;
    /**
     * For each designPoint.id, keep only the highest-fidelity result.
     * Used by ParetoAnalyzer to avoid double-counting multi-fidelity evaluations.
     */
    getBestFidelityEvaluations(feasibleOnly?: boolean): Promise<EvaluationResult[]>;
    /**
     * Transition to a new phase. Validates against VALID_TRANSITIONS.
     * Saves an immutable snapshot of state.json before overwriting.
     * Serialised through _withLock to prevent concurrent phase transitions.
     */
    transitionPhase(to: CampaignPhase): Promise<void>;
    /**
     * Atomically mark this campaign as FAILED with a reason string.
     *
     * Unlike `transitionPhase('FAILED')`, this method:
     *   • reloads state from disk first (picks up any concurrent writes)
     *   • sets `failureReason` in the same locked write
     *   • silently no-ops if the campaign is already terminal (DONE / FAILED)
     *
     * Used by:
     *   • `listActive()` zombie auto-expiry
     *   • `CampaignMonitor` 24 h safety ceiling
     */
    markFailed(reason: string): Promise<void>;
    /** Persist a pre-computed context capsule. Called by CampaignMonitor. */
    saveCapsule(capsule: CampaignContextCapsule): Promise<void>;
    /** Read the most recent capsule, or null if not yet generated. */
    getCapsule(): Promise<CampaignContextCapsule | null>;
    saveReport(markdown: string): Promise<void>;
    /**
     * Re-read state.json from disk. Called by CampaignMonitor between poll
     * intervals to pick up task completions written by Workers, and by the
     * mutation methods (_withLock) before each state write.
     *
     * Error handling:
     *   EBUSY / EMFILE — transient disk contention (e.g., concurrent rename on
     *     some OS/FS). Safe to silently keep the current in-memory state.
     *   All other errors (ENOENT, EPERM, JSON parse failure…) — re-thrown so the
     *     caller can detect genuine problems (e.g., campaign directory deleted).
     *     CampaignMonitor's setInterval catch-all will absorb the error, and the
     *     next tick will call load() which will also fail → watcher stops cleanly.
     */
    reload(): Promise<void>;
    appendWorkerLog(workerId: string, line: string): Promise<void>;
    private _writeState;
    private _saveSnapshot;
}
//# sourceMappingURL=CampaignStateStore.d.ts.map