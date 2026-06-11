import { describe, it, expect } from 'vitest'
import { parseCronExpression, nextRunDelayMs } from '../cronStore.js'

describe('parseCronExpression', () => {
  it('accepts wildcard, step, and fixed fields', () => {
    expect(() => parseCronExpression('* * * * * *')).not.toThrow()
    expect(() => parseCronExpression('*/30 * * * * *')).not.toThrow()
    expect(() => parseCronExpression('0 */5 * * * *')).not.toThrow()
    expect(() => parseCronExpression('0 0 0 * * *')).not.toThrow()
  })

  it('rejects malformed expressions', () => {
    expect(() => parseCronExpression('* * *')).toThrow(/6 fields/)
    expect(() => parseCronExpression('61 * * * * *')).toThrow(/second/)
    expect(() => parseCronExpression('*/0 * * * * *')).toThrow(/step/)
    expect(() => parseCronExpression('abc * * * * *')).toThrow(/second/)
  })

  it('rejects calendar fields instead of silently mis-scheduling', () => {
    expect(() => parseCronExpression('0 0 0 1 * *')).toThrow(/not supported/)
    expect(() => parseCronExpression('0 0 0 * * 1')).toThrow(/not supported/)
  })
})

describe('nextRunDelayMs', () => {
  // 2026-06-11T10:20:30.000 local time
  const base = new Date(2026, 5, 11, 10, 20, 30, 0).getTime()

  it('daily expression fires once per day, not every minute (H2 regression)', () => {
    const spec = parseCronExpression('0 0 0 * * *')
    const delay = nextRunDelayMs(spec, base)
    const next = new Date(base + delay)
    expect(next.getHours()).toBe(0)
    expect(next.getMinutes()).toBe(0)
    expect(next.getSeconds()).toBe(0)
    // Next midnight is > 13 h away from 10:20:30 — NOT 60 s.
    expect(delay).toBeGreaterThan(13 * 3600 * 1000)
    expect(delay).toBeLessThanOrEqual(24 * 3600 * 1000)
  })

  it('hourly fixed-minute expression schedules to the next matching minute', () => {
    const spec = parseCronExpression('0 30 * * * *')
    const delay = nextRunDelayMs(spec, base)
    const next = new Date(base + delay)
    expect(next.getMinutes()).toBe(30)
    expect(next.getSeconds()).toBe(0)
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThanOrEqual(3600 * 1000)
  })

  it('step-second expression fires on the next multiple', () => {
    const spec = parseCronExpression('*/15 * * * * *')
    const delay = nextRunDelayMs(spec, base)
    const next = new Date(base + delay)
    expect(next.getSeconds() % 15).toBe(0)
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThanOrEqual(15_000)
  })

  it('always returns a strictly future instant', () => {
    const spec = parseCronExpression('30 20 10 * * *')  // exactly the base time
    const delay = nextRunDelayMs(spec, base)
    expect(delay).toBeGreaterThan(0)                     // next DAY, not now
    expect(delay).toBeGreaterThan(23 * 3600 * 1000)
  })
})
