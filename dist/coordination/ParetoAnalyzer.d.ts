/**
 * ParetoAnalyzer — non-dominated sorting for multi-objective optimization.
 *
 * Algorithm: fast non-dominated sort (NSGA-II style), O(M × N²).
 * M = number of objectives, N = number of evaluation results.
 *
 * All computation is deterministic and LLM-free. Safe to run inside
 * CampaignMonitor's background polling loop.
 */
import type { EvaluationResult, Objective, ParetoFront } from './types.js';
export declare class ParetoAnalyzer {
    private objectives;
    constructor(objectives: Objective[]);
    /**
     * Compute the Pareto front from a set of evaluation results.
     * Only feasible results participate in the ranking.
     * Infeasible results are placed at the end of allRanks under a
     * synthetic "rank 9999" (not included in rank1).
     */
    analyze(results: EvaluationResult[]): ParetoFront;
    /**
     * Crowding distance for diversity-aware selection within a rank layer.
     * Returns a map of designPoint.id → distance.
     */
    crowdingDistance(front: EvaluationResult[]): Map<string, number>;
    /**
     * Returns 1 if a dominates b, -1 if b dominates a, 0 if neither.
     * "a dominates b" means a is ≤ b on all objectives and < b on at least one.
     * (All values already normalized to minimize.)
     */
    private _dominanceRelation;
    /**
     * 2-objective hypervolume relative to a reference point of [0, 0]
     * after normalizing each objective to [0, 1] range.
     * Uses sweep-line algorithm O(N log N).
     */
    private _hypervolume2D;
}
//# sourceMappingURL=ParetoAnalyzer.d.ts.map