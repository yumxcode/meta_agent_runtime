/**
 * DimensionalConsistencyChecker — the engine behind the V&V DimensionChecker
 * hook that `createDefaultVVChain()` registers by default.
 *
 * Its job is to catch the failure mode the README calls out: a plausible-looking
 * number carrying the wrong physical dimension. Two properties matter most and
 * neither was tested:
 *
 *   1. It must not cry wolf. Undeclared fields, scalar fields and absent fields
 *      are all legitimate and must produce zero errors — a checker that fires on
 *      ordinary input gets switched off, and then it protects nothing.
 *   2. It must report EVERY offending field, not short-circuit on the first,
 *      or a multi-parameter mistake looks like a single-parameter one.
 */
import { describe, expect, it } from 'vitest'
import { DimensionalConsistencyChecker, defaultChecker } from '../DimensionalConsistencyChecker.js'
import { UnitRegistry } from '../UnitRegistry.js'
import { DIMENSIONS } from '../dimensions.js'
import type { DimensionSpec, PhysicalQuantity } from '../types.js'

const checker = defaultChecker

const qty = (value: number, unit: string, dimension: Record<string, number>): PhysicalQuantity =>
  ({ value, unit, dimension } as PhysicalQuantity)

const SPEC: DimensionSpec = {
  temperature: { dimension: DIMENSIONS.TEMPERATURE },
  pressure:    { dimension: DIMENSIONS.PRESSURE },
  label:       {},                                   // no dimension → not checked
}

describe('checkInput / checkOutput — clean cases produce NO errors', () => {
  it('accepts matching dimensions', () => {
    expect(checker.checkInput(SPEC, {
      temperature: qty(300, 'K', DIMENSIONS.TEMPERATURE),
      pressure:    qty(101325, 'Pa', DIMENSIONS.PRESSURE),
    })).toEqual([])
  })

  it('skips fields whose spec declares no dimension', () => {
    expect(checker.checkInput(SPEC, { label: 'anything at all' })).toEqual([])
    expect(checker.checkInput(SPEC, { label: 12345 })).toEqual([])
  })

  it('skips absent / null / undefined fields (presence is a different concern)', () => {
    expect(checker.checkInput(SPEC, {})).toEqual([])
    expect(checker.checkInput(SPEC, { temperature: undefined })).toEqual([])
    expect(checker.checkInput(SPEC, { temperature: null })).toEqual([])
  })

  it('ignores record fields that the spec never mentions', () => {
    expect(checker.checkInput(SPEC, { unrelated: qty(1, 'm', DIMENSIONS.LENGTH) })).toEqual([])
  })

  it('accepts dimensionally-equal aliases (Pa as PRESSURE or STRESS)', () => {
    expect(checker.checkInput(
      { load: { dimension: DIMENSIONS.STRESS } },
      { load: qty(1e6, 'MPa', DIMENSIONS.PRESSURE) },
    )).toEqual([])
  })

  it('checkOutput behaves identically to checkInput', () => {
    const bad = { temperature: qty(1, 'm', DIMENSIONS.LENGTH) }
    expect(checker.checkOutput(SPEC, bad)).toHaveLength(1)
    expect(checker.checkOutput(SPEC, bad)[0]?.param).toBe('temperature')
  })
})

describe('checkInput — dimension mismatches', () => {
  it('flags a wrong dimension and names the field', () => {
    const errors = checker.checkInput(SPEC, {
      temperature: qty(5, 'm', DIMENSIONS.LENGTH),
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]?.param).toBe('temperature')
  })

  it('reports both the expected and the received dimension', () => {
    const [err] = checker.checkInput(SPEC, { temperature: qty(5, 'm', DIMENSIONS.LENGTH) })
    expect(err!.expected).toEqual(DIMENSIONS.TEMPERATURE)
    expect(err!.received).toEqual(DIMENSIONS.LENGTH)
  })

  it('the hint mentions the offending unit so the model can self-correct', () => {
    const [err] = checker.checkInput(SPEC, { temperature: qty(5, 'm', DIMENSIONS.LENGTH) })
    expect(err!.hint).toContain('temperature')
    expect(err!.hint).toContain('"m"')
  })

  it('reports EVERY offending field, not just the first', () => {
    const errors = checker.checkInput(SPEC, {
      temperature: qty(5, 'm', DIMENSIONS.LENGTH),
      pressure:    qty(5, 's', DIMENSIONS.TIME),
    })
    expect(errors.map(e => e.param).sort()).toEqual(['pressure', 'temperature'])
  })
})

