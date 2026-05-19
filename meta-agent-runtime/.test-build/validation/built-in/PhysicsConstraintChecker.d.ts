/**
 * PhysicsConstraintChecker — enforces inviolable physical laws.
 *
 * These are hard constraints that cannot be overridden by domain packages:
 *
 *   - Efficiency / COP in [0, 1] (thermodynamic limit)
 *   - Absolute temperature ≥ 0 K (third law)
 *   - Absolute pressure ≥ 0 Pa
 *   - Probability in [0, 1]
 *   - Mass, density, concentration > 0
 *   - Speed ≤ speed of light (3×10⁸ m/s)
 *
 * Each constraint is defined as a named rule applied to matching field names
 * via a pattern list. Patterns are case-insensitive substring matches.
 *
 * Severity:
 *   Physics violations are always 'critical' — they indicate a fundamental
 *   error in the simulation setup or output parsing, never a calibration issue.
 */
import type { VVHook, VVResult, VVContext } from '../types.js';
interface PhysicsConstraint {
    name: string;
    /** Substring patterns that match field names this constraint applies to */
    fieldPatterns: string[];
    /** Returns null if OK, or an error message if violated */
    check(value: number): string | null;
}
export declare class PhysicsConstraintChecker implements VVHook {
    readonly name = "PhysicsConstraintChecker";
    readonly phase: import('../types.js').VVPhase[];
    readonly appliesTo: "*";
    private readonly constraints;
    constructor(additionalConstraints?: PhysicsConstraint[]);
    run(ctx: VVContext): Promise<VVResult>;
    private _matches;
    private _extractNumber;
    private _pass;
}
export {};
//# sourceMappingURL=PhysicsConstraintChecker.d.ts.map