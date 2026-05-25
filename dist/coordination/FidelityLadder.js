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
import { ParetoAnalyzer } from './ParetoAnalyzer.js';
export const DEFAULT_FIDELITY_LADDER = {
    l1CandidateCount: 10,
    l2CandidateCount: 5,
    autoEscalate: false,
};
// ── FidelityLadder ────────────────────────────────────────────────────────────
export class FidelityLadder {
    cfg;
    constructor(cfg = {}) {
        this.cfg = { ...DEFAULT_FIDELITY_LADDER, ...cfg };
    }
    get autoEscalate() {
        return this.cfg.autoEscalate;
    }
    // ── Phase → fidelity mapping ──────────────────────────────────────────────
    /**
     * Which FidelityLevel is used for evaluations in a given campaign phase.
     *
     *   EVALUATING_L0 | SAMPLING → 0
     *   ESCALATING_L1            → 1
     *   ESCALATING_L2            → 2
     */
    getEvaluationFidelity(phase) {
        if (phase === 'ESCALATING_L1')
            return 1;
        if (phase === 'ESCALATING_L2')
            return 2;
        return 0;
    }
    /**
     * Given a PARETO_READY checkpoint phase, return the next ESCALATING phase
     * that should follow when escalating.  Returns null if there is no further
     * escalation (e.g. already at PARETO_READY_L2).
     */
    getEscalationPhase(currentPhase) {
        if (currentPhase === 'PARETO_READY_L0')
            return 'ESCALATING_L1';
        if (currentPhase === 'PARETO_READY_L1')
            return 'ESCALATING_L2';
        return null;
    }
    /**
     * How many candidates to select from the current front when escalating
     * to a given target fidelity.
     */
    getCandidateCount(targetFidelity) {
        if (targetFidelity === 1)
            return this.cfg.l1CandidateCount;
        if (targetFidelity === 2)
            return this.cfg.l2CandidateCount;
        return 0;
    }
    // ── Candidate selection ───────────────────────────────────────────────────
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
    selectEscalationCandidates(front, objectives, count) {
        if (count <= 0 || front.allRanks.length === 0)
            return [];
        const analyzer = new ParetoAnalyzer(objectives);
        const selected = [];
        for (const rank of front.allRanks) {
            if (selected.length >= count)
                break;
            const need = count - selected.length;
            if (rank.length <= need) {
                // Take the entire rank without sorting (small enough to use all)
                selected.push(...rank);
            }
            else {
                // Sort by crowding distance descending to pick most diverse subset
                const dist = analyzer.crowdingDistance(rank);
                const sorted = [...rank].sort((a, b) => {
                    const da = dist.get(a.designPoint.id) ?? 0;
                    const db = dist.get(b.designPoint.id) ?? 0;
                    return db - da; // descending
                });
                selected.push(...sorted.slice(0, need));
            }
        }
        return selected.map(r => r.designPoint);
    }
    /**
     * Convenience: given a front and the current checkpoint phase, return the
     * candidates to escalate (to the next fidelity level implied by phase).
     *
     * Returns [] if the phase is not a PARETO_READY checkpoint or if there
     * is no further escalation path.
     */
    planEscalation(phase, front, objectives) {
        const nextPhase = this.getEscalationPhase(phase);
        if (!nextPhase)
            return null;
        const targetFidelity = this.getEvaluationFidelity(nextPhase);
        const count = this.getCandidateCount(targetFidelity);
        const candidates = this.selectEscalationCandidates(front, objectives, count);
        return { candidates, targetFidelity, nextPhase };
    }
}
//# sourceMappingURL=FidelityLadder.js.map