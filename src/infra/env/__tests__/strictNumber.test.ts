/**
 * Regression tests for P2-3 (review 2026-08-27): a valid prefix followed by
 * garbage must not be accepted as a number.
 *
 * The concrete harms the review recorded:
 *   META_AGENT_JOB_TIMEOUT_MS=0oops → 0 → job watchdog silently DISABLED
 *   --max-turns=3junk               → 3 → accepted
 *   --max-budget-usd=1oops          → 1 → accepted
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { parseStrictInt, parseStrictFloat } from '../strictNumber.js'
import { readIntEnv, readIntEnvOr, readFloatEnv, _resetEnvWarningsForTest } from '../RuntimeEnv.js'

describe('parseStrictInt', () => {
  it('rejects a valid prefix followed by garbage', () => {
    // These are the exact strings from the review.
    expect(parseStrictInt('0oops')).toBeUndefined()
    expect(parseStrictInt('3junk')).toBeUndefined()
    expect(parseStrictInt('1oops')).toBeUndefined()
    expect(parseStrictInt('12abc')).toBeUndefined()
    expect(parseStrictInt('5 ')).toBe(5)        // trailing whitespace is fine
    expect(parseStrictInt('5,000')).toBeUndefined()
    expect(parseStrictInt('1_000')).toBeUndefined()
  })

  it('rejects forms parseInt would silently reinterpret', () => {
    expect(parseStrictInt('0x10')).toBeUndefined()   // parseInt → 0 in base 10
    expect(parseStrictInt('1e3')).toBeUndefined()    // parseInt → 1
    expect(parseStrictInt('1.9')).toBeUndefined()    // parseInt → 1
    expect(parseStrictInt('')).toBeUndefined()
    expect(parseStrictInt('   ')).toBeUndefined()
    expect(parseStrictInt('NaN')).toBeUndefined()
    expect(parseStrictInt('Infinity')).toBeUndefined()
  })

  it('refuses values too large to represent exactly', () => {
    // Silently rounding a limit means enforcing a number nobody wrote.
    expect(parseStrictInt('9007199254740993')).toBeUndefined()
    expect(parseStrictInt('9007199254740991')).toBe(9_007_199_254_740_991)
  })

  it('accepts plain integers including signs and zero', () => {
    expect(parseStrictInt('0')).toBe(0)
    expect(parseStrictInt('42')).toBe(42)
    expect(parseStrictInt('-7')).toBe(-7)
    expect(parseStrictInt('+7')).toBe(7)
  })
})

describe('parseStrictFloat', () => {
  it('rejects a valid prefix followed by garbage', () => {
    expect(parseStrictFloat('1oops')).toBeUndefined()
    expect(parseStrictFloat('2.5kg')).toBeUndefined()
    expect(parseStrictFloat('$3.00')).toBeUndefined()
  })

  it('rejects non-finite literals', () => {
    expect(parseStrictFloat('Infinity')).toBeUndefined()
    expect(parseStrictFloat('-Infinity')).toBeUndefined()
    expect(parseStrictFloat('NaN')).toBeUndefined()
  })

  it('accepts the decimal forms a user would reasonably type', () => {
    expect(parseStrictFloat('1')).toBe(1)
    expect(parseStrictFloat('1.5')).toBe(1.5)
    expect(parseStrictFloat('.5')).toBe(0.5)
    expect(parseStrictFloat('1.')).toBe(1)
    expect(parseStrictFloat('1e-3')).toBe(0.001)
    expect(parseStrictFloat('-2.25')).toBe(-2.25)
  })
})

describe('RuntimeEnv numeric accessors', () => {
  const VAR = 'META_AGENT_TEST_STRICT_NUMBER'

  beforeEach(() => {
    _resetEnvWarningsForTest()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    delete process.env[VAR]
    vi.restoreAllMocks()
  })

  it('falls back rather than accepting a garbage suffix', () => {
    process.env[VAR] = '0oops'
    expect(readIntEnv(VAR)).toBeUndefined()
    expect(readIntEnvOr(VAR, 30_000)).toBe(30_000)
  })

  it('announces the rejected value instead of absorbing it', () => {
    process.env[VAR] = '0oops'
    readIntEnv(VAR)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(VAR))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('0oops'))
  })

  it('warns at most once per variable', () => {
    process.env[VAR] = 'nonsense'
    readIntEnv(VAR)
    readIntEnv(VAR)
    readIntEnv(VAR)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('still reads well-formed values and honours bounds', () => {
    process.env[VAR] = '5'
    expect(readIntEnv(VAR)).toBe(5)
    expect(readIntEnv(VAR, { min: 10 })).toBeUndefined()
    expect(readIntEnv(VAR, { max: 3 })).toBeUndefined()
    expect(readIntEnvOr(VAR, 1, 10, 20)).toBe(10)   // clamped, not rejected
  })

  it('applies the same rule to float accessors', () => {
    process.env[VAR] = '1oops'
    expect(readFloatEnv(VAR)).toBeUndefined()
    process.env[VAR] = '1.5'
    expect(readFloatEnv(VAR)).toBe(1.5)
  })

  it('treats an unset or empty variable as "not configured", not as invalid', () => {
    delete process.env[VAR]
    expect(readIntEnv(VAR)).toBeUndefined()
    process.env[VAR] = '   '
    expect(readIntEnv(VAR)).toBeUndefined()
    expect(console.warn).not.toHaveBeenCalled()
  })
})
