/**
 * Regression tests for Chinese support in the heuristic fallback.
 *
 * The fallback fires when the flash side-call is slow/unavailable. It used to be
 * English-only: whitespace tokenization collapsed a spaceless Chinese query into
 * one noise token, and the keyword/domain/intent tables had no Chinese entries.
 * These tests force the heuristic path (flash returns null) and assert a Chinese
 * query still yields sensible domains, intent, and substring-matchable keywords.
 */

import { describe, it, expect } from 'vitest'
import { QueryAnalyzer } from '../QueryAnalyzer.js'
import type { FlashClient } from '../../core/flash/FlashClient.js'

/** Flash stub that always returns null → analyze() uses the heuristic fallback. */
function heuristicOnly(): QueryAnalyzer {
  const flash = { query: async () => null } as unknown as FlashClient
  return new QueryAnalyzer(flash)
}

describe('QueryAnalyzer heuristic — Chinese', () => {
  it('detects locomotion domain and debug intent from a Chinese gait query', async () => {
    const intent = await heuristicOnly().analyze('调试一下 go2 的步态，为什么会摔倒')

    expect(intent.domains).toContain('locomotion')
    expect(intent.intent).toBe('debug')
    // CJK 2-gram for 步态 plus the latin acronym go2 must both survive.
    expect(intent.searchKeywords).toContain('步态')
    expect(intent.searchKeywords).toContain('go2')
  })

  it('flags hardware + deploy intent from a Chinese deployment query', async () => {
    const intent = await heuristicOnly().analyze('把训练好的策略部署到真机上运行')

    expect(intent.hasHardware).toBe(true)
    expect(intent.intent).toBe('deploy')
    expect(intent.domains).toContain('deployment')
  })

  it('detects calibration domain/intent and keeps both CJK and latin keywords', async () => {
    const intent = await heuristicOnly().analyze('标定 imu 的偏置参数')

    expect(intent.domains).toContain('calibration')
    expect(intent.intent).toBe('calibrate')
    expect(intent.searchKeywords).toContain('标定')
    expect(intent.searchKeywords).toContain('imu')
  })

  it('detects simulation cues in Chinese', async () => {
    const intent = await heuristicOnly().analyze('在仿真里先验证一下抓取流程')

    expect(intent.hasSimulation).toBe(true)
    expect(intent.domains).toContain('manipulation')   // 抓取
  })

  it('still produces usable keywords for a domain-less Chinese query (no collapse)', async () => {
    const intent = await heuristicOnly().analyze('这个流程接下来该怎么安排')

    // Falls back to 'general' domain, but keywords must NOT be the whole sentence
    // as one token — CJK bigrams should be emitted instead.
    expect(intent.domains).toContain('general')
    expect(intent.searchKeywords.length).toBeGreaterThan(0)
    expect(intent.searchKeywords.every(k => k.length <= 3)).toBe(true)
  })

  it('does not regress English queries', async () => {
    const intent = await heuristicOnly().analyze('debug the slam drift on the robot')

    expect(intent.intent).toBe('debug')
    expect(intent.domains).toContain('perception')     // slam
    expect(intent.searchKeywords).toContain('slam')
  })
})
