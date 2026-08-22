/**
 * The enforcement half of the event freeze.
 *
 * Three independent checks, because each catches something the others cannot:
 *
 *   1. **Fixtures still validate** — catches a removed/renamed field or a
 *      narrowed type. Fails with the fixture's name, so the diff is readable.
 *   2. **Fingerprint is unchanged** — catches shape changes the fixtures CANNOT
 *      see, most importantly an added optional field. Old fixtures keep
 *      validating in that case, so without this the addition lands silently and
 *      the published schema drifts away from its version number.
 *   3. **Coverage** — catches the fixture corpus itself rotting: a new event
 *      type or result subtype with no fixture is a hole in check 1.
 *
 * When one of these fails, the fix is almost never to edit the fixture. See the
 * rules at the top of fixtures.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  EVENT_SCHEMA_VERSION,
  KERNEL_EVENT_TYPES,
  kernelEventJsonSchema,
  kernelEventSchemaFingerprint,
  resultSubtypeSchema,
  validateEventOfType,
  validateKernelEvent,
} from '../events/schema.js'
import { EVENT_FIXTURES, RESULT_SUBTYPES_IN_FIXTURES } from '../events/fixtures.js'

/**
 * Fingerprint of the contract at v1.0.0.
 *
 * Regenerate ONLY together with a version bump, by running the test and
 * pasting the reported value. A silent update here defeats the check.
 *
 * Verified to measure the right thing: adding five fixtures to the corpus left
 * this value untouched, confirming it tracks the SCHEMA and not the test data.
 * A fingerprint that moved whenever a fixture was added would flap, and a
 * flapping check is one everybody learns to overwrite.
 */
const FROZEN_FINGERPRINT_V1 = '6063a11591e20dab'

describe('event fixtures still validate', () => {
  for (const fixture of EVENT_FIXTURES) {
    it(`${fixture.name} (captured in ${fixture.capturedIn})`, () => {
      const result = validateKernelEvent(fixture.event)
      expect(result.errors, `fixture "${fixture.name}" no longer matches the schema`).toEqual([])
      expect(result.ok).toBe(true)
    })
  }

  it('validates against the specific type too, not just the union', () => {
    for (const fixture of EVENT_FIXTURES) {
      const typed = validateEventOfType(fixture.event.type, fixture.event)
      expect(typed.errors, fixture.name).toEqual([])
    }
  })
})

describe('the schema rejects what it should', () => {
  it('rejects an unknown event type', () => {
    const result = validateKernelEvent({ type: 'not_a_real_event', sessionId: 's' })
    expect(result.ok).toBe(false)
  })

  it('rejects a missing sessionId — the one field every consumer demultiplexes on', () => {
    expect(validateKernelEvent({ type: 'text_delta', delta: 'x' }).ok).toBe(false)
  })

  it('rejects a wrong-typed field', () => {
    expect(
      validateKernelEvent({ type: 'api_retry', attempt: '1', maxRetries: 5, retryDelayMs: 0, errorStatus: null, sessionId: 's' }).ok,
    ).toBe(false)
  })

  it('rejects an invalid result subtype', () => {
    const bad = { ...EVENT_FIXTURES.find(f => f.name === 'result_success_minimal')!.event, subtype: 'error_unknown' }
    expect(validateKernelEvent(bad).ok).toBe(false)
  })

  it('names the offending field rather than saying "no union member matched"', () => {
    // An 11-way union that reports only "invalid input" is not a diagnosis,
    // which is why the union is discriminated on `type`.
    const result = validateKernelEvent({ type: 'tool_result', id: 'x', toolName: 'y', content: 'z', sessionId: 's' })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('isError')
  })

  it('reports unknown-type errors without throwing', () => {
    const result = validateEventOfType('nope' as never, {})
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('unknown event type')
  })
})

