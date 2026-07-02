import { describe, it, expect } from 'vitest'
import {
  mergeOverflowNotifications,
  retryBackoffMs,
  shouldRetrySubAgent,
  shouldRetrySubAgentConfig,
} from '../SubAgentBridge.js'

describe('mergeOverflowNotifications', () => {
  it('collapses a batch into one summary preserving the count', () => {
    const merged = mergeOverflowNotifications(['[a] ✓', '[b] ✗', '[c] ✓'])
    expect(merged).toContain('3 条更早的子代理通知已合并')
    expect(merged).toContain('未丢弃')
  })

  it('accumulates the count of a prior merged-summary line (no double loss)', () => {
    const prior = mergeOverflowNotifications(['1', '2', '3']) // count=3
    const merged = mergeOverflowNotifications([prior, 'x', 'y'])  // 3 + 2
    expect(merged).toContain('5 条更早的子代理通知已合并')
  })

  it('truncates long samples', () => {
    const long = 'z'.repeat(500)
    const merged = mergeOverflowNotifications([long])
    expect(merged.length).toBeLessThan(300)
  })
})

describe('retry policy helpers', () => {
  it('shouldRetrySubAgent: only when armed, under limit, limit>0', () => {
    expect(shouldRetrySubAgent(0, 2, true)).toBe(true)
    expect(shouldRetrySubAgent(1, 2, true)).toBe(true)
    expect(shouldRetrySubAgent(2, 2, true)).toBe(false) // exhausted
    expect(shouldRetrySubAgent(0, 2, false)).toBe(false) // not armed
    expect(shouldRetrySubAgent(0, 0, true)).toBe(false) // retries disabled
  })

  it('shouldRetrySubAgentConfig: never bridge-retries auto_orch graph tasks', () => {
    expect(shouldRetrySubAgentConfig({
      autoOrch: {
        resumable: true,
        orchestrationTaskId: 'orch-1',
        nodeId: 'choose_direction',
      },
    }, 0, 2, true)).toBe(false)
    expect(shouldRetrySubAgentConfig({}, 0, 2, true)).toBe(true)
  })

  it('retryBackoffMs grows exponentially and caps at 30s', () => {
    expect(retryBackoffMs(0)).toBe(1000)
    expect(retryBackoffMs(1)).toBe(2000)
    expect(retryBackoffMs(2)).toBe(4000)
    expect(retryBackoffMs(20)).toBe(30_000) // capped
  })
})
