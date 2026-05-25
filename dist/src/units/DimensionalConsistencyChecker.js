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
import { dimensionsMatch, formatDimension } from './dimensions.js';
import { defaultRegistry } from './UnitRegistry.js';
// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
/** True if an unknown value looks like a PhysicalQuantity */
function isPhysicalQuantity(v) {
    if (typeof v !== 'object' || v === null)
        return false;
    const obj = v;
    return (typeof obj.value === 'number' &&
        typeof obj.unit === 'string' &&
        typeof obj.dimension === 'object' &&
        obj.dimension !== null);
}
// ─────────────────────────────────────────────────────────────────────────────
export class DimensionalConsistencyChecker {
    registry;
    constructor(registry = defaultRegistry) {
        this.registry = registry;
    }
    // ── Schema-level checks ─────────────────────────────────────────────────
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
    checkInput(spec, record) {
        return this._checkRecord('input', spec, record);
    }
    checkOutput(spec, record) {
        return this._checkRecord('output', spec, record);
    }
    _checkRecord(_side, spec, record) {
        const errors = [];
        for (const [field, fieldSpec] of Object.entries(spec)) {
            if (!fieldSpec.dimension)
                continue; // no dimension declared → skip
            const value = record[field];
            if (value === undefined || value === null) {
                // Missing field — only an error if required; dimension check doesn't apply
                continue;
            }
            if (!isPhysicalQuantity(value)) {
                // Field is present but not a PhysicalQuantity — emit a soft error
                errors.push({
                    param: field,
                    expected: fieldSpec.dimension,
                    received: {},
                    hint: `Field "${field}" is expected to be a PhysicalQuantity ` +
                        `(with dimension ${formatDimension(fieldSpec.dimension)}), ` +
                        `but received ${typeof value}. Wrap the value in {value, unit, dimension}.`,
                });
                continue;
            }
            if (!dimensionsMatch(value.dimension, fieldSpec.dimension)) {
                errors.push({
                    param: field,
                    expected: fieldSpec.dimension,
                    received: value.dimension,
                    hint: `Field "${field}": expected dimension ${formatDimension(fieldSpec.dimension)} ` +
                        `but received ${formatDimension(value.dimension)} (unit "${value.unit}"). ` +
                        `Check that the correct unit is being used.`,
                });
            }
        }
        return errors;
    }
    // ── Record-level scan ───────────────────────────────────────────────────
    /**
     * Scan an arbitrary record for PhysicalQuantity objects and verify
     * internal consistency: the unit must be known in the registry, and
     * the registry's dimension for that unit must match quantity.dimension.
     *
     * Returns an array of { field, error } pairs for any inconsistencies.
     */
    scanForQuantities(record) {
        const results = [];
        for (const [field, value] of Object.entries(record)) {
            if (!isPhysicalQuantity(value))
                continue;
            const def = this.registry.get(value.unit);
            if (!def) {
                results.push({ field, qty: value, unitKnown: false, consistent: false,
                    hint: `Unit "${value.unit}" is not in the registry.` });
                continue;
            }
            const consistent = dimensionsMatch(def.dimension, value.dimension);
            results.push({
                field, qty: value, unitKnown: true, consistent,
                hint: consistent ? undefined :
                    `Unit "${value.unit}" has dimension ${formatDimension(def.dimension)} ` +
                        `but quantity.dimension is ${formatDimension(value.dimension)}. ` +
                        `The unit string and dimension vector are inconsistent.`,
            });
        }
        return results;
    }
    // ── Conversion ─────────────────────────────────────────────────────────
    /**
     * Convert a PhysicalQuantity to the given target unit.
     *
     * Returns a new PhysicalQuantity, or throws if:
     *   - Either unit is unknown
     *   - The dimensions are incompatible
     */
    convert(qty, targetUnit) {
        const result = this.registry.convert(qty, targetUnit);
        if (result)
            return result;
        const srcDef = this.registry.get(qty.unit);
        const tgtDef = this.registry.get(targetUnit);
        if (!srcDef) {
            throw new Error(`Unknown source unit: "${qty.unit}"`);
        }
        if (!tgtDef) {
            throw new Error(`Unknown target unit: "${targetUnit}"`);
        }
        throw new Error(`Cannot convert from "${qty.unit}" (${formatDimension(srcDef.dimension)}) ` +
            `to "${targetUnit}" (${formatDimension(tgtDef.dimension)}): incompatible dimensions.`);
    }
    /**
     * Try to convert; returns null instead of throwing on failure.
     */
    tryConvert(qty, targetUnit) {
        try {
            return this.convert(qty, targetUnit);
        }
        catch {
            return null;
        }
    }
    /**
     * Normalize a PhysicalQuantity to its SI base unit.
     * e.g. { value: 100, unit: 'MPa' } → { value: 1e8, unit: 'Pa' }
     */
    toSI(qty) {
        const def = this.registry.get(qty.unit);
        if (!def)
            return null;
        const siUnit = this._siUnitFor(qty.dimension);
        if (!siUnit)
            return null;
        return this.registry.convert(qty, siUnit);
    }
    // ── Convenience factory ─────────────────────────────────────────────────
    /**
     * Build a PhysicalQuantity from a value and unit string.
     * The dimension is looked up from the registry automatically.
     */
    quantity(value, unit, uncertainty) {
        const q = this.registry.quantity(value, unit, uncertainty);
        if (!q)
            throw new Error(`Unknown unit: "${unit}"`);
        return q;
    }
    // ── Internal ────────────────────────────────────────────────────────────
    /** Find the canonical SI unit symbol for a given DimensionVector */
    _siUnitFor(dv) {
        const SI_UNITS = [
            [{ mass: 1 }, 'kg'],
            [{ length: 1 }, 'm'],
            [{ time: 1 }, 's'],
            [{ temperature: 1 }, 'K'],
            [{ current: 1 }, 'A'],
            [{ amount: 1 }, 'mol'],
            [{ mass: 1, length: 1, time: -2 }, 'N'],
            [{ mass: 1, length: -1, time: -2 }, 'Pa'],
            [{ mass: 1, length: 2, time: -2 }, 'J'],
            [{ mass: 1, length: 2, time: -3 }, 'W'],
            [{ current: 1, time: 1 }, 'C_charge'],
            [{ mass: 1, length: 2, time: -3, current: -1 }, 'V'],
            [{ time: -1 }, 'Hz'],
            [{ length: 1, time: -1 }, 'm/s'],
            [{ length: 1, time: -2 }, 'm/s²'],
            [{ mass: 1, length: -3 }, 'kg/m³'],
            [{ current: 1, time: 1, mass: -1 }, 'Ah/kg'],
            [{ length: 2, time: -2 }, 'J/kg'],
            [{ mass: 1, length: 1, time: -3, temperature: -1 }, 'W/(m·K)'],
            [{ length: 2, time: -2, temperature: -1 }, 'J/(kg·K)'],
            [{}, '—'],
        ];
        for (const [ref, sym] of SI_UNITS) {
            if (dimensionsMatch(dv, ref))
                return sym;
        }
        return null;
    }
}
/** Shared default checker — covers the standard engineering unit set */
export const defaultChecker = new DimensionalConsistencyChecker();
//# sourceMappingURL=DimensionalConsistencyChecker.js.map