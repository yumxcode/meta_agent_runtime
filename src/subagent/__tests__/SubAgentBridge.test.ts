import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SubAgentRecord, SubAgentTaskId } from '../types.js'

const mockState = vi.hoisted(() => {
  const tasks = new Map<string, SubAgentRecord>()
  const runners: Array<{
    taskId: string
    record: SubAgentRecord
    start: () => Promise<void>
    abort: ReturnType<typeof vi.fn>
    resolve: () => void
  }> = []

  return { tasks, runners }
})

vi.mock('../SubAgentTaskStore.js', () => ({
  readTask: vi.fn(async (taskId: string) => mockState.tasks.get(taskId) ?? null),
  writeTask: vi.fn(async (record: SubAgentRecord) => {
    mockState.tasks.set(record.taskId, { ...record })
  }),
  releaseWriteChain: vi.fn(async () => {}),
  cleanupTerminalTasks: vi.fn(async () => 0),
  listTasksForSession: vi.fn(async (parentSessionId: string) =>
    [...mockState.tasks.values()].filter(record => record.parentSessionId === parentSessionId),
  ),
}))

vi.mock('../SubAgentRunner.js', () => ({
  SubAgentRunner: class {
    private readonly record: SubAgentRecord
    readonly abort = vi.fn()
    private promise: Promise<void> | undefined

    constructor(record: SubAgentRecord) {
      this.record = record
    }

    start(): Promise<void> {
      let resolve!: () => void
      const promise = new Promise<void>(r => { resolve = r })
      this.promise = promise
      mockState.tasks.set(this.record.taskId, {
        ...this.record,
        status: 'running',
        startedAt: Date.now(),
      })
      mockState.runners.push({
        taskId: this.record.taskId,
        record: this.record,
        start: () => promise,
        abort: this.abort,
        resolve,
      })
      return promise
    }

    wait(): Promise<void> {
      return this.promise ?? Promise.resolve()
    }
  },
}))

import { SubAgentBridge } from '../SubAgentBridge.js'

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

function completeTask(taskId: string, costUsd = 0): void {
  const record = mockState.tasks.get(taskId)
  if (!record) throw new Error(`missing task ${taskId}`)
  mockState.tasks.set(taskId, {
    ...record,
    status: 'completed',
    completedAt: Date.now(),
    result: {
      success: true,
      summary: 'done',
      turnsUsed: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd,
      durationMs: 1,
    },
  })
  mockState.runners.find(r => r.taskId === taskId)?.resolve()
}

describe('SubAgentBridge scheduler', () => {
  beforeEach(() => {
    mockState.tasks.clear()
    mockState.runners.length = 0
  })

  afterEach(() => {
    SubAgentBridge.destroyAll()
  })

  it('keeps extra tasks queued until a running slot is released', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 4,
      startDelayMs: 0,
    })

    const first = await bridge.spawnSubAgent({ config: { taskDescription: 'first' } })
    const second = await bridge.spawnSubAgent({ config: { taskDescription: 'second' } })

    await waitFor(() => mockState.runners.length === 1)
    expect(mockState.runners[0]?.taskId).toBe(first.taskId)
    expect((await bridge.getStatus(second.taskId))?.status).toBe('queued')

    completeTask(first.taskId)
    await waitFor(() => mockState.runners.length === 2)
    expect(mockState.runners[1]?.taskId).toBe(second.taskId)
  })

  it('cancels queued tasks without starting them later', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 4,
      startDelayMs: 0,
    })

    const first = await bridge.spawnSubAgent({ config: { taskDescription: 'first' } })
    const second = await bridge.spawnSubAgent({ config: { taskDescription: 'second' } })
    await waitFor(() => mockState.runners.length === 1)

    await expect(bridge.cancelTask(second.taskId, 'not needed')).resolves.toBe(true)
    expect((await bridge.getStatus(second.taskId))?.status).toBe('cancelled')

    completeTask(first.taskId)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(mockState.runners.map(r => r.taskId)).toEqual([first.taskId])
  })

  it('rejects spawns when running plus queued capacity is exhausted', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 1,
      startDelayMs: 0,
    })

    await bridge.spawnSubAgent({ config: { taskDescription: 'first' } })
    await bridge.spawnSubAgent({ config: { taskDescription: 'second' } })

    await expect(
      bridge.spawnSubAgent({ config: { taskDescription: 'third' } }),
    ).rejects.toThrow(/queue is full/)
  })

  it('reserves sub-agent budget before queueing new work', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 4,
      startDelayMs: 0,
      maxTotalSubAgentBudgetUsd: 1,
    })

    await bridge.spawnSubAgent({
      config: { taskDescription: 'first', maxBudgetUsd: 0.7 },
    })

    await expect(
      bridge.spawnSubAgent({
        config: { taskDescription: 'second', maxBudgetUsd: 0.4 },
      }),
    ).rejects.toThrow(/budget exceeded/)
  })
})
