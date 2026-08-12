/**
 * Regression tests for the SubAgentBridge admission path.
 *
 * These lock in the H1 fix: the queue cap and the bridge-level total budget
 * were check-then-act — read from in-memory counters, then `await` (worktree
 * allocation, task-record write), then update those counters.
 * `spawn_sub_agent` declares `isConcurrencySafe: true`, so ToolOrchestration
 * dispatches a whole batch of them through one `Promise.all`; every call in
 * that batch read the pre-claim state and every one was admitted.
 *
 * Both fan-out cases below were verified to FAIL against the pre-fix code
 * (8 admitted against a cap of 2; 6 admitted against a $1.00 ceiling).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SubAgentRecord } from '../types.js'

const mockState = vi.hoisted(() => {
  const tasks = new Map<string, SubAgentRecord>()
  const runners: Array<{ taskId: string; resolve: () => void }> = []
  return { tasks, runners }
})

vi.mock('../SubAgentTaskStore.js', () => ({
  readTask: vi.fn(async (taskId: string) => {
    const snapshot = mockState.tasks.get(taskId)
    return snapshot ? { ...snapshot } : null
  }),
  writeTask: vi.fn(async (record: SubAgentRecord) => {
    mockState.tasks.set(record.taskId, { ...record })
  }),
  mutateTask: vi.fn(
    async (taskId: string, mutate: (current: SubAgentRecord | null) => SubAgentRecord | null) => {
      const next = mutate(mockState.tasks.get(taskId) ?? null)
      if (next !== null) mockState.tasks.set(taskId, { ...next })
      return next
    },
  ),
  releaseWriteChain: vi.fn(async () => {}),
  cleanupTerminalTasks: vi.fn(async () => 0),
  listTasksForSession: vi.fn(async (parentSessionId: string) =>
    [...mockState.tasks.values()].filter(r => r.parentSessionId === parentSessionId),
  ),
}))

vi.mock('../SubAgentRunner.js', () => ({
  SubAgentRunner: class {
    private readonly record: SubAgentRecord
    private promise: Promise<void> | undefined
    readonly abort = vi.fn()

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
      mockState.runners.push({ taskId: this.record.taskId, resolve })
      return promise
    }

    wait(): Promise<void> {
      return this.promise ?? Promise.resolve()
    }
  },
}))

import { SubAgentBridge, SubAgentBudgetExceededError } from '../SubAgentBridge.js'

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
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

/** Drive a task to `completed` with a real cost and release its runner. */
function completeTask(taskId: string, costUsd: number): void {
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

describe('SubAgentBridge admission is atomic under a concurrent fan-out', () => {
  beforeEach(() => {
    mockState.tasks.clear()
    mockState.runners.length = 0
  })

  afterEach(() => {
    SubAgentBridge.destroyAll()
  })

  it('never admits more than maxConcurrent + maxQueued when spawns race', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 1,
      startDelayMs: 0,
    })

    // 8 spawns issued in ONE Promise.all — exactly what a model fan-out through
    // ToolOrchestration's parallel batch produces. Cap is 1 + 1 = 2.
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        bridge.spawnSubAgent({ config: { taskDescription: `task ${i}` } }),
      ),
    )

    const admitted = settled.filter(r => r.status === 'fulfilled')
    const rejected = settled.filter(r => r.status === 'rejected')

    expect(admitted).toHaveLength(2)
    expect(rejected).toHaveLength(6)
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason.message).toContain('queue is full')
    }

    const stats = bridge.getSchedulerStats()
    expect(stats.queued + stats.running).toBeLessThanOrEqual(2)
  })

  it('never over-reserves the bridge total budget when spawns race', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      // Room for the queue, so the budget is the ONLY binding constraint.
      maxConcurrentSubAgents: 10,
      maxQueuedSubAgents: 10,
      maxTotalSubAgentBudgetUsd: 1,
      startDelayMs: 0,
    })

    // Six concurrent requests of $0.25 against a $1.00 ceiling → at most four.
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        bridge.spawnSubAgent({
          config: { taskDescription: `task ${i}`, maxBudgetUsd: 0.25 },
        }),
      ),
    )

    const admitted = settled.filter(r => r.status === 'fulfilled')
    expect(admitted).toHaveLength(4)
    for (const r of settled.filter(x => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SubAgentBudgetExceededError)
    }
  })

  it('releases the reserved seat and budget when a racing spawn fails', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 1,
      maxTotalSubAgentBudgetUsd: 1,
      startDelayMs: 0,
    })

    // isolated_write without a coordinator fails AFTER the synchronous
    // admission claim — the rollback must hand the seat and budget back.
    await expect(
      bridge.spawnSubAgent({
        config: {
          taskDescription: 'needs a worktree',
          workspaceMode: 'isolated_write',
          maxBudgetUsd: 0.9,
        },
      }),
    ).rejects.toThrow(/worktree coordinator|git workspace/)

    // If the failed spawn had leaked its claim, this $0.9 request would be
    // rejected as "budget exceeded" and the queue would look full.
    const ok = await bridge.spawnSubAgent({
      config: { taskDescription: 'after the failure', maxBudgetUsd: 0.9 },
    })
    expect(ok.status).toBe('queued')
  })
})

