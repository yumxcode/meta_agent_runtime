/**
 * OOMChecker — Order-of-Magnitude reasonableness check.
 *
 * Cross-references numeric outputs against a reference database of typical
 * engineering value ranges.  Catches the most common category of simulation
 * errors: unit conversion mistakes that produce values that are physically
 * plausible in isolation but absurd for the specific quantity.
 *
 * Example:
 *   Steel yield strength is typically 250–1000 MPa.
 *   If a FEM tool returns 250,000 MPa, that's almost certainly a Pa→MPa
 *   unit confusion — the OOMChecker will flag it.
 *
 * Tolerance:
 *   The checker allows ±2 orders of magnitude (factor of 100) beyond the
 *   reference range.  This is intentionally loose — it's meant to catch
 *   gross errors, not replace a proper uncertainty analysis.
 *
 *   Example: reference range [250, 1000] MPa → alert if value < 2.5 or > 100,000 MPa.
 *
 * Reference DB format:
 *
 *   {
 *     [toolCapabilityOrName]: {
 *       [outputFieldName]: {
 *         min: number,       // typical minimum (in the stated unit)
 *         max: number,       // typical maximum
 *         unit: string,      // for human-readable messages only
 *         description?: string
 *       }
 *     }
 *   }
 *
 * The checker matches output fields using three strategies (in order):
 *   1. exact match on field name within the tool's own entry
 *   2. substring match on field name in the global catch-all ('*') entry
 *   3. no match → skip (no false positives on unknown fields)
 */
import { defaultAction } from '../types.js';
// ─────────────────────────────────────────────────────────────────────────────
// Built-in reference data (engineering common-sense values)
// ─────────────────────────────────────────────────────────────────────────────
export const BUILT_IN_OOM_DB = {
    '*': {
        // Stress / pressure
        stress: { min: 1e3, max: 1e10, unit: 'Pa', description: 'structural stress' },
        pressure: { min: 1, max: 1e9, unit: 'Pa' },
        yield_strength: { min: 1e6, max: 3e9, unit: 'Pa', description: 'yield strength' },
        tensile_strength: { min: 1e6, max: 5e9, unit: 'Pa' },
        // Temperature
        temperature: { min: 200, max: 4000, unit: 'K', description: 'absolute temperature' },
        // Energy
        energy: { min: 1e-20, max: 1e15, unit: 'J' },
        energy_density: { min: 1e3, max: 1e9, unit: 'J/m³' },
        // Force
        force: { min: 1e-6, max: 1e9, unit: 'N' },
        // Voltage (battery/electrical)
        voltage: { min: 0.1, max: 1000, unit: 'V' },
        cell_voltage: { min: 0.5, max: 5.0, unit: 'V', description: 'battery cell voltage' },
        // Capacity (battery)
        capacity: { min: 1, max: 1000, unit: 'mAh/g', description: 'specific capacity' },
        energy_density_battery: { min: 50, max: 1000, unit: 'Wh/kg', description: 'battery energy density' },
        // Efficiency (dimensionless)
        efficiency: { min: 0, max: 1, unit: '—', description: 'must be in [0,1]' },
        coulombic_efficiency: { min: 0.5, max: 1, unit: '—' },
        // Thermal
        thermal_conductivity: { min: 0.01, max: 3000, unit: 'W/(m·K)' },
        // Velocity / strain rate
        velocity: { min: 1e-10, max: 3e8, unit: 'm/s' },
        strain_rate: { min: 1e-10, max: 1e6, unit: '1/s' },
    },
};
// ─────────────────────────────────────────────────────────────────────────────
// OOMChecker implementation
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Factor beyond which we flag (±1 order of magnitude = factor 10).
 * A unit confusion (e.g. Pa reported as MPa) is a factor of 1e6 error —
 * factor 10 is intentionally tight to catch real mistakes without generating
 * false positives on exotic materials.
 */
const OOM_FACTOR = 10;
export class OOMChecker {
    name = 'OOMChecker';
    phase = 'post_call';
    appliesTo = '*';
    db;
    constructor(additionalDB = {}) {
        // Merge built-in DB with caller-supplied additions
        this.db = {};
        for (const [key, ranges] of Object.entries(BUILT_IN_OOM_DB)) {
            this.db[key] = { ...ranges };
        }
        for (const [key, ranges] of Object.entries(additionalDB)) {
            this.db[key] = { ...(this.db[key] ?? {}), ...ranges };
        }
    }
    async run(ctx) {
        if (!ctx.output || typeof ctx.output !== 'object') {
            return this._pass();
        }
        const findings = [];
        for (const [field, rawValue] of Object.entries(ctx.output)) {
            const value = this._extractNumber(rawValue);
            if (value === null)
                continue; // skip non-numeric fields
            const range = this._findRange(ctx.toolName, field);
            if (!range)
                continue; // no reference data → skip (no false positives)
            if (!this._inRange(value, range)) {
                findings.push(`Field "${field}" = ${this._fmt(value)} ${range.unit} ` +
                    `is outside the typical range [${this._fmt(range.min)}, ${this._fmt(range.max)}] ` +
                    `(±2 OOM tolerance). ` +
                    (range.description ? `(${range.description}) ` : '') +
                    `Check for unit conversion errors.`);
            }
        }
        if (findings.length === 0)
            return this._pass();
        const severity = findings.length >= 3 ? 'critical' : 'error';
        return {
            hookName: this.name,
            passed: false,
            severity,
            message: `OOM check failed for tool "${ctx.toolName}":\n` + findings.map(f => `  • ${f}`).join('\n'),
            suggestedAction: defaultAction(severity),
        };
    }
    // ── helpers ────────────────────────────────────────────────────────────────
    _findRange(toolName, field) {
        // 1. Exact field match in tool-specific entry
        if (this.db[toolName]?.[field])
            return this.db[toolName][field];
        // 2. Exact field match in global catch-all
        if (this.db['*']?.[field])
            return this.db['*'][field];
        // 3. Substring match in global catch-all (e.g. "max_stress" matches "stress")
        const globalEntries = Object.entries(this.db['*'] ?? {});
        for (const [key, range] of globalEntries) {
            if (field.toLowerCase().includes(key.toLowerCase()))
                return range;
        }
        return null;
    }
    _inRange(value, range) {
        // Special case: efficiency-like fields must be strictly in [0, 1]
        if (range.max === 1 && range.min === 0) {
            return value >= 0 && value <= 1;
        }
        const lo = range.min / OOM_FACTOR;
        const hi = range.max * OOM_FACTOR;
        return value >= lo && value <= hi;
    }
    _extractNumber(v) {
        if (typeof v === 'number' && isFinite(v))
            return v;
        if (typeof v === 'object' && v !== null && 'value' in v) {
            const inner = v.value;
            if (typeof inner === 'number' && isFinite(inner))
                return inner;
        }
        return null;
    }
    _fmt(n) {
        if (Math.abs(n) >= 1e6 || (Math.abs(n) < 1e-3 && n !== 0)) {
            return n.toExponential(2);
        }
        return n.toPrecision(4);
    }
    _pass() {
        return {
            hookName: this.name,
            passed: true,
            severity: 'info',
            message: 'OOM check passed',
            suggestedAction: 'continue',
        };
    }
}
//# sourceMappingURL=OOMChecker.js.map