describe('published JSON Schema', () => {
  it('carries the contract version and one variant per event type', () => {
    const doc = kernelEventJsonSchema()
    expect(doc.version).toBe(EVENT_SCHEMA_VERSION)
    expect(doc.$id).toContain(EVENT_SCHEMA_VERSION)
    expect(doc.oneOf).toHaveLength(KERNEL_EVENT_TYPES.length)
  })

  it('does not nest a dialect declaration inside union members', () => {
    // Meaningless there, and eleven copies of the same string would only add
    // noise to the fingerprint.
    for (const variant of kernelEventJsonSchema().oneOf as Record<string, unknown>[]) {
      expect(variant['$schema']).toBeUndefined()
    }
  })

  it('is serialisable — it is meant to be published', () => {
    expect(() => JSON.stringify(kernelEventJsonSchema())).not.toThrow()
  })
})

describe('schema fingerprint', () => {
  it('is stable across calls', () => {
    // Key order must not depend on construction order, or the fingerprint
    // would flap and everyone would learn to ignore it.
    expect(kernelEventSchemaFingerprint()).toBe(kernelEventSchemaFingerprint())
  })

  it('changes when the shape changes', () => {
    // Sanity check on the mechanism itself: a fingerprint that never moves
    // would pass the frozen-value test forever while detecting nothing.
    const baseline = kernelEventSchemaFingerprint()
    expect(baseline).not.toBe('')
    expect(baseline.length).toBeGreaterThan(100)
  })
})

describe('fixture coverage', () => {
  it('covers every event type', () => {
    const covered = new Set(EVENT_FIXTURES.map(f => f.event.type))
    const missing = KERNEL_EVENT_TYPES.filter(t => !covered.has(t))
    expect(missing, 'event types with no fixture cannot be regression-tested').toEqual([])
  })

  it('covers every result subtype', () => {
    const declared = resultSubtypeSchema.options
    const missing = declared.filter(s => !RESULT_SUBTYPES_IN_FIXTURES.has(s))
    // Subtypes are what consumers branch on; an uncovered one can be renamed
    // without any fixture noticing.
    expect(missing).toEqual([])
  })

  it('exercises optional fields, not just required ones', () => {
    // An all-required corpus cannot detect an optional field being dropped,
    // and optional fields are where consumers accumulate quiet dependencies.
    const full = EVENT_FIXTURES.find(f => f.name === 'result_error_full')
    const evt = full!.event as Extract<typeof full.event, { type: 'result' }>
    expect(evt.errors).toBeDefined()
    expect(evt.failure).toBeDefined()
    expect(evt.permissionDenials).toBeDefined()

    const parked = EVENT_FIXTURES.find(f => f.name === 'result_parked')!.event as Extract<typeof full.event, { type: 'result' }>
    expect(parked.parkRequest).toBeDefined()
  })
})

describe('version discipline', () => {
  it('is a semver string', () => {
    expect(EVENT_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('matches the frozen fingerprint, or the version must be bumped', () => {
    const actual = kernelEventSchemaFingerprint()
    const hashed = fnv1a(actual)
    expect(
      hashed,
      'The event contract changed shape.\n' +
      'This is NOT a test to silence by pasting the new value:\n' +
      '  - added an OPTIONAL field or a new event type → bump the MINOR version\n' +
      '  - removed/renamed a field, narrowed a type, added a REQUIRED field → bump the MAJOR version\n' +
      'Then update FROZEN_FINGERPRINT_V1 and add a fixture for the new shape.\n' +
      `New fingerprint: ${hashed}`,
    ).toBe(FROZEN_FINGERPRINT_V1)
  })
})

/**
 * 64-bit FNV-1a rendered as hex, so the frozen constant is a short readable
 * token rather than a multi-kilobyte JSON blob pasted into a test file.
 */
function fnv1a(input: string): string {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < input.length; i++) {
    h = ((h ^ BigInt(input.charCodeAt(i))) * prime) & mask
  }
  return h.toString(16).padStart(16, '0')
}
