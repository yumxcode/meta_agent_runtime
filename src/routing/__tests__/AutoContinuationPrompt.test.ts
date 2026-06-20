import { describe, it, expect } from 'vitest'
import { isAutoContinuationPrompt } from '../SessionRouter.js'

/**
 * Guards the resume goal-anchoring decision: on --resume, a real new requirement
 * must become the goal, while a short "continue" signal keeps the prior goal.
 */
describe('isAutoContinuationPrompt', () => {
  it('treats empty / whitespace as continuation', () => {
    expect(isAutoContinuationPrompt('')).toBe(true)
    expect(isAutoContinuationPrompt('   ')).toBe(true)
  })

  it('treats short continue markers as continuation (zh + en)', () => {
    for (const p of ['继续', '接着做', '继续推进', 'continue', 'go on', 'KEEP GOING', 'proceed']) {
      expect(isAutoContinuationPrompt(p)).toBe(true)
    }
  })

  it('treats a real new requirement as a NEW goal (not continuation)', () => {
    for (const p of [
      '帮我把登录模块重构成基于 JWT 的鉴权',
      'now build a CSV exporter for the reports page',
      '继续推进登录重构并补充单元测试覆盖到 90% 以上的核心路径', // long → real goal, not a bare marker
    ]) {
      expect(isAutoContinuationPrompt(p)).toBe(false)
    }
  })

  it('does not misclassify a long prompt that merely starts with a marker', () => {
    const longStartsWithMarker = 'continue ' + 'x'.repeat(40)
    expect(isAutoContinuationPrompt(longStartsWithMarker)).toBe(false)
  })
})
