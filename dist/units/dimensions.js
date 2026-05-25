/**
 * Pre-built dimension vectors for common engineering quantities.
 *
 * Every entry is a DimensionVector expressed in the 7 SI base dimensions.
 * Use these as the `dimension` field in PhysicalQuantity and DimensionSpec.
 *
 * Reference: BIPM SI Brochure 9th edition (2019)
 */
import { BASE_DIMENSIONS } from './types.js';
// ─────────────────────────────────────────────────────────────────────────────
// Dimensionless
// ─────────────────────────────────────────────────────────────────────────────
export const DIMENSIONLESS = {};
// ─────────────────────────────────────────────────────────────────────────────
// Base SI dimensions (single exponent = 1)
// ─────────────────────────────────────────────────────────────────────────────
export const DIMENSIONS = {
    // ── SI base ───────────────────────────────────────────────────────────────
    MASS: { mass: 1 }, // kg
    LENGTH: { length: 1 }, // m
    TIME: { time: 1 }, // s
    TEMPERATURE: { temperature: 1 }, // K
    CURRENT: { current: 1 }, // A
    AMOUNT: { amount: 1 }, // mol
    LUMINOSITY: { luminosity: 1 }, // cd
    // ── Mechanics ─────────────────────────────────────────────────────────────
    AREA: { length: 2 }, // m²
    VOLUME: { length: 3 }, // m³
    VELOCITY: { length: 1, time: -1 }, // m/s
    ACCELERATION: { length: 1, time: -2 }, // m/s²
    FORCE: { mass: 1, length: 1, time: -2 }, // N = kg·m/s²
    PRESSURE: { mass: 1, length: -1, time: -2 }, // Pa = kg/(m·s²)  [same as STRESS]
    STRESS: { mass: 1, length: -1, time: -2 }, // Pa
    ENERGY: { mass: 1, length: 2, time: -2 }, // J = kg·m²/s²
    POWER: { mass: 1, length: 2, time: -3 }, // W = kg·m²/s³
    TORQUE: { mass: 1, length: 2, time: -2 }, // N·m  (same dimension as energy)
    DENSITY: { mass: 1, length: -3 }, // kg/m³
    FREQUENCY: { time: -1 }, // Hz = 1/s
    ANGULAR_VELOCITY: { time: -1 }, // rad/s  (same as frequency)
    // ── Thermal ───────────────────────────────────────────────────────────────
    HEAT_FLUX: { mass: 1, time: -3 }, // W/m² = kg/s³
    THERMAL_CONDUCTIVITY: { mass: 1, length: 1, time: -3, temperature: -1 }, // W/(m·K)
    SPECIFIC_HEAT: { length: 2, time: -2, temperature: -1 }, // J/(kg·K)
    HEAT_TRANSFER_COEFF: { mass: 1, time: -3, temperature: -1 }, // W/(m²·K)
    // ── Electrical ────────────────────────────────────────────────────────────
    CHARGE: { current: 1, time: 1 }, // C = A·s
    VOLTAGE: { mass: 1, length: 2, time: -3, current: -1 }, // V
    RESISTANCE: { mass: 1, length: 2, time: -3, current: -2 }, // Ω
    CAPACITANCE: { mass: -1, length: -2, time: 4, current: 2 }, // F
    INDUCTANCE: { mass: 1, length: 2, time: -2, current: -2 }, // H
    CONDUCTANCE: { mass: -1, length: -2, time: 3, current: 2 }, // S
    // ── Electrochemistry / Battery ────────────────────────────────────────────
    /** Specific capacity: Ah/kg = A·s/kg */
    SPECIFIC_CAPACITY: { current: 1, time: 1, mass: -1 }, // A·s/kg → usually reported as mAh/g
    /** Specific energy: Wh/kg = J/kg */
    SPECIFIC_ENERGY: { length: 2, time: -2 }, // m²/s² = J/kg
    /** Current density: A/m² */
    CURRENT_DENSITY: { current: 1, length: -2 }, // A/m²
    /** C-rate: 1/h = 1/s × 3600 (dimension = frequency) */
    C_RATE: { time: -1 },
    // ── Material ──────────────────────────────────────────────────────────────
    STRAIN: DIMENSIONLESS, // m/m — dimensionless
    STRAIN_RATE: { time: -1 }, // 1/s
    DYNAMIC_VISCOSITY: { mass: 1, length: -1, time: -1 }, // Pa·s
    KINEMATIC_VISCOSITY: { length: 2, time: -1 }, // m²/s
};
// ─────────────────────────────────────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────────────────────────────────────
/** Superscript characters for formatting exponents */
const SUPERSCRIPTS = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
};
function toSuperscript(n) {
    return String(n).split('').map(c => SUPERSCRIPTS[c] ?? c).join('');
}
/** Short symbols for each base dimension */
const DIM_SYMBOL = {
    mass: 'M',
    length: 'L',
    time: 'T',
    temperature: 'Θ',
    current: 'I',
    amount: 'N',
    luminosity: 'J',
};
/**
 * Format a DimensionVector as a compact string.
 *
 *   { mass: 1, length: -1, time: -2 }  →  "M¹·L⁻¹·T⁻²"
 *   {}                                  →  "dimensionless"
 */
export function formatDimension(dv) {
    const parts = [];
    for (const dim of BASE_DIMENSIONS) {
        const exp = dv[dim];
        if (exp === undefined || exp === 0)
            continue;
        parts.push(`${DIM_SYMBOL[dim]}${toSuperscript(exp)}`);
    }
    return parts.length === 0 ? 'dimensionless' : parts.join('·');
}
/**
 * Check whether two DimensionVectors are equivalent.
 * Treats absent keys and exponent=0 as identical.
 */
export function dimensionsMatch(a, b) {
    for (const dim of BASE_DIMENSIONS) {
        const ea = a[dim] ?? 0;
        const eb = b[dim] ?? 0;
        if (ea !== eb)
            return false;
    }
    return true;
}
/**
 * Multiply two dimension vectors (used for derived unit composition).
 * e.g. FORCE × LENGTH = TORQUE
 */
export function multiplyDimensions(a, b) {
    const result = {};
    for (const dim of BASE_DIMENSIONS) {
        const exp = (a[dim] ?? 0) + (b[dim] ?? 0);
        if (exp !== 0)
            result[dim] = exp;
    }
    return result;
}
/**
 * Invert a dimension vector (for division).
 * e.g. invert(LENGTH) = { length: -1 }
 */
export function invertDimension(dv) {
    const result = {};
    for (const dim of BASE_DIMENSIONS) {
        const exp = dv[dim] ?? 0;
        if (exp !== 0)
            result[dim] = -exp;
    }
    return result;
}
/**
 * Look up a DIMENSIONS entry by its DimensionVector.
 * Returns the name of the first matching entry, or null.
 */
export function identifyDimension(dv) {
    for (const [name, ref] of Object.entries(DIMENSIONS)) {
        if (dimensionsMatch(dv, ref))
            return name;
    }
    return null;
}
//# sourceMappingURL=dimensions.js.map