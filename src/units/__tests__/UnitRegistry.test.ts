/**
 * UnitRegistry — unit lookup and conversion.
 *
 * The behaviour most worth pinning is AFFINE units. °C and °F do not scale
 * linearly to SI (they have an offset), so a conversion implemented as a plain
 * ratio silently produces numbers that are wrong by 273.15 — the kind of error
 * that looks plausible in a log and blows up on hardware. There were no tests.
 *
 * The second thing pinned here is that conversion FAILS with `null` rather than
 * returning a wrong number: a cross-dimension or unknown-unit request must be
 * distinguishable from a successful conversion by the caller.
 */
import { describe, expect, it } from 'vitest'
import { UnitRegistry, defaultRegistry } from '../UnitRegistry.js'
import { DIMENSIONS, dimensionsMatch } from '../dimensions.js'

const reg = defaultRegistry

describe('lookup', () => {
  it('resolves built-in units and reports their dimension', () => {
    expect(dimensionsMatch(reg.get('m')!.dimension, DIMENSIONS.LENGTH)).toBe(true)
    expect(dimensionsMatch(reg.get('N')!.dimension, DIMENSIONS.FORCE)).toBe(true)
    expect(dimensionsMatch(reg.get('Pa')!.dimension, DIMENSIONS.PRESSURE)).toBe(true)
  })

  it('returns null for an unknown unit rather than throwing', () => {
    expect(reg.get('furlong')).toBeNull()
    expect(reg.get('')).toBeNull()
  })

  it('knownUnits() lists the built-ins', () => {
    const known = reg.knownUnits()
    for (const u of ['kg', 'm', 's', 'K', '°C', 'N', 'Pa', 'J', 'W', 'Hz']) {
      expect(known, u).toContain(u)
    }
  })

  it('register() adds a unit without disturbing the default registry', () => {
    const custom = new UnitRegistry()
    custom.register('smoot', {
      dimension: DIMENSIONS.LENGTH,
      toSI: v => v * 1.702,
      fromSI: v => v / 1.702,
      description: 'Smoot',
    })
    expect(custom.get('smoot')).not.toBeNull()
    expect(reg.get('smoot')).toBeNull()          // default registry untouched
  })

  it('a registry constructed with additional units keeps the built-ins too', () => {
    const custom = new UnitRegistry({
      smoot: { dimension: DIMENSIONS.LENGTH, toSI: v => v * 1.702, fromSI: v => v / 1.702 },
    })
    expect(custom.get('smoot')).not.toBeNull()
    expect(custom.get('m')).not.toBeNull()
  })
})

describe('linear conversion', () => {
  it('converts within a dimension', () => {
    expect(reg.convertValue(1, 'km', 'm')).toBeCloseTo(1000, 9)
    expect(reg.convertValue(1000, 'g', 'kg')).toBeCloseTo(1, 9)
    expect(reg.convertValue(1, 'h', 's')).toBeCloseTo(3600, 9)
  })

  it('round-trips without drift', () => {
    for (const [a, b] of [['m', 'km'], ['kg', 'lb'], ['s', 'min'], ['Pa', 'psi'], ['J', 'cal']]) {
      const there = reg.convertValue(12.5, a!, b!)!
      const back = reg.convertValue(there, b!, a!)!
      expect(back, `${a}→${b}→${a}`).toBeCloseTo(12.5, 6)
    }
  })

  it('converting a unit to itself is the identity', () => {
    expect(reg.convertValue(42.5, 'm', 'm')).toBe(42.5)
  })

  it('handles 0 and negative values', () => {
    expect(reg.convertValue(0, 'km', 'm')).toBe(0)
    expect(reg.convertValue(-3, 'km', 'm')).toBeCloseTo(-3000, 9)
  })
})

