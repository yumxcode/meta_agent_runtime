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
import { DimensionalConsistencyChecker } from '../../units/DimensionalConsistencyChecker.js';
import { formatDimension } from '../../units/dimensions.js';
const checker = new DimensionalConsistencyChecker();
export class DimensionChecker {
    name = 'DimensionChecker';
    phase = ['pre_call', 'post_call'];
    appliesTo = '*';
    async run(ctx) {
        const record = ctx.phase === 'pre_call' ? ctx.input : ctx.output;
        if (!record || typeof record !== 'object')
            return this._pass();
        const findings = checker.scanForQuantities(record);
        const problems = findings.filter(f => !f.consistent);
        if (problems.length === 0)
            return this._pass();
        const lines = problems.map(p => {
            if (!p.unitKnown) {
                return `  • Field "${p.field}": unknown unit "${p.qty.unit}"`;
            }
            return (`  • Field "${p.field}" (unit "${p.qty.unit}"): ` +
                `registry dimension is ${formatDimension(checker['registry'].get(p.qty.unit).dimension)}, ` +
                `but quantity.dimension is ${formatDimension(p.qty.dimension)}. ${p.hint ?? ''}`);
        });
        return {
            hookName: this.name,
            passed: false,
            severity: 'error',
            message: `Dimensional inconsistency in tool "${ctx.toolName}" (phase: ${ctx.phase}):\n` +
                lines.join('\n'),
            suggestedAction: 'pause_and_ask',
        };
    }
    _pass() {
        return {
            hookName: this.name,
            passed: true,
            severity: 'info',
            message: 'Dimension check passed (stub — full implementation pending)',
            suggestedAction: 'continue',
        };
    }
}
//# sourceMappingURL=DimensionChecker.js.map