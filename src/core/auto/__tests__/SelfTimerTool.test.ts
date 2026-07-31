import { describe, expect, it } from 'vitest'
import { createSelfTimerTool } from '../SelfTimerTool.js'

describe('self_timer', () => {
  it('directs long remote training waits to durable scheduling', () => {
    const tool = createSelfTimerTool({
      getOutstandingSubAgents: () => ({ runningIds: [], queued: 0 }),
    })
    expect(tool.description).toContain('remote training')
    expect(tool.description).toContain('longer than 1 hour')
    expect(tool.description).toContain('instead of sleep')
    expect(
      (tool.inputSchema.properties?.['afterMs'] as { description?: string })
        .description,
    ).toContain('remote training expected to run longer than 1 hour')
  })

  it('returns a first-class park control request', async () => {
    const tool = createSelfTimerTool({
      getOutstandingSubAgents: () => ({ runningIds: [], queued: 0 }),
    })
    const result = await tool.call(
      {
        afterMs: 2_000,
        reason: 'wait for deployment',
        checkpoint: { deploymentId: 'dep-1' },
      },
      {} as never,
    )
    expect(result.isError).toBe(false)
    expect(result.control).toEqual({
      kind: 'park',
      afterMs: 2_000,
      reason: 'wait for deployment',
      checkpoint: { deploymentId: 'dep-1' },
    })
  })

  it('refuses to park while child work is running or queued', async () => {
    const tool = createSelfTimerTool({
      getOutstandingSubAgents: () => ({ runningIds: ['task-1'], queued: 1 }),
    })
    const result = await tool.call(
      { afterMs: 2_000, reason: 'wait' },
      {} as never,
    )
    expect(result.isError).toBe(true)
    expect(result.control).toBeUndefined()
    expect(result.content).toContain('cannot park')
  })

  it('rejects non-JSON and oversized checkpoints', async () => {
    const tool = createSelfTimerTool({
      getOutstandingSubAgents: () => ({ runningIds: [], queued: 0 }),
    })
    const bad = await tool.call(
      { afterMs: 2_000, reason: 'wait', checkpoint: { fn: () => undefined } },
      {} as never,
    )
    const large = await tool.call(
      { afterMs: 2_000, reason: 'wait', checkpoint: { text: 'x'.repeat(20_000) } },
      {} as never,
    )
    expect(bad.isError).toBe(true)
    expect(large.isError).toBe(true)
  })
})
