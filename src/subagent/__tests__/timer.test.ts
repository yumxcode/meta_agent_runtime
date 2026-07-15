import { describe, expect, it } from 'vitest'
import { makeTimerTool, type TimerIntent } from '../tools/timer.js'

describe('timer continuation checkpoint', () => {
  it('captures bounded JSON continuation data with the park intent', async () => {
    let intent: TimerIntent | undefined
    const tool = makeTimerTool(value => { intent = value })
    const call = tool.call as unknown as (input: Record<string, unknown>) => Promise<{ isError?: boolean }>
    const result = await call({
      afterMs: 30 * 60_000,
      reason: 'inspect remote training',
      checkpoint: { taskId: 'TASK-1', phase: 'training', check: 4, metrics: [0.2, 0.3] },
    })
    expect(result.isError).not.toBe(true)
    expect(intent).toEqual({
      afterMs: 30 * 60_000,
      reason: 'inspect remote training',
      checkpoint: { taskId: 'TASK-1', phase: 'training', check: 4, metrics: [0.2, 0.3] },
    })
  })

  it('rejects non-JSON or oversized checkpoints without parking', async () => {
    let calls = 0
    const tool = makeTimerTool(() => { calls++ }, { maxDelayMs: 60_000 })
    const call = tool.call as unknown as (input: Record<string, unknown>) => Promise<{ isError?: boolean }>
    expect((await call({ afterMs: 30_000, reason: 'bad', checkpoint: { fn: () => undefined } })).isError).toBe(true)
    expect((await call({ afterMs: 30_000, reason: 'large', checkpoint: { value: 'x'.repeat(20_000) } })).isError).toBe(true)
    expect((await call({ afterMs: 60_001, reason: 'too late' })).isError).toBe(true)
    expect(calls).toBe(0)
  })
})
