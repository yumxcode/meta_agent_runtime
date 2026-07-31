import { describe, expect, it } from 'vitest'
import { shouldSuppressAttachedParkPresentation } from '../autoPresentation.js'

describe('attached Auto terminal presentation', () => {
  it('suppresses only an attached parked boundary', () => {
    expect(shouldSuppressAttachedParkPresentation(true, 'parked')).toBe(true)
    expect(shouldSuppressAttachedParkPresentation(false, 'parked')).toBe(false)
    expect(shouldSuppressAttachedParkPresentation(true, 'success')).toBe(false)
    expect(shouldSuppressAttachedParkPresentation(true, 'error_during_execution')).toBe(false)
  })
})