describe('affine (temperature) conversion', () => {
  // These are the ones a ratio-based implementation gets wrong.
  it('0 °C = 273.15 K', () => {
    expect(reg.convertValue(0, '°C', 'K')).toBeCloseTo(273.15, 9)
  })

  it('273.15 K = 0 °C', () => {
    expect(reg.convertValue(273.15, 'K', '°C')).toBeCloseTo(0, 9)
  })

  it('100 °C = 373.15 K (boiling point)', () => {
    expect(reg.convertValue(100, '°C', 'K')).toBeCloseTo(373.15, 9)
  })

  it('32 °F = 0 °C and 212 °F = 100 °C', () => {
    expect(reg.convertValue(32, '°F', '°C')).toBeCloseTo(0, 6)
    expect(reg.convertValue(212, '°F', '°C')).toBeCloseTo(100, 6)
  })

  it('-40 is the same number in °C and °F', () => {
    expect(reg.convertValue(-40, '°C', '°F')).toBeCloseTo(-40, 6)
  })

  it('round-trips through the affine offset', () => {
    const k = reg.convertValue(25, '°C', 'K')!
    expect(reg.convertValue(k, 'K', '°C')).toBeCloseTo(25, 9)
  })

  it('the "C" alias behaves like °C', () => {
    expect(reg.convertValue(0, 'C', 'K')).toBeCloseTo(273.15, 9)
  })
})

describe('conversion failure modes', () => {
  it('returns null across incompatible dimensions instead of a wrong number', () => {
    expect(reg.convertValue(1, 'm', 's')).toBeNull()
    expect(reg.convertValue(1, 'kg', 'J')).toBeNull()
    expect(reg.convertValue(1, 'K', 'm')).toBeNull()
  })

  it('returns null when either unit is unknown', () => {
    expect(reg.convertValue(1, 'm', 'furlong')).toBeNull()
    expect(reg.convertValue(1, 'furlong', 'm')).toBeNull()
  })

  it('convert() mirrors convertValue for the same failures', () => {
    expect(reg.convert({ value: 1, unit: 'm', dimension: DIMENSIONS.LENGTH }, 's')).toBeNull()
    expect(reg.convert({ value: 1, unit: 'm', dimension: DIMENSIONS.LENGTH }, 'furlong')).toBeNull()
  })

  it('same-dimension units that alias each other convert cleanly (Pa/stress)', () => {
    // PRESSURE and STRESS share a dimension vector; conversion must not be
    // blocked by the *name* differing.
    expect(reg.convertValue(1, 'MPa', 'Pa')).toBeCloseTo(1e6, 3)
  })
})

describe('convert() — quantity objects and uncertainty', () => {
  const metres = (v: number, u?: number) => reg.quantity(v, 'm', u)!

  it('produces a quantity carrying the TARGET unit', () => {
    const out = reg.convert(metres(1500), 'km')!
    expect(out.unit).toBe('km')
    expect(out.value).toBeCloseTo(1.5, 9)
  })

  it('omits uncertainty when the source had none', () => {
    expect(reg.convert(metres(1500), 'km')!.uncertainty).toBeUndefined()
  })

  it('scales uncertainty proportionally for LINEAR units', () => {
    const out = reg.convert(metres(1000, 10), 'km')!
    expect(out.value).toBeCloseTo(1, 9)
    expect(out.uncertainty).toBeCloseTo(0.01, 9)
  })

  it('uncertainty stays positive regardless of conversion direction', () => {
    const out = reg.convert(reg.quantity(1, 'km', 0.5)!, 'm')!
    expect(out.uncertainty).toBeGreaterThan(0)
    expect(out.uncertainty).toBeCloseTo(500, 6)
  })

  it('DOCUMENTED APPROXIMATION: affine uncertainty is the absolute SI delta', () => {
    // The source comments this as "approximate but acceptable for 1σ". A ±1 °C
    // uncertainty is ±1 K, because the offset cancels in a difference. Pinning
    // the current semantics so a future change is a deliberate one.
    const out = reg.convert(reg.quantity(25, '°C', 1)!, 'K')!
    expect(out.value).toBeCloseTo(298.15, 9)
    expect(out.uncertainty).toBeCloseTo(1, 6)
  })
})

describe('quantity()', () => {
  it('builds a quantity with the unit\'s dimension attached', () => {
    const q = reg.quantity(9.8, 'm/s²')!
    expect(q.value).toBe(9.8)
    expect(q.unit).toBe('m/s²')
    expect(dimensionsMatch(q.dimension, DIMENSIONS.ACCELERATION)).toBe(true)
  })

  it('attaches uncertainty only when supplied', () => {
    expect(reg.quantity(1, 'm')!.uncertainty).toBeUndefined()
    expect(reg.quantity(1, 'm', 0.1)!.uncertainty).toBe(0.1)
  })

  it('returns null for an unknown unit', () => {
    expect(reg.quantity(1, 'furlong')).toBeNull()
  })
})
