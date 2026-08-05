/**
 * Sub-agent slot release when accounting fails.
 *
 * The completion path used to be `.catch(...).finally(async () => …)` — the
 * catch sat BEFORE the finally, so anything thrown inside the async finally
 * escaped as a floating rejection. The CLI registers
 * `process.once('unhandledRejection', … disposeAndExit(1))`, so a throw from an
 * injected cost ledger would terminate the whole session.
 *
 * Worse, the throw happened BEFORE the runner/active maps were cleaned, so the
 * bridge kept believing the seat was occupied and stopped draining the queue —
 * a silent deadlock with no error surfaced anywhere.
 *
 * These tests drive a ledger that throws on settle and assert both properties:
 * no unhandled rejection, and the queue keeps moving.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SubAgentRecord } from '../types.js'

const mockState = vi.hoisted(() => {
  const tasks = new Map<string, SubAgentRecord>()
  const runners: Array<{ taskId: string; resolve: () => void }> = []
  return { tasks, runners }
})

vi.mock('../SubAgentTaskStore.js', () => ({
  readTask: vi.fn(async (taskId: string) => mockState.tasks.get(taskId) ?? null),
  writeTask: vi.fn(async (record: SubAgentRecord) => {
    mockState.tasks.set(record.taskId, { ...record })
  }),
  mutateTask: vi.fn(async (taskId: string, mutate: (c: SubAgentRecord | null) => SubAgentRecord | null) => {
    const next = mutate(mockState.tasks.get(taskId) ?? null)
    if (next !== null) mockState.tasks.set(taskId, { ...next })
    return next
  }),
  releaseWriteChain: vi.fn(async () => {}),
  cleanupTerminalTasks: vi.fn(async () => 0),
  listTasksForSession: vi.fn(async (parentSessionId: string) =>
    [...mockState.tasks.values()].filter(r => r.parentSessionId === parentSessionId),
  ),
}))

vi.mock('../SubAgentRunner.js', () => ({
  SubAgentRunner: class {
    private readonly record: SubAgentRecord
    readonly abort = vi.fn()
    private promise: Promise<void> | undefined
    constructor(record: SubAgentRecord) { this.record = record }
    start(): Promise<void> {
      let resolve!: () => void
      const promise = new Promise<void>(r => { resolve = r })
      this.promise = promise
      mockState.tasks.set(this.record.taskId, { ...this.record, status: 'running', startedAt: Date.now() })
      mockState.runners.push({ taskId: this.record.taskId, resolve })
      return promise
    }
    wait(): Promise<void> { return this.promise ?? Promise.resolve() }
  },
}))

import { SubAgentBridge } from '../SubAgentBridge.js'

function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = (): void => {
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
      success: true, summary: 'done', turnsUsed: 1,
      inputTokens: 1, outputTokens: 1, costUsd, durationMs: 1,
    },
  })
  mockState.runners.find(r => r.taskId === taskId)?.resolve()
}

/** A ledger whose settleTask always throws — stands in for any injected accounting hook. */
function explodingLedger(): { tryReserveTask: () => boolean; settleTask: () => never; releaseTaskReservation: () => void; getBreakdown: () => unknown } {
  return {
    tryReserveTask: () => true,
    settleTask: () => { throw new Error('ledger exploded during settle') },
    releaseTaskReservation: () => {},
    getBreakdown: () => ({ committedCostUsd: 0, budgetUsd: 1 }),
  }
}

describe('slot release when settle accounting throws', () => {
  const rejections: unknown[] = []
  const onRejection = (err: unknown): void => { rejections.push(err) }

  beforeEach(() => {
    mockState.tasks.clear()
    mockState.runners.length = 0
    rejections.length = 0
    process.on('unhandledRejection', onRejection)
  })

  afterEach(() => {
    process.off('unhandledRejection', onRejection)
    SubAgentBridge.destroyAll()
  })

  it('a throwing ledger does not produce an unhandled rejection', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 4,
      startDelayMs: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      costLedger: explodingLedger() as any,
    })

    const first = await bridge.spawnSubAgent({ config: { taskDescription: 'first' } })
    await waitFor(() => mockState.runners.length === 1)
    completeTask(first.taskId)

    // Give the completion chain (and any floating rejection) time to settle.
    await new Promise(r => setTimeout(r, 60))
    expect(rejections).toEqual([])
    await bridge.dispose()
  })

  it('the concurrency slot is still released, so the queue keeps draining', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 4,
      startDelayMs: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      costLedger: explodingLedger() as any,
    })

    const first = await bridge.spawnSubAgent({ config: { taskDescription: 'first' } })
    const second = await bridge.spawnSubAgent({ config: { taskDescription: 'second' } })

    await waitFor(() => mockState.runners.length === 1)
    expect((await bridge.getStatus(second.taskId))?.status).toBe('queued')

    completeTask(first.taskId)

    // The whole point: settle throws, but the seat must free up and the queued
    // task must start. Before the fix this hung forever.
    await waitFor(() => mockState.runners.length === 2)
    expect(mockState.runners[1]?.taskId).toBe(second.taskId)
    // Let the second task finish too, otherwise dispose() legitimately blocks
    // waiting on a runner that never settles.
    completeTask(second.taskId)
    await bridge.dispose()
  })

  it('several consecutive settle failures never wedge the scheduler', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 8,
      startDelayMs: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      costLedger: explodingLedger() as any,
    })

    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const rec = await bridge.spawnSubAgent({ config: { taskDescription: `task-${i}` } })
      ids.push(rec.taskId)
    }

    for (let i = 0; i < 4; i++) {
      await waitFor(() => mockState.runners.length === i + 1)
      completeTask(mockState.runners[i]!.taskId)
    }

    await waitFor(() => mockState.runners.length === 4)
    expect(mockState.runners.map(r => r.taskId)).toEqual(ids)
    expect(rejections).toEqual([])
    await bridge.dispose()
  })
})
