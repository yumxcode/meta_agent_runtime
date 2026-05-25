/**
 * DimensionalConsistencyChecker — validates that tool I/O carries the
 * correct physical dimensions, and converts between compatible units.
 *
 * Two levels of checking:
 *
 *   1. Schema-level (checkInput / checkOutput):
 *      Given a DimensionSpec (what the tool expects), scan a record for
 *      PhysicalQuantity values and verify each one matches the declared
 *      dimension.  Returns DimensionError[] — empty means all good.
 *
 *   2. Record-level (scanForQuantities):
 *      Extract all PhysicalQuantity-shaped objects from an arbitrary record,
 *      verify their unit is known and internally consistent
 *      (unit dimension == quantity.dimension).
 *
 * Unit conversion:
 *   `convert(qty, targetUnit)` delegates to UnitRegistry.
 *   The checker itself adds a dimension-mismatch error when conversion is
 *   attempted across incompatible dimensions.
 */
import type { PhysicalQuantity, DimensionError, DimensionSpec } from './types.js';
import { UnitRegistry } from './UnitRegistry.js';
export declare class DimensionalConsistencyChecker {
    private readonly registry;
    constructor(registry?: UnitRegistry);
    /**
     * Verify that each PhysicalQuantity field in `record` matches the
     * expected dimension declared in `spec`.
     *
     * Only checks fields where:
     *   - spec[field].dimension is declared, AND
     *   - record[field] is a PhysicalQuantity
     *
     * Scalar fields (number/string/boolean) are ignored — they are not
     * subject to dimensional analysis.
     */
    checkInput(spec: DimensionSpec, record: Record<string, unknown>): DimensionError[];
    checkOutput(spec: DimensionSpec, record: Record<string, unknown>): DimensionError[];
    private _checkRecord;
    /**
     * Scan an arbitrary record for PhysicalQuantity objects and verify
     * internal consistency: the unit must be known in the registry, and
     * the registry's dimension for that unit must match quantity.dimension.
     *
     * Returns an array of { field, error } pairs for any inconsistencies.
     */
    scanForQuantities(record: Record<string, unknown>): Array<{
        field: string;
        qty: PhysicalQuantity;
        unitKnown: boolean;
        consistent: boolean;
        hint?: string;
    }>;
    /**
     * Convert a PhysicalQuantity to the given target unit.
     *
     * Returns a new PhysicalQuantity, or throws if:
     *   - Either unit is unknown
     *   - The dimensions are incompatible
     */
    convert(qty: PhysicalQuantity, targetUnit: string): PhysicalQuantity;
    /**
     * Try to convert; returns null instead of throwing on failure.
     */
    tryConvert(qty: PhysicalQuantity, targetUnit: string): PhysicalQuantity | null;
    /**
     * Normalize a PhysicalQuantity to its SI base unit.
     * e.g. { value: 100, unit: 'MPa' } → { value: 1e8, unit: 'Pa' }
     */
    toSI(qty: PhysicalQuantity): PhysicalQuantity | null;
    /**
     * Build a PhysicalQuantity from a value and unit string.
     * The dimension is looked up from the registry automatically.
     */
    quantity(value: number, unit: string, uncertainty?: number): PhysicalQuantity;
    /** Find the canonical SI unit symbol for a given DimensionVector */
    private _siUnitFor;
}
/** Shared default checker — covers the standard engineering unit set */
export declare const defaultChecker: DimensionalConsistencyChecker;
//# sourceMappingURL=DimensionalConsistencyChecker.d.ts.map