describe('checkInput — malformed quantities', () => {
  it('flags a raw number where a PhysicalQuantity was declared', () => {
    // This is the common real mistake: passing `300` instead of `{value:300,…}`.
    const [err] = checker.checkInput(SPEC, { temperature: 300 })
    expect(err?.param).toBe('temperature')
    expect(err?.hint).toMatch(/PhysicalQuantity/)
  })

  it('flags a string and an array too', () => {
    expect(checker.checkInput(SPEC, { temperature: '300K' })).toHaveLength(1)
    expect(checker.checkInput(SPEC, { temperature: [300] })).toHaveLength(1)
  })

  it('flags an object that is missing required quantity fields', () => {
    expect(checker.checkInput(SPEC, { temperature: { value: 300 } })).toHaveLength(1)
    expect(checker.checkInput(SPEC, { temperature: { value: 300, unit: 'K' } })).toHaveLength(1)
    expect(checker.checkInput(SPEC, { temperature: { unit: 'K', dimension: {} } })).toHaveLength(1)
  })

  it('a malformed value reports an empty received dimension rather than crashing', () => {
    const [err] = checker.checkInput(SPEC, { temperature: 300 })
    expect(err!.received).toEqual({})
  })
})

describe('scanForQuantities', () => {
  it('ignores non-quantity fields', () => {
    expect(checker.scanForQuantities({ a: 1, b: 'x', c: null })).toEqual([])
  })

  it('reports a quantity whose unit is not in the registry', () => {
    const [r] = checker.scanForQuantities({ len: qty(1, 'furlong', DIMENSIONS.LENGTH) })
    expect(r!.unitKnown).toBe(false)
    expect(r!.consistent).toBe(false)
    expect(r!.hint).toMatch(/not in the registry/)
  })

  it('detects a unit whose dimension contradicts the declared dimension', () => {
    // Says metres, but claims a TIME dimension — internally inconsistent.
    const [r] = checker.scanForQuantities({ x: qty(1, 'm', DIMENSIONS.TIME) })
    expect(r!.unitKnown).toBe(true)
    expect(r!.consistent).toBe(false)
    expect(r!.hint).toMatch(/inconsistent/)
  })

  it('passes a self-consistent quantity with no hint', () => {
    const [r] = checker.scanForQuantities({ x: qty(1, 'm', DIMENSIONS.LENGTH) })
    expect(r!.consistent).toBe(true)
    expect(r!.hint).toBeUndefined()
  })
})

describe('convert / tryConvert / toSI', () => {
  it('convert() returns a converted quantity', () => {
    const out = checker.convert(qty(1, 'km', DIMENSIONS.LENGTH), 'm')
    expect(out.value).toBeCloseTo(1000, 9)
    expect(out.unit).toBe('m')
  })

  it('convert() THROWS with a diagnostic message on incompatible dimensions', () => {
    expect(() => checker.convert(qty(1, 'm', DIMENSIONS.LENGTH), 's'))
      .toThrow(/incompatible dimensions/)
  })

  it('convert() names which side is the unknown unit', () => {
    expect(() => checker.convert(qty(1, 'furlong', DIMENSIONS.LENGTH), 'm'))
      .toThrow(/Unknown source unit/)
    expect(() => checker.convert(qty(1, 'm', DIMENSIONS.LENGTH), 'furlong'))
      .toThrow(/Unknown target unit/)
  })

  it('tryConvert() returns null exactly where convert() throws', () => {
    expect(checker.tryConvert(qty(1, 'm', DIMENSIONS.LENGTH), 's')).toBeNull()
    expect(checker.tryConvert(qty(1, 'furlong', DIMENSIONS.LENGTH), 'm')).toBeNull()
    expect(checker.tryConvert(qty(1, 'km', DIMENSIONS.LENGTH), 'm')?.value).toBeCloseTo(1000, 9)
  })

  it('toSI() normalises to the base unit', () => {
    const out = checker.toSI(qty(100, 'MPa', DIMENSIONS.PRESSURE))
    expect(out!.value).toBeCloseTo(1e8, 0)
  })

  it('toSI() returns null for an unknown unit', () => {
    expect(checker.toSI(qty(1, 'furlong', DIMENSIONS.LENGTH))).toBeNull()
  })
})

describe('custom registry injection', () => {
  it('uses the registry passed to the constructor', () => {
    const custom = new UnitRegistry({
      smoot: { dimension: DIMENSIONS.LENGTH, toSI: v => v * 1.702, fromSI: v => v / 1.702 },
    })
    const c = new DimensionalConsistencyChecker(custom)
    expect(c.convert(qty(1, 'smoot', DIMENSIONS.LENGTH), 'm').value).toBeCloseTo(1.702, 6)
    // The default checker knows nothing about it.
    expect(() => checker.convert(qty(1, 'smoot', DIMENSIONS.LENGTH), 'm')).toThrow()
  })
})
