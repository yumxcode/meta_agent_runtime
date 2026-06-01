import { describe, it, expect } from 'vitest'
import { ThinkingMeter, estimateThinkingTokens } from '../thinkingMeter.js'

describe('estimateThinkingTokens', () => {
  it('returns 0 for no characters', () => {
    expect(estimateThinkingTokens(0)).toBe(0)
    expect(estimateThinkingTokens(-5)).toBe(0)
  })

  it('estimates ~1 token per 3.2 chars, min 1', () => {
    expect(estimateThinkingTokens(1)).toBe(1)
    expect(estimateThinkingTokens(32)).toBe(10)
    expect(estimateThinkingTokens(320)).toBe(100)
  })
})

describe('ThinkingMeter', () => {
  function harness(now = { t: 1000 }) {
    const out: string[] = []
    const meter = new ThinkingMeter({
      write: s => out.push(s),
      now: () => now.t,
      color: false,
      enabled: true,
    })
    return { meter, out, now }
  }

  it('shows a waiting label before any reasoning text', () => {
    const { meter, out } = harness()
    meter.show()
    expect(out.join('')).toContain('等待模型响应…')
  })

  it('switches to a token count once reasoning text accumulates', () => {
    const { meter, out } = harness()
    meter.show()
    meter.note('x'.repeat(32)) // ~10 tokens
    const last = out[out.length - 1]!
    expect(last).toContain('推理中')
    expect(last).toContain('~10 tokens')
  })

  it('reports accumulated char count and token estimate', () => {
    const { meter } = harness()
    meter.note('abcd')
    meter.note('efgh')
    expect(meter.charCount).toBe(8)
    expect(meter.tokenEstimate).toBe(estimateThinkingTokens(8))
  })

  it('renders elapsed seconds from the injected clock', () => {
    const now = { t: 1000 }
    const { meter, out } = harness(now)
    meter.show()
    now.t = 3500 // +2.5s
    meter.tick()
    expect(out[out.length - 1]!).toContain('2.5s')
  })

  it('hide() emits a clear-line sequence and stops rendering', () => {
    const { meter, out } = harness()
    meter.show()
    out.length = 0
    meter.hide()
    expect(out.join('')).toContain('\r\x1b[2K')
    // A tick after hide must not draw anything.
    out.length = 0
    meter.tick()
    expect(out).toEqual([])
  })

  it('is a no-op when disabled', () => {
    const out: string[] = []
    const meter = new ThinkingMeter({ write: s => out.push(s), enabled: false })
    meter.show()
    meter.note('lots of thinking text')
    meter.tick()
    meter.hide()
    expect(out).toEqual([])
  })
})
