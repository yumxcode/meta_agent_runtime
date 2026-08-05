/**
 * Dimension algebra.
 *
 * The whole units system rests on these five functions, and they had zero
 * tests. They are pure, total, and have no I/O — the cheapest coverage in the
 * repository and the foundation the V&V DimensionChecker depends on.
 *
 * The invariant that matters throughout: an absent key and an exponent of 0 are
 * THE SAME THING. Every function has to agree on that, or `m/s × s` compares
 * unequal to `m` and dimensional checking produces false alarms.
 */
import { describe, expect, it } from 'vitest'
import {
  DIMENSIONLESS, DIMENSIONS,
  formatDimension, dimensionsMatch, multiplyDimensions, invertDimension, identifyDimension,
} from '../dimensions.js'

describe('dimensionsMatch', () => {
  it('treats an absent key and exponent 0 as identical', () => {
    expect(dimensionsMatch({ length: 1 }, { length: 1, mass: 0 })).toBe(true)
    expect(dimensionsMatch({}, { mass: 0, time: 0 })).toBe(true)
  })

  it('is order-independent (compares by base dimension, not key order)', () => {
    expect(dimensionsMatch(
      { mass: 1, length: 2, time: -2 },
      { time: -2, length: 2, mass: 1 },
    )).toBe(true)
  })

  it('DIMENSIONLESS equals the empty vector', () => {
    expect(dimensionsMatch(DIMENSIONLESS, {})).toBe(true)
  })

  it('distinguishes different exponents', () => {
    expect(dimensionsMatch({ length: 1 }, { length: 2 })).toBe(false)
    expect(dimensionsMatch({ length: 1 }, { length: -1 })).toBe(false)
  })

  it('distinguishes different base dimensions', () => {
    expect(dimensionsMatch(DIMENSIONS.LENGTH, DIMENSIONS.TIME)).toBe(false)
  })

  it('is reflexive and symmetric across the built-in table', () => {
    for (const ref of Object.values(DIMENSIONS)) {
      expect(dimensionsMatch(ref, ref)).toBe(true)
    }
    expect(dimensionsMatch(DIMENSIONS.FORCE, DIMENSIONS.ENERGY)).toBe(false)
    expect(dimensionsMatch(DIMENSIONS.ENERGY, DIMENSIONS.FORCE)).toBe(false)
  })
})

describe('multiplyDimensions', () => {
  it('adds exponents: VELOCITY × TIME = LENGTH', () => {
    const got = multiplyDimensions(DIMENSIONS.VELOCITY, DIMENSIONS.TIME)
    expect(dimensionsMatch(got, DIMENSIONS.LENGTH)).toBe(true)
  })

  it('ELIMINATES zero exponents rather than keeping them as 0', () => {
    // m/s × s must be exactly { length: 1 }, not { length: 1, time: 0 }.
    const got = multiplyDimensions(DIMENSIONS.VELOCITY, DIMENSIONS.TIME)
    expect(Object.keys(got)).toEqual(['length'])
  })

  it('FORCE × LENGTH = TORQUE (which shares ENERGY dimensions)', () => {
    const got = multiplyDimensions(DIMENSIONS.FORCE, DIMENSIONS.LENGTH)
    expect(dimensionsMatch(got, DIMENSIONS.TORQUE)).toBe(true)
    expect(dimensionsMatch(got, DIMENSIONS.ENERGY)).toBe(true)
  })

  it('multiplying by DIMENSIONLESS is the identity', () => {
    for (const ref of [DIMENSIONS.FORCE, DIMENSIONS.VOLTAGE, DIMENSIONS.DENSITY]) {
      expect(dimensionsMatch(multiplyDimensions(ref, DIMENSIONLESS), ref)).toBe(true)
    }
  })

  it('a vector times its own inverse is dimensionless', () => {
    const got = multiplyDimensions(DIMENSIONS.PRESSURE, invertDimension(DIMENSIONS.PRESSURE))
    expect(got).toEqual({})
    expect(dimensionsMatch(got, DIMENSIONLESS)).toBe(true)
  })

  it('is commutative', () => {
    const ab = multiplyDimensions(DIMENSIONS.FORCE, DIMENSIONS.VELOCITY)
    const ba = multiplyDimensions(DIMENSIONS.VELOCITY, DIMENSIONS.FORCE)
    expect(dimensionsMatch(ab, ba)).toBe(true)
  })

  it('does not mutate its inputs', () => {
    const a = { ...DIMENSIONS.FORCE }
    const b = { ...DIMENSIONS.LENGTH }
    multiplyDimensions(a, b)
    expect(a).toEqual(DIMENSIONS.FORCE)
    expect(b).toEqual(DIMENSIONS.LENGTH)
  })
})

