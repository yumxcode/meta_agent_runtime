import { describe, it, expect } from 'vitest'
import { ModeDetector } from '../ModeDetector.js'
import { MODE_WEIGHT } from '../types.js'

// ModeDetector after the 'auto' mode addition + 'detect' sentinel rename.

describe('ModeDetector — explicit hints (sentinel renamed to detect)', () => {
  it('explicit "auto" hint is returned as-is (not treated as auto-detect)', () => {
    const r = ModeDetector.detectSync('refactor this code', 'auto')
    expect(r.mode).toBe('auto')
    expect(r.confidence).toBe('explicit')
  })

  it('explicit "agentic" hint bypasses detection', () => {
    const r = ModeDetector.detectSync('做参数扫描 找 Pareto 前沿', 'agentic')
    expect(r.mode).toBe('agentic')
    expect(r.confidence).toBe('explicit')
  })

  it('"detect" sentinel runs heuristics', () => {
    const r = ModeDetector.detectSync('just answer a question', 'detect')
    expect(r.confidence).not.toBe('explicit')
    expect(r.mode).toBe('agentic') // default fallthrough
  })

  it('default hint is "detect" (runs heuristics, never explicit)', () => {
    const r = ModeDetector.detectSync('hello')
    expect(r.confidence).not.toBe('explicit')
  })
})

describe('ModeDetector — auto is explicit-only (no heuristic inference)', () => {
  // Phrasing that previously triggered an auto heuristic must now NEVER route to
  // auto. Auto mode is entered exclusively via an explicit hint (--mode auto).
  const notAutoPrompts = [
    '请用自动模式帮我重构',
    'run this in auto mode',
    '无人值守地跑完整个流程',
    '全自动执行，不要问我',
    'do it without asking',
  ]
  for (const p of notAutoPrompts) {
    it(`does NOT infer auto from wording: "${p}"`, () => {
      const r = ModeDetector.detectSync(p, 'detect')
      expect(r.mode).not.toBe('auto')
    })
  }

  it('only an explicit hint yields auto', () => {
    expect(ModeDetector.detectSync('refactor this code', 'auto').mode).toBe('auto')
    expect(ModeDetector.detectSync('全自动执行，不要问我', 'detect').mode).not.toBe('auto')
  })

  it('async detect() never returns auto without an explicit hint', async () => {
    const r = await ModeDetector.detect('auto mode please', 'detect')
    expect(r.mode).not.toBe('auto')
  })

  it('still routes a robotics prompt to robotics', () => {
    const r = ModeDetector.detectSync('帮我开发四足机器人的自主导航算法 ROS2', 'detect')
    expect(r.mode).toBe('robotics')
  })
})

describe('MODE_WEIGHT', () => {
  it('auto has equal weight to agentic (sibling flavour, not heavier)', () => {
    expect(MODE_WEIGHT.auto).toBe(MODE_WEIGHT.agentic)
  })

  it('campaign and robotics still outrank auto/agentic', () => {
    expect(MODE_WEIGHT.campaign).toBeGreaterThan(MODE_WEIGHT.auto)
    expect(MODE_WEIGHT.robotics).toBeGreaterThan(MODE_WEIGHT.campaign)
  })
})
