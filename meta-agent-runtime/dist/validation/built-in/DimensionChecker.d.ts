/**
 * DimensionChecker — dimensional consistency V&V hook.
 *
 * Scans all PhysicalQuantity-shaped fields in tool input/output and
 * verifies internal consistency: the unit string must be known in the
 * UnitRegistry, and its registry dimension must match quantity.dimension.
 *
 * This catches the most common mistake: constructing a PhysicalQuantity
 * manually with a mismatched unit/dimension pair, e.g.:
 *   { value: 100, unit: 'MPa', dimension: { length: 1 } }  ← WRONG
 *
 * For schema-level checks (expected dimension per field), use
 * DimensionalConsistencyChecker.checkInput() directly in the tool.
 * That requires a DimensionSpec which only tools themselves can provide.
 */
import type { VVHook, VVResult, VVContext } from '../types.js';
export declare class DimensionChecker implements VVHook {
    readonly name = "DimensionChecker";
    readonly phase: import('../types.js').VVPhase[];
    readonly appliesTo: "*";
    run(ctx: VVContext): Promise<VVResult>;
    private _pass;
}
//# sourceMappingURL=DimensionChecker.d.ts.map