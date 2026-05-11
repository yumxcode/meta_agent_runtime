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

import type { VVHook, VVResult, VVContext } from '../types.js'
import { DimensionalConsistencyChecker } from '../../units/DimensionalConsistencyChecker.js'
import { formatDimension } from '../../units/dimensions.js'

const checker = new DimensionalConsistencyChecker()

export class DimensionChecker implements VVHook {
  readonly name = 'DimensionChecker'
  readonly phase: import('../types.js').VVPhase[] = ['pre_call', 'post_call']
  readonly appliesTo = '*' as const

  async run(ctx: VVContext): Promise<VVResult> {
    const record = ctx.phase === 'pre_call' ? ctx.input : ctx.output
    if (!record || typeof record !== 'object') return this._pass()

    const findings = checker.scanForQuantities(record as Record<string, unknown>)
    const problems = findings.filter(f => !f.consistent)

    if (problems.length === 0) return this._pass()

    const lines = problems.map(p => {
      if (!p.unitKnown) {
        return `  • Field "${p.field}": unknown unit "${p.qty.unit}"`
      }
      return (
        `  • Field "${p.field}" (unit "${p.qty.unit}"): ` +
        `registry dimension is ${formatDimension(checker['registry'].get(p.qty.unit)!.dimension)}, ` +
        `but quantity.dimension is ${formatDimension(p.qty.dimension)}. ${p.hint ?? ''}`
      )
    })

    return {
      hookName: this.name,
      passed: false,
      severity: 'error',
      message:
        `Dimensional inconsistency in tool "${ctx.toolName}" (phase: ${ctx.phase}):\n` +
        lines.join('\n'),
      suggestedAction: 'pause_and_ask',
    }
  }

  private _pass(): VVResult {
    return {
      hookName: this.name,
      passed: true,
      severity: 'info',
      message: 'Dimension check passed',
      suggestedAction: 'continue',
    }
  }
}
