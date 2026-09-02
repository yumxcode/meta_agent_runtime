/**
 * Terminal width is measured in COLUMNS, not code units.
 *
 * The thinking meter used `String.length` against `columns - 1`. A CJK glyph
 * advances the cursor twice but counts once, so a Chinese status line could
 * pass the fit check and still wrap onto a second row — and `hide()` erases
 * exactly one row (`\r\x1b[2K`), leaving the wrapped tail on screen for the
 * next real output to write around. The frame renderer had the right
 * implementation the whole time; it just was not shared.
 */
import { describe, expect, it } from 'vitest'
import { clampWidth, displayWidth, fit, wrapToWidth } from '../textWidth.js'
import { ThinkingMeter } from '../thinkingMeter.js'

describe('displayWidth', () => {
  it('counts CJK as two columns and ASCII as one', () => {
    expect(displayWidth('ab')).toBe(2)
    expect(displayWidth('推理中')).toBe(6)
    expect(displayWidth('推理中 · 4.5s')).toBe(6 + 7)
  })

  it('counts an astral code point once, not twice', () => {
    // '𠀀' is one code point but two UTF-16 code units — `.length` says 2.
    expect('𠀀'.length).toBe(2)
    expect(displayWidth('𠀀')).toBe(2)   // wide, so 2 columns — for the right reason
    expect(displayWidth('😀')).toBe(1)   // outside the wide ranges we claim
  })
})

describe('fit / clampWidth', () => {
  it('never returns something wider than the limit', () => {
    for (const limit of [1, 4, 7, 10, 20]) {
      expect(displayWidth(fit('持续推进X1 AMP训练', limit))).toBeLessThanOrEqual(limit)
      expect(displayWidth(clampWidth('持续推进X1 AMP训练', limit))).toBeLessThanOrEqual(limit)
    }
  })

  it('leaves a string that already fits alone', () => {
    expect(fit('short', 20)).toBe('short')
    expect(clampWidth('short', 20)).toBe('short')
  })

  it('clampWidth spends no column on an ellipsis', () => {
    expect(clampWidth('abcdef', 3)).toBe('abc')
    expect(fit('abcdef', 3)).toBe('ab…')
  })

  it('does not split a wide glyph in half', () => {
    expect(clampWidth('推理中', 3)).toBe('推')   // 4 columns would overflow
  })
})

describe('wrapToWidth', () => {
  it('bounds every produced line', () => {
    for (const line of wrapToWidth('推理中的一段很长的中文文本 with ascii', 8)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(8)
    }
  })
})

describe('ThinkingMeter status line', () => {
  function meterAt(columns: number, chars: number) {
    const out: string[] = []
    const meter = new ThinkingMeter({
      write: s => out.push(s),
      now: () => 1000,
      color: false,
      enabled: true,
      columns: () => columns,
    })
    if (chars > 0) meter.note('思'.repeat(chars))
    return meter
  }

  it('keeps the Chinese status line inside one row on a narrow terminal', () => {
    for (const columns of [10, 16, 20, 24, 30, 40]) {
      const line = meterAt(columns, 400).format().replace('\r\x1b[2K', '')
      expect(
        displayWidth(line),
        `columns=${columns} produced ${JSON.stringify(line)}`,
      ).toBeLessThanOrEqual(columns - 1)
    }
  })

  it('still renders the full coloured line when it fits', () => {
    const line = meterAt(200, 400).format()
    expect(line).toContain('推理中')
    expect(line).toContain('tokens')
  })
})
