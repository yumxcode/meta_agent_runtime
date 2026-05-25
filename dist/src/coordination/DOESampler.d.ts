/**
 * DOESampler — deterministic design-of-experiments sampling strategies.
 *
 * All methods are stateless and produce deterministic DesignPoint arrays
 * (given the same inputs + seed). DesignPoint IDs are SHA-256 hashes of
 * the sorted variable name-value pairs, making them stable across re-runs.
 *
 * Strategies:
 *   lhs    — Latin Hypercube Sampling (recommended default).
 *            Guarantees one sample per stratum per variable — better
 *            space coverage than pure random with the same N.
 *   grid   — Full-factorial grid. Covers every combination of
 *            `levelsPerVar` levels across all variables. Grows as
 *            levelsPerVar^nVars — only practical for ≤ 3–4 variables.
 *   random — Pure random uniform. Useful as a baseline or when
 *            deterministic structure is undesirable.
 */
import type { DesignPoint, DesignSpace } from './types.js';
/**
 * Create a DesignPoint with a deterministic ID.
 * ID = first 16 hex chars of SHA-256(sorted JSON of variable entries).
 */
export declare function makeDesignPoint(variables: Record<string, number | string>): DesignPoint;
export declare class DOESampler {
    /**
     * Latin Hypercube Sampling (LHS).
     *
     * Algorithm:
     *   1. Divide [0, 1) into N equal strata of width 1/N.
     *   2. For each variable, draw one uniform sample from each stratum.
     *   3. Randomly permute each variable's stratum assignments independently,
     *      so no two points share the same stratum on every axis simultaneously.
     *
     * Result: N points, each using one stratum per variable, with good
     * space-filling properties in all marginal projections.
     */
    static lhs(space: DesignSpace, n: number, seed?: number): DesignPoint[];
    /**
     * Full-factorial grid search.
     *
     * Produces `levelsPerVar^nVars` points covering all combinations.
     * For each variable:
     *   - continuous / integer: evenly spaced from lo to hi
     *   - discrete / categorical: sub-sampled from values list
     *
     * Warning: combinatorial explosion — only suitable for ≤ 3–4 variables
     * or very small levelsPerVar values.
     */
    static grid(space: DesignSpace, levelsPerVar: number): DesignPoint[];
    /**
     * Pure random sampling.
     *
     * Useful as a Monte Carlo baseline or when independent uniform draws
     * are required (e.g., for comparison against LHS).
     */
    static random(space: DesignSpace, n: number, seed?: number): DesignPoint[];
    /**
     * Adaptive refinement: generate additional points near a set of
     * "interesting" points (e.g., near a Pareto front).
     *
     * Each seed point gets `pointsPerSeed` neighbours sampled from a
     * local box of size `radius` around it (clamped to variable bounds).
     */
    static refine(space: DesignSpace, seedPoints: DesignPoint[], pointsPerSeed: number, radius?: number, seed?: number): DesignPoint[];
}
//# sourceMappingURL=DOESampler.d.ts.map