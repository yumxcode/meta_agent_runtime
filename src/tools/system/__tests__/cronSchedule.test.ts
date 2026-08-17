import { describe, it, expect } from 'vitest'
import { parseCronExpression, nextRunDelayMs } from '../cronStore.js'

/** Wall-clock instant of the next run, for readable assertions. */
function nextRun(expr: string, from: Date): Date {
  return new Date(from.getTime() + nextRunDelayMs(parseCronExpression(expr), from.getTime()))
}

describe('nextRunDelayMs', () => {
  it('fires a daily job at the right wall-clock time', () => {
    const from = new Date(2026, 7, 17, 8, 0, 0)
    const hit = nextRun('0 0 9 * * *', from)
    expect(hit.getHours()).toBe(9)
    expect(hit.getMinutes()).toBe(0)
    expect(hit.getSeconds()).toBe(0)
    expect(hit.getDate()).toBe(17)
  })

  it('rolls a daily job to tomorrow once its time has passed', () => {
    const from = new Date(2026, 7, 17, 10, 0, 0)
    const hit = nextRun('0 0 9 * * *', from)
    expect(hit.getDate()).toBe(18)
    expect(hit.getHours()).toBe(9)
  })

  it('handles */5 minutes', () => {
    const hit = nextRun('0 */5 * * * *', new Date(2026, 7, 17, 10, 3, 30))
    expect(hit.getMinutes()).toBe(5)
    expect(hit.getSeconds()).toBe(0)
  })

  it('handles every-second and per-minute expressions', () => {
    const from = new Date(2026, 7, 17, 10, 3, 30)
    expect(nextRunDelayMs(parseCronExpression('* * * * * *'), from.getTime())).toBe(1000)
    const perMinute = nextRun('0 * * * * *', from)
    expect(perMinute.getMinutes()).toBe(4)
    expect(perMinute.getSeconds()).toBe(0)
  })

  it('crosses midnight correctly', () => {
    const hit = nextRun('0 30 0 * * *', new Date(2026, 7, 17, 23, 59, 59))
    expect(hit.getDate()).toBe(18)
    expect(hit.getHours()).toBe(0)
    expect(hit.getMinutes()).toBe(30)
  })

  it('always returns a strictly future instant', () => {
    const exprs = ['* * * * * *', '0 * * * * *', '0 0 9 * * *', '0 */5 * * * *', '30 15 4 * * *']
    // Sweep a full day at 7-minute steps: every expression must produce a delay
    // that is positive and lands within 25 h.
    for (const expr of exprs) {
      const spec = parseCronExpression(expr)
      for (let m = 0; m < 24 * 60; m += 7) {
        const from = new Date(2026, 7, 17, Math.floor(m / 60), m % 60, 33).getTime()
        const delay = nextRunDelayMs(spec, from)
        expect(delay, `${expr} @ ${new Date(from).toISOString()}`).toBeGreaterThan(0)
        expect(delay).toBeLessThanOrEqual(25 * 3600 * 1000)
      }
    }
  })

  it('computes a daily schedule without walking 86,400 seconds', () => {
    // The old implementation allocated one Date per second up to a 25 h horizon
    // on every re-arm, blocking the event loop. This is a coarse guard: 1000
    // calls must not take anywhere near that long.
    const spec = parseCronExpression('0 0 9 * * *')
    const started = Date.now()
    for (let i = 0; i < 1000; i++) nextRunDelayMs(spec, Date.now())
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('rejects calendar fields loudly rather than running on the wrong schedule', () => {
    expect(() => parseCronExpression('0 0 9 1 * *')).toThrow(/day-of-month/)
    expect(() => parseCronExpression('0 0 9 * * 1')).toThrow(/day-of-month/)
    expect(() => parseCronExpression('0 0 9 * *')).toThrow(/6 fields/)
    expect(() => parseCronExpression('0 0 99 * * *')).toThrow(/hour/)
  })
})
