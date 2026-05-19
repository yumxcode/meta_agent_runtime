/**
 * ParetoAnalyzer — non-dominated sorting for multi-objective optimization.
 *
 * Algorithm: fast non-dominated sort (NSGA-II style), O(M × N²).
 * M = number of objectives, N = number of evaluation results.
 *
 * All computation is deterministic and LLM-free. Safe to run inside
 * CampaignMonitor's background polling loop.
 */
export class ParetoAnalyzer {
    objectives;
    constructor(objectives) {
        this.objectives = objectives;
    }
    /**
     * Compute the Pareto front from a set of evaluation results.
     * Only feasible results participate in the ranking.
     * Infeasible results are placed at the end of allRanks under a
     * synthetic "rank 9999" (not included in rank1).
     */
    analyze(results) {
        if (results.length === 0) {
            return { rank1: [], allRanks: [], hypervolume: null };
        }
        // Only feasible results participate in dominance ranking.
        // Infeasible results are excluded entirely (they cannot be Pareto-optimal).
        const feasible = results.filter(r => r.feasible);
        if (feasible.length === 0) {
            return { rank1: [], allRanks: [], hypervolume: null };
        }
        // Normalize all objectives to "minimize"
        const normalized = feasible.map(r => ({
            result: r,
            values: this.objectives.map(obj => {
                const v = r.objectives[obj.name] ?? Infinity;
                return obj.direction === 'maximize' ? -v : v;
            }),
        }));
        // Non-dominated sort
        const n = normalized.length;
        const dominated = new Array(n).fill(0); // domination count
        const dominates = Array.from({ length: n }, () => []);
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const rel = this._dominanceRelation(normalized[i].values, normalized[j].values);
                if (rel === 1) {
                    dominates[i].push(j);
                    dominated[j]++;
                }
                else if (rel === -1) {
                    dominates[j].push(i);
                    dominated[i]++;
                }
            }
        }
        // Build rank layers
        const allRanks = [];
        let currentFront = [];
        for (let i = 0; i < n; i++) {
            if (dominated[i] === 0)
                currentFront.push(i);
        }
        while (currentFront.length > 0) {
            allRanks.push(currentFront.map(i => normalized[i].result));
            const nextFront = [];
            for (const i of currentFront) {
                for (const j of dominates[i]) {
                    dominated[j]--;
                    if (dominated[j] === 0)
                        nextFront.push(j);
                }
            }
            currentFront = nextFront;
        }
        const rank1 = allRanks[0] ?? [];
        // Hypervolume (2-objective approximation)
        const hv = this.objectives.length === 2 && rank1.length > 0
            ? this._hypervolume2D(rank1)
            : null;
        return { rank1, allRanks, hypervolume: hv };
    }
    /**
     * Crowding distance for diversity-aware selection within a rank layer.
     * Returns a map of designPoint.id → distance.
     */
    crowdingDistance(front) {
        const dist = new Map();
        front.forEach(r => dist.set(r.designPoint.id, 0));
        if (front.length <= 2) {
            front.forEach(r => dist.set(r.designPoint.id, Infinity));
            return dist;
        }
        for (const obj of this.objectives) {
            const sorted = [...front].sort((a, b) => {
                const av = a.objectives[obj.name] ?? 0;
                const bv = b.objectives[obj.name] ?? 0;
                return av - bv;
            });
            const min = sorted[0].objectives[obj.name] ?? 0;
            const max = sorted[sorted.length - 1].objectives[obj.name] ?? 0;
            const range = max - min || 1;
            // Boundary points get infinite distance
            dist.set(sorted[0].designPoint.id, Infinity);
            dist.set(sorted[sorted.length - 1].designPoint.id, Infinity);
            for (let i = 1; i < sorted.length - 1; i++) {
                const prev = sorted[i - 1].objectives[obj.name] ?? 0;
                const next = sorted[i + 1].objectives[obj.name] ?? 0;
                const id = sorted[i].designPoint.id;
                dist.set(id, (dist.get(id) ?? 0) + (next - prev) / range);
            }
        }
        return dist;
    }
    // ── Internal ─────────────────────────────────────────────────────────────────
    /**
     * Returns 1 if a dominates b, -1 if b dominates a, 0 if neither.
     * "a dominates b" means a is ≤ b on all objectives and < b on at least one.
     * (All values already normalized to minimize.)
     */
    _dominanceRelation(a, b) {
        let aWins = false;
        let bWins = false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] < b[i])
                aWins = true;
            else if (a[i] > b[i])
                bWins = true;
        }
        if (aWins && !bWins)
            return 1;
        if (bWins && !aWins)
            return -1;
        return 0;
    }
    /**
     * 2-objective hypervolume relative to a reference point of [0, 0]
     * after normalizing each objective to [0, 1] range.
     * Uses sweep-line algorithm O(N log N).
     */
    _hypervolume2D(front) {
        if (front.length === 0)
            return 0;
        const [o1, o2] = this.objectives;
        const pts = front.map(r => ({
            x: r.objectives[o1.name] ?? 0,
            y: r.objectives[o2.name] ?? 0,
        }));
        // Normalize each axis to [0, 1]
        const xs = pts.map(p => p.x);
        const ys = pts.map(p => p.y);
        const xMin = Math.min(...xs), xMax = Math.max(...xs);
        const yMin = Math.min(...ys), yMax = Math.max(...ys);
        const xR = xMax - xMin || 1;
        const yR = yMax - yMin || 1;
        // Normalize (flip if maximizing so reference is 0)
        const norm = pts.map(p => ({
            x: o1.direction === 'minimize' ? (p.x - xMin) / xR : (xMax - p.x) / xR,
            y: o2.direction === 'minimize' ? (p.y - yMin) / yR : (yMax - p.y) / yR,
        }));
        // Sort by x ascending
        norm.sort((a, b) => a.x - b.x);
        // Sweep: compute area between front and reference point [1, 1]
        let hv = 0;
        let prevX = 1; // reference x
        for (let i = norm.length - 1; i >= 0; i--) {
            const { x, y } = norm[i];
            hv += (prevX - x) * (1 - y);
            prevX = x;
        }
        return Math.max(0, hv);
    }
}
//# sourceMappingURL=ParetoAnalyzer.js.map