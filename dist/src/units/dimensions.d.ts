/**
 * Pre-built dimension vectors for common engineering quantities.
 *
 * Every entry is a DimensionVector expressed in the 7 SI base dimensions.
 * Use these as the `dimension` field in PhysicalQuantity and DimensionSpec.
 *
 * Reference: BIPM SI Brochure 9th edition (2019)
 */
import type { DimensionVector, BaseDimension } from './types.js';
export declare const DIMENSIONLESS: DimensionVector;
export declare const DIMENSIONS: {
    readonly MASS: {
        readonly mass: 1;
    };
    readonly LENGTH: {
        readonly length: 1;
    };
    readonly TIME: {
        readonly time: 1;
    };
    readonly TEMPERATURE: {
        readonly temperature: 1;
    };
    readonly CURRENT: {
        readonly current: 1;
    };
    readonly AMOUNT: {
        readonly amount: 1;
    };
    readonly LUMINOSITY: {
        readonly luminosity: 1;
    };
    readonly AREA: {
        readonly length: 2;
    };
    readonly VOLUME: {
        readonly length: 3;
    };
    readonly VELOCITY: {
        readonly length: 1;
        readonly time: -1;
    };
    readonly ACCELERATION: {
        readonly length: 1;
        readonly time: -2;
    };
    readonly FORCE: {
        readonly mass: 1;
        readonly length: 1;
        readonly time: -2;
    };
    readonly PRESSURE: {
        readonly mass: 1;
        readonly length: -1;
        readonly time: -2;
    };
    readonly STRESS: {
        readonly mass: 1;
        readonly length: -1;
        readonly time: -2;
    };
    readonly ENERGY: {
        readonly mass: 1;
        readonly length: 2;
        readonly time: -2;
    };
    readonly POWER: {
        readonly mass: 1;
        readonly length: 2;
        readonly time: -3;
    };
    readonly TORQUE: {
        readonly mass: 1;
        readonly length: 2;
        readonly time: -2;
    };
    readonly DENSITY: {
        readonly mass: 1;
        readonly length: -3;
    };
    readonly FREQUENCY: {
        readonly time: -1;
    };
    readonly ANGULAR_VELOCITY: {
        readonly time: -1;
    };
    readonly HEAT_FLUX: {
        readonly mass: 1;
        readonly time: -3;
    };
    readonly THERMAL_CONDUCTIVITY: {
        readonly mass: 1;
        readonly length: 1;
        readonly time: -3;
        readonly temperature: -1;
    };
    readonly SPECIFIC_HEAT: {
        readonly length: 2;
        readonly time: -2;
        readonly temperature: -1;
    };
    readonly HEAT_TRANSFER_COEFF: {
        readonly mass: 1;
        readonly time: -3;
        readonly temperature: -1;
    };
    readonly CHARGE: {
        readonly current: 1;
        readonly time: 1;
    };
    readonly VOLTAGE: {
        readonly mass: 1;
        readonly length: 2;
        readonly time: -3;
        readonly current: -1;
    };
    readonly RESISTANCE: {
        readonly mass: 1;
        readonly length: 2;
        readonly time: -3;
        readonly current: -2;
    };
    readonly CAPACITANCE: {
        readonly mass: -1;
        readonly length: -2;
        readonly time: 4;
        readonly current: 2;
    };
    readonly INDUCTANCE: {
        readonly mass: 1;
        readonly length: 2;
        readonly time: -2;
        readonly current: -2;
    };
    readonly CONDUCTANCE: {
        readonly mass: -1;
        readonly length: -2;
        readonly time: 3;
        readonly current: 2;
    };
    /** Specific capacity: Ah/kg = A·s/kg */
    readonly SPECIFIC_CAPACITY: {
        readonly current: 1;
        readonly time: 1;
        readonly mass: -1;
    };
    /** Specific energy: Wh/kg = J/kg */
    readonly SPECIFIC_ENERGY: {
        readonly length: 2;
        readonly time: -2;
    };
    /** Current density: A/m² */
    readonly CURRENT_DENSITY: {
        readonly current: 1;
        readonly length: -2;
    };
    /** C-rate: 1/h = 1/s × 3600 (dimension = frequency) */
    readonly C_RATE: {
        readonly time: -1;
    };
    readonly STRAIN: Partial<Record<BaseDimension, number>>;
    readonly STRAIN_RATE: {
        readonly time: -1;
    };
    readonly DYNAMIC_VISCOSITY: {
        readonly mass: 1;
        readonly length: -1;
        readonly time: -1;
    };
    readonly KINEMATIC_VISCOSITY: {
        readonly length: 2;
        readonly time: -1;
    };
};
/**
 * Format a DimensionVector as a compact string.
 *
 *   { mass: 1, length: -1, time: -2 }  →  "M¹·L⁻¹·T⁻²"
 *   {}                                  →  "dimensionless"
 */
export declare function formatDimension(dv: DimensionVector): string;
/**
 * Check whether two DimensionVectors are equivalent.
 * Treats absent keys and exponent=0 as identical.
 */
export declare function dimensionsMatch(a: DimensionVector, b: DimensionVector): boolean;
/**
 * Multiply two dimension vectors (used for derived unit composition).
 * e.g. FORCE × LENGTH = TORQUE
 */
export declare function multiplyDimensions(a: DimensionVector, b: DimensionVector): DimensionVector;
/**
 * Invert a dimension vector (for division).
 * e.g. invert(LENGTH) = { length: -1 }
 */
export declare function invertDimension(dv: DimensionVector): DimensionVector;
/**
 * Look up a DIMENSIONS entry by its DimensionVector.
 * Returns the name of the first matching entry, or null.
 */
export declare function identifyDimension(dv: DimensionVector): string | null;
//# sourceMappingURL=dimensions.d.ts.map