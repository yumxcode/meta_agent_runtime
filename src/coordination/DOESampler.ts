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

import { createHash } from 'crypto'
import type { DesignPoint, DesignSpace, DesignVariable } from './types.js'

// ── Seeded PRNG (LCG) ─────────────────────────────────────────────────────────
// Deterministic random number generator so sampling is reproducible.
// Parameters from Numerical Recipes.

class SeededRandom {
  private state: number

  constructor(seed = 42) {
    this.state = seed >>> 0
  }

  /** Returns a float in [0, 1). */
  next(): number {
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0
    return this.state / 0x100000000
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a DesignPoint with a deterministic ID.
 * ID = first 16 hex chars of SHA-256(sorted JSON of variable entries).
 */
export function makeDesignPoint(
  variables: Record<string, number | string>,
): DesignPoint {
  const sorted = Object.entries(variables).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  const id = createHash('sha256')
    .update(JSON.stringify(sorted))
    .digest('hex')
    .slice(0, 16)
  return { id, variables }
}

/**
 * Map a normalised value t ∈ [0, 1) to a concrete variable value.
 */
function sampleVar(v: DesignVariable, t: number): number | string {
  if (v.type === 'continuous') {
    const [lo, hi] = v.bounds!
    return lo + t * (hi - lo)
  }
  if (v.type === 'integer') {
    const [lo, hi] = v.bounds!
    return Math.round(lo + t * (hi - lo))
  }
  // discrete | categorical — index into values list
  const vals = v.values ?? []
  return vals[Math.min(Math.floor(t * vals.length), vals.length - 1)] ?? 0
}

// ── DOESampler ────────────────────────────────────────────────────────────────

export class DOESampler {
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
  static lhs(space: DesignSpace, n: number, seed = 42): DesignPoint[] {
    if (n <= 0) return []
    const rng = new SeededRandom(seed)
    const vars = space.variables

    // Step 1+2: for each variable build N stratum samples
    const strata: number[][] = vars.map(() =>
      Array.from({ length: n }, (_, i) => (i + rng.next()) / n),
    )

    // Step 3: Fisher-Yates shuffle per variable (independently)
    for (const s of strata) {
      for (let i = s.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1))
        ;[s[i], s[j]] = [s[j]!, s[i]!]
      }
    }

    return Array.from({ length: n }, (_, i) => {
      const record: Record<string, number | string> = {}
      vars.forEach((v, vi) => {
        record[v.name] = sampleVar(v, strata[vi]![i]!)
      })
      return makeDesignPoint(record)
    })
  }

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
  static grid(space: DesignSpace, levelsPerVar: number): DesignPoint[] {
    if (levelsPerVar <= 0) return []
    const vars = space.variables

    // Build level list per variable
    const levels: (number | string)[][] = vars.map(v => {
      if (v.type === 'discrete' || v.type === 'categorical') {
        const vals = v.values ?? []
        if (vals.length <= levelsPerVar) return vals as (number | string)[]
        // levelsPerVar === 1: pick the middle value (mirrors continuous/integer behaviour)
        if (levelsPerVar === 1) return [vals[Math.floor(vals.length / 2)]!]
        // Sub-sample evenly from values list
        const step = (vals.length - 1) / (levelsPerVar - 1)
        return Array.from({ length: levelsPerVar }, (_, i) =>
          vals[Math.round(i * step)]!,
        )
      }
      const [lo, hi] = v.bounds ?? [0, 1]
      if (levelsPerVar === 1) return [v.type === 'integer' ? Math.round((lo + hi) / 2) : (lo + hi) / 2]
      return Array.from({ length: levelsPerVar }, (_, i) => {
        const t = i / (levelsPerVar - 1)
        const raw = lo + t * (hi - lo)
        return v.type === 'integer' ? Math.round(raw) : raw
      })
    })

    // Cartesian product via index-based counter
    const points: DesignPoint[] = []
    const indices = new Array<number>(vars.length).fill(0)
    const totals = vars.map((v, vi) => levels[vi]!.length)

    for (;;) {
      const record: Record<string, number | string> = {}
      vars.forEach((v, vi) => {
        record[v.name] = levels[vi]![indices[vi]!]!
      })
      points.push(makeDesignPoint(record))

      // Increment indices right-to-left (mixed radix counter)
      let carry = true
      for (let vi = vars.length - 1; vi >= 0 && carry; vi--) {
        indices[vi]!++
        if (indices[vi]! >= totals[vi]!) {
          indices[vi] = 0
        } else {
          carry = false
        }
      }
      if (carry) break // all combinations exhausted
    }

    return points
  }

  /**
   * Pure random sampling.
   *
   * Useful as a Monte Carlo baseline or when independent uniform draws
   * are required (e.g., for comparison against LHS).
   */
  static random(space: DesignSpace, n: number, seed = 42): DesignPoint[] {
    if (n <= 0) return []
    const rng = new SeededRandom(seed)
    const vars = space.variables

    return Array.from({ length: n }, () => {
      const record: Record<string, number | string> = {}
      vars.forEach(v => {
        record[v.name] = sampleVar(v, rng.next())
      })
      return makeDesignPoint(record)
    })
  }

  /**
   * Adaptive refinement: generate additional points near a set of
   * "interesting" points (e.g., near a Pareto front).
   *
   * Each seed point gets `pointsPerSeed` neighbours sampled from a
   * local box of size `radius` around it (clamped to variable bounds).
   */
  static refine(
    space: DesignSpace,
    seedPoints: DesignPoint[],
    pointsPerSeed: number,
    radius = 0.1,
    seed = 99,
  ): DesignPoint[] {
    if (seedPoints.length === 0 || pointsPerSeed <= 0) return []
    const rng = new SeededRandom(seed)
    const vars = space.variables
    const results: DesignPoint[] = []

    for (const sp of seedPoints) {
      for (let k = 0; k < pointsPerSeed; k++) {
        const record: Record<string, number | string> = {}
        for (const v of vars) {
          const centre = sp.variables[v.name]
          if (typeof centre !== 'number') {
            // categorical / non-numeric: pick randomly from values
            const vals = v.values ?? []
            record[v.name] = vals[Math.floor(rng.next() * vals.length)] ?? centre
            continue
          }
          const [lo, hi] = v.bounds ?? [centre - 1, centre + 1]
          const span = (hi - lo) * radius
          const raw = centre + (rng.next() * 2 - 1) * span
          const clamped = Math.max(lo, Math.min(hi, raw))
          record[v.name] = v.type === 'integer' ? Math.round(clamped) : clamped
        }
        results.push(makeDesignPoint(record))
      }
    }

    return results
  }
}
