/**
 * UnitRegistry — maps unit symbol strings to SI conversion functions.
 *
 * Every unit definition contains:
 *   dimension  — DimensionVector (for compatibility checks)
 *   toSI(v)    — converts a value in this unit to the SI base value
 *   fromSI(v)  — converts an SI base value back to this unit
 *
 * Linear units (most):   toSI = v * factor,  fromSI = v / factor
 * Affine units (°C, °F): require an offset in addition to the scale factor
 *
 * SI base values:
 *   mass        → kg
 *   length      → m
 *   time        → s
 *   temperature → K
 *   current     → A
 *   amount      → mol
 *   charge      → C (= A·s)
 *   energy      → J (= kg·m²·s⁻²)
 *   force       → N (= kg·m·s⁻²)
 *   pressure    → Pa (= kg·m⁻¹·s⁻²)
 *   voltage     → V (= kg·m²·s⁻³·A⁻¹)
 */
import type { DimensionVector, PhysicalQuantity } from './types.js';
export interface UnitDef {
    dimension: DimensionVector;
    /** Convert a value in this unit to the corresponding SI base value */
    toSI: (value: number) => number;
    /** Convert an SI base value to this unit */
    fromSI: (value: number) => number;
    /** Optional description */
    description?: string;
}
export declare class UnitRegistry {
    private units;
    constructor(additionalUnits?: Record<string, UnitDef>);
    /** Look up a unit definition. Returns null if unknown. */
    get(unit: string): UnitDef | null;
    /** All known unit symbols */
    knownUnits(): string[];
    /** Register a custom unit at runtime */
    register(symbol: string, def: UnitDef): void;
    /**
     * Convert a PhysicalQuantity to a different unit.
     *
     * Returns null if either unit is unknown or they have incompatible dimensions.
     */
    convert(qty: PhysicalQuantity, targetUnit: string): PhysicalQuantity | null;
    /**
     * Convert a raw numeric value from one unit to another.
     * Returns null if either unit is unknown or incompatible.
     */
    convertValue(value: number, fromUnit: string, toUnit: string): number | null;
    /**
     * Create a PhysicalQuantity from a raw value and unit string.
     * Returns null if the unit is unknown.
     */
    quantity(value: number, unit: string, uncertainty?: number): PhysicalQuantity | null;
    /**
     * Return the SI value of a quantity (for internal computation).
     */
    toSIValue(qty: PhysicalQuantity): number | null;
}
/** Shared default registry — use this unless you need custom units */
export declare const defaultRegistry: UnitRegistry;
//# sourceMappingURL=UnitRegistry.d.ts.map