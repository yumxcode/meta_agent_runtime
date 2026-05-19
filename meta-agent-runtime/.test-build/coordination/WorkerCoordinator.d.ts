/**
 * WorkerCoordinator — parallel design-point evaluation engine.
 *
 * Responsibilities:
 *   1. Register all task IDs with CampaignStateStore BEFORE starting
 *      (so CampaignMonitor's poll loop sees them as "pending").
 *   2. Execute evaluation handler for each design point in parallel,
 *      bounded by maxConcurrent (default: 4).
 *   3. Write each result to store.evaluations.jsonl on completion.
 *   4. Mark tasks complete or failed in state.json after each finishes.
 *   5. Resolve (or never reject) when all tasks have settled.
 *
 * The EvaluationHandler is a pure function: given a DesignPoint + fidelity,
 * it returns the objective values, constraint satisfaction, and feasibility.
 * The WorkerCoordinator wraps timing, provenance ID generation, and
 * persistence around it.
 *
 * Design notes:
 *   • Uses a semaphore-style concurrency limiter (no external dependency).
 *   • Each task failure is isolated — one failure does not abort the batch.
 *   • Stable task IDs are derived from workerId + point index + point ID hash
 *     so the same points + same workerId always produce the same task IDs
 *     (safe for idempotent retry).
 */
import type { CampaignStateStore } from './CampaignStateStore.js';
import type { Constraint, DesignPoint, EvaluationResult, FidelityLevel, Objective } from './types.js';
/**
 * The function that actually computes objective values for a design point.
 *
 * The handler receives:
 *   point       — variable assignments to evaluate
 *   fidelity    — which fidelity level to use (0=L0, 1=L1, 2=L2…)
 *   objectives  — list of objectives (names + directions)
 *   constraints — list of constraints to satisfy
 *
 * It must return:
 *   objectives         — { [objectiveName]: number }
 *   constraintsSatisfied — { [constraintName]: boolean }
 *   feasible           — true if all hard constraints are satisfied
 *   provenanceId       — opaque ID linking back to ProvenanceTracker
 */
export type EvaluationHandler = (point: DesignPoint, fidelity: FidelityLevel, objectives: Objective[], constraints: Constraint[]) => Promise<Pick<EvaluationResult, 'objectives' | 'constraintsSatisfied' | 'feasible' | 'provenanceId'>>;
export interface WorkerCoordinatorOptions {
    /** Unique identifier for this coordinator instance. Auto-generated if omitted. */
    workerId?: string;
    /** Maximum number of evaluations to run simultaneously. Default: 4. */
    maxConcurrent?: number;
}
export declare class WorkerCoordinator {
    private store;
    private workerId;
    private maxConcurrent;
    constructor(store: CampaignStateStore, opts?: WorkerCoordinatorOptions);
    get id(): string;
    /**
     * Run all design points through the evaluation handler in parallel.
     *
     * Returns the list of task IDs.  Each ID is either in completedTaskIds
     * or failedTaskIds in the store after this resolves.
     */
    runParallel(points: DesignPoint[], fidelity: FidelityLevel, handler: EvaluationHandler): Promise<string[]>;
    /**
     * Run a single design point and return the full EvaluationResult.
     * Convenience wrapper around runParallel for one-shot evaluations.
     */
    runSingle(point: DesignPoint, fidelity: FidelityLevel, handler: EvaluationHandler): Promise<EvaluationResult | null>;
}
//# sourceMappingURL=WorkerCoordinator.d.ts.map