/**
 * Settlement accounting.
 *
 * NOTE on scope: the review that prompted these tests claimed _settleBudget
 * could double-count a task's cost. Tracing every interleaving shows it cannot
 * today — cancelTask returns early whenever `runners` holds the task, so the
 * only path that settles twice is the drain/cancel window, and there both
 * callers read the same zero-cost `cancelled` tombstone. The idempotency gate
 * is kept as hardening (and to state the invariant where the accounting lives),
 * but it is deliberately NOT asserted here via a fake double-settle that no
 * caller can actually produce. These tests cover what IS reachable: a settle
 * frees exactly the reservation it took, on both the cancel and the complete
 * path.
 */
describe('SubAgentBridge settlement accounting', () => {
  beforeEach(() => {
    mockState.tasks.clear()
    mockState.runners.length = 0
  })

  afterEach(() => {
    SubAgentBridge.destroyAll()
  })

  it('returns a cancelled queued task\'s reservation to the budget', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 4,
      maxTotalSubAgentBudgetUsd: 1,
      startDelayMs: 0,
    })

    // Occupy the single running slot so the second task stays queued.
    const running = await bridge.spawnSubAgent({
      config: { taskDescription: 'occupies the slot', maxBudgetUsd: 0.1 },
    })
    await waitFor(() => mockState.runners.length === 1)

    const queued = await bridge.spawnSubAgent({
      config: { taskDescription: 'cancelled before start', maxBudgetUsd: 0.8 },
    })
    expect((await bridge.getStatus(queued.taskId))?.status).toBe('queued')

    // $0.80 is reserved — not enough headroom left for another $0.8 task.
    await expect(
      bridge.spawnSubAgent({ config: { taskDescription: 'too big', maxBudgetUsd: 0.8 } }),
    ).rejects.toBeInstanceOf(SubAgentBudgetExceededError)

    // Cancelling releases the reservation (cost 0), so the same request now fits.
    expect(await bridge.cancelTask(queued.taskId, 'no longer needed')).toBe(true)
    const replacement = await bridge.spawnSubAgent({
      config: { taskDescription: 'fits again', maxBudgetUsd: 0.8 },
    })
    expect(replacement.status).toBe('queued')
    completeTask(running.taskId, 0.1)
  })

  it('charges a completed task its actual cost, not its reservation', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 4,
      maxTotalSubAgentBudgetUsd: 1,
      startDelayMs: 0,
    })

    const task = await bridge.spawnSubAgent({
      config: { taskDescription: 'cheap in practice', maxBudgetUsd: 0.9 },
    })
    await waitFor(() => mockState.runners.length === 1)

    completeTask(task.taskId, 0.2)
    await waitFor(() => bridge.getSchedulerStats().running === 0)

    // $0.90 was reserved but only $0.20 spent; the unused $0.70 must come back.
    const next = await bridge.spawnSubAgent({
      config: { taskDescription: 'uses the freed headroom', maxBudgetUsd: 0.75 },
    })
    expect(next.status).toBe('queued')
  })
})