describe('invertDimension', () => {
  it('negates every exponent', () => {
    expect(invertDimension(DIMENSIONS.VELOCITY)).toEqual({ length: -1, time: 1 })
  })

  it('is an involution — inverting twice returns the original', () => {
    for (const ref of Object.values(DIMENSIONS)) {
      expect(dimensionsMatch(invertDimension(invertDimension(ref)), ref)).toBe(true)
    }
  })

  it('inverting DIMENSIONLESS stays dimensionless', () => {
    expect(invertDimension(DIMENSIONLESS)).toEqual({})
  })

  it('drops zero exponents instead of emitting -0', () => {
    const got = invertDimension({ length: 1, mass: 0 })
    expect(Object.keys(got)).toEqual(['length'])
    expect(Object.is(got.length, -1)).toBe(true)
  })
})

describe('identifyDimension', () => {
  it('names common mechanical dimensions', () => {
    expect(identifyDimension(DIMENSIONS.VELOCITY)).toBe('VELOCITY')
    expect(identifyDimension(DIMENSIONS.ACCELERATION)).toBe('ACCELERATION')
    expect(identifyDimension(DIMENSIONS.FORCE)).toBe('FORCE')
  })

  it('returns the FIRST table entry for genuinely ambiguous dimensions', () => {
    // PRESSURE and STRESS are dimensionally identical, as are ENERGY and TORQUE.
    // The function documents "first matching entry" — pin that, so a reordering
    // of the table is a visible change rather than a silent one.
    expect(identifyDimension({ mass: 1, length: -1, time: -2 })).toBe('PRESSURE')
    expect(identifyDimension({ mass: 1, length: 2, time: -2 })).toBe('ENERGY')
    expect(identifyDimension({ time: -1 })).toBe('FREQUENCY')
  })

  it('returns null for a combination that is not in the table', () => {
    expect(identifyDimension({ length: 7, luminosity: -3 })).toBeNull()
  })

  it('matches regardless of explicit zero exponents', () => {
    expect(identifyDimension({ length: 1, time: -1, mass: 0 })).toBe('VELOCITY')
  })
})

describe('formatDimension', () => {
  it('renders the empty vector as "dimensionless"', () => {
    expect(formatDimension({})).toBe('dimensionless')
    expect(formatDimension(DIMENSIONLESS)).toBe('dimensionless')
    expect(formatDimension({ mass: 0 })).toBe('dimensionless')
  })

  it('renders negative exponents', () => {
    const out = formatDimension(DIMENSIONS.PRESSURE)
    expect(out).toContain('M')
    expect(out).toContain('L')
    expect(out).toContain('T')
    expect(out).toMatch(/⁻/)          // superscript minus for the negative powers
  })

  it('omits zero-exponent dimensions from the output', () => {
    expect(formatDimension({ length: 1, mass: 0 })).toBe(formatDimension({ length: 1 }))
  })

  it('is stable in base-dimension order, not insertion order', () => {
    expect(formatDimension({ time: -2, mass: 1, length: 1 }))
      .toBe(formatDimension({ length: 1, time: -2, mass: 1 }))
  })
})
