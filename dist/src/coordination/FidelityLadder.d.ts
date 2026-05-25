/**
 * FidelityLadder — manages the multi-fidelity escalation strategy.
 *
 * Terminology:
 *   L0  Estimate   — analytical formula, < 1 s. Used for broad exploration.
 *   L1  Simplified — simplified model (1D / beam / equivalent circuit), < 1 min.
 *   L2  Moderate   — mid-fidelity (coarse FEM / simplified CFD), < 30 min.
 *   L3+ High       — full-fidelity (registered via EngineeringToolRegistry, hours+).
 *
 * The ladder drives CampaignMonitor's auto-escalation: after L0 completes,
 * the top-K most diverse Pareto-front points are promoted to L1 evaluation,
 * then top-J of those to L2.  Human checkpoints sit at each PARETO_READY phase.
 *
 * When autoEscalate = true, Monitor skips user checkpoints and promotes
 * automatically. When false (default), campaign pauses for user review.
 */
import type { CampaignPhase, DesignPoint, FidelityLevel, Objective, ParetoFront } from './types.js';
export interface FidelityLadderConfig {
    /**
     * Number of L0 Pareto-front points to promote to L1. (default: 10)
     * If the front has fewer points, all are promoted.
     */
    l1CandidateCount: number;
    /**
     * Number of L1 Pareto-front points to promote to L2. (default: 5)
     */
    l2CandidateCount: number;
    /**
     * When true, Monitor advances through PARETO_READY checkpoints automatically
     * without waiting for user input.  Default: false.
     */
    autoEscalate: boolean;
}
export declare const DEFAULT_FIDELITY_LADDER: FidelityLadderConfig;
export declare class FidelityLadder {
    private cfg;
    constructor(cfg?: Partial<FidelityLadderConfig>);
    get autoEscalate(): boolean;
    /**
     * Which FidelityLevel is used for evaluations in a given campaign phase.
     *
     *   EVALUATING_L0 | SAMPLING → 0
     *   ESCALATING_L1            → 1
     *   ESCALATING_L2            → 2
     */
    getEvaluationFidelity(phase: CampaignPhase): FidelityLevel;
    /**
     * Given a PARETO_READY checkpoint phase, return the next ESCALATING phase
     * that should follow when escalating.  Returns null if there is no further
     * escalation (e.g. already at PARETO_READY_L2).
     */
    getEscalationPhase(currentPhase: CampaignPhase): CampaignPhase | null;
    /**
     * How many candidates to select from the current front when escalating
     * to a given target fidelity.
     */
    getCandidateCount(targetFidelity: FidelityLevel): number;
    /**
     * Select the most promising design points from a Pareto front to escalate
     * to the next fidelity level.
     *
     * Selection strategy (maximises diversity of promoted candidates):
     *   1. Start with rank-1 (true Pareto front) sorted by crowding distance
     *      descending — the most isolated / representative points first.
     *   2. If rank-1 has fewer than `count`, extend into rank-2, rank-3, …
     *      using the same crowding-distance ordering within each rank layer.
     *   3. Cap at `count` total.
     *
     * Returns only the DesignPoint structs (the caller needs to evaluate them
     * at the next fidelity level).
     */
    selectEscalationCandidates(front: ParetoFront, objectives: Objective[], count: number): DesignPoint[];
    /**
     * Convenience: given a front and the current checkpoint phase, return the
     * candidates to escalate (to the next fidelity level implied by phase).
     *
     * Returns [] if the phase is not a PARETO_READY checkpoint or if there
     * is no further escalation path.
     */
    planEscalation(phase: CampaignPhase, front: ParetoFront, objectives: Objective[]): {
        candidates: DesignPoint[];
        targetFidelity: FidelityLevel;
        nextPhase: CampaignPhase;
    } | null;
}
//# sourceMappingURL=FidelityLadder.d.ts.map