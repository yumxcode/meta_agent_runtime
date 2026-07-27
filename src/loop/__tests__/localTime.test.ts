import { describe, expect, it } from 'vitest'
import { formatLocalClock, formatLocalTimestamp } from '../localTime.js'

describe('loop local time formatting', () => {
  const utcInstant = '2026-07-27T05:06:37.709Z'

  it('renders the terminal clock in the requested local offset', () => {
    expect(formatLocalClock(utcInstant, 8 * 60)).toBe('13:06:37')
  })

  it('renders a full local timestamp with an explicit positive offset', () => {
    expect(formatLocalTimestamp(utcInstant, 8 * 60))
      .toBe('2026-07-27T13:06:37.709+08:00')
  })

  it('handles negative offsets across a date boundary', () => {
    expect(formatLocalTimestamp(utcInstant, -(5 * 60 + 30)))
      .toBe('2026-07-26T23:36:37.709-05:30')
  })

  it('defaults to the machine timezone used by the CLI process', () => {
    const date = new Date(utcInstant)
    const machineOffset = -date.getTimezoneOffset()
    expect(formatLocalTimestamp(date)).toBe(formatLocalTimestamp(date, machineOffset))
    expect(formatLocalClock(date)).toBe(formatLocalClock(date, machineOffset))
  })

  it('rejects invalid dates', () => {
    expect(() => formatLocalTimestamp('not-a-date')).toThrow(RangeError)
  })
})
