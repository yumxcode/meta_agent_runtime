/**
 * Human-readable local time formatting for loop CLI output.
 *
 * Durable graph timestamps remain UTC-based epoch milliseconds. These helpers
 * only convert them at the terminal presentation boundary and include the
 * local UTC offset on full timestamps so an operator cannot confuse local time
 * with UTC.
 */

type DateInput = Date | number | string

function dateAndOffset(value: DateInput, offsetMinutes?: number): {
  shifted: Date
  offsetMinutes: number
} {
  const date = value instanceof Date ? value : new Date(value)
  const time = date.getTime()
  if (!Number.isFinite(time)) throw new RangeError('invalid date')

  const resolvedOffset = offsetMinutes ?? -date.getTimezoneOffset()
  if (!Number.isFinite(resolvedOffset)) throw new RangeError('invalid timezone offset')
  const wholeOffset = Math.trunc(resolvedOffset)

  return {
    shifted: new Date(time + wholeOffset * 60_000),
    offsetMinutes: wholeOffset,
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function clockFromShifted(date: Date): string {
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
}

/** Format an instant as an HH:mm:ss clock in the machine's local timezone. */
export function formatLocalClock(value: DateInput, offsetMinutes?: number): string {
  return clockFromShifted(dateAndOffset(value, offsetMinutes).shifted)
}

/**
 * Format an instant as ISO-like local time with an explicit UTC offset.
 * Example in Asia/Shanghai: 2026-07-27T13:06:37.709+08:00.
 */
export function formatLocalTimestamp(value: DateInput, offsetMinutes?: number): string {
  const { shifted, offsetMinutes: offset } = dateAndOffset(value, offsetMinutes)
  const sign = offset >= 0 ? '+' : '-'
  const absoluteOffset = Math.abs(offset)
  const offsetHours = Math.floor(absoluteOffset / 60)
  const offsetRemainder = absoluteOffset % 60

  return [
    `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`,
    `T${clockFromShifted(shifted)}.${String(shifted.getUTCMilliseconds()).padStart(3, '0')}`,
    `${sign}${pad2(offsetHours)}:${pad2(offsetRemainder)}`,
  ].join('')
}
