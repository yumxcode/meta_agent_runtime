/**
 * Regression: the A↔B oscillation guard. The consecutive-repeat counter resets
 * on every signature change, so a model ping-ponging between two identical
 * tool batches never tripped the no-progress stop.
 */
import { describe, it, expect } from 'vitest'
import { isAlternatingToolSignatures } from '../loop/KernelLoop.js'

describe('isAlternatingToolSignatures', () => {
  it('detects a strict ABABAB oscillation (3 full cycles)', () => {
    expect(isAlternatingToolSignatures(['A', 'B', 'A', 'B', 'A', 'B'])).toBe(true)
  })

  it('ignores short histories', () => {
    expect(isAlternatingToolSignatures(['A', 'B', 'A', 'B'])).toBe(false)
  })

  it('ignores identical consecutive signatures (the other guard owns AAA)', () => {
    expect(isAlternatingToolSignatures(['A', 'A', 'A', 'A', 'A', 'A'])).toBe(false)
  })

  it('ignores genuine progress with three distinct signatures', () => {
    expect(isAlternatingToolSignatures(['A', 'B', 'C', 'A', 'B', 'C'])).toBe(false)
    expect(isAlternatingToolSignatures(['A', 'B', 'A', 'B', 'A', 'C'])).toBe(false)
  })

  it('only inspects the trailing window', () => {
    // Old noise followed by a clean 6-entry oscillation must still trip.
    expect(isAlternatingToolSignatures(['X', 'Y', 'Z', 'A', 'B', 'A', 'B', 'A', 'B'])).toBe(true)
  })
})
