import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SubAgentRecord, SubAgentTaskId } from '../types.js'
import type { MetaAgentTool } from '../../core/types.js'
import { DEFAULT_SUB_AGENT_POOL_BUDGET_USD } from '../../infra/budgets.js'

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
  mutateTask: vi.fn(
    async (
      taskId: string,
      mutate: (current: SubAgentRecord | null) => SubAgentRecord | null,
    ) => {
      const next = mutate(mockState.tasks.get(taskId) ?? null)
      if (next !== null) mockState.tasks.set(taskId, { ...next })
      return next
    },
  ),
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
import { CampaignEventBus } from '../CampaignEventBus.js'
import { AutoWorktreeCoordinator } from '../../core/auto/AutoWorktreeCoordinator.js'
import { AutoCostLedger } from '../../core/auto/AutoCostLedger.js'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  writeFileSync(join(dir, 'README.md'), 'base\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'init'])
}

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

function finishCancelledTask(taskId: string, costUsd = 0): void {
  const record = mockState.tasks.get(taskId)
  if (!record) throw new Error(`missing task ${taskId}`)
  mockState.tasks.set(taskId, {
    ...record,
    status: 'cancelled',
    completedAt: Date.now(),
    result: {
      success: false,
      summary: 'cancelled',
      error: 'cancelled',
      turnsUsed: 0,
      inputTokens: 1,
      outputTokens: 0,
      costUsd,
      durationMs: 1,
    },
  })
  mockState.runners.find(r => r.taskId === taskId)?.resolve()
}

function tool(name: string, category?: MetaAgentTool['permission']['category']): MetaAgentTool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    permission: category ? { category } : undefined,
    call: async () => ({ content: 'ok' }),
  }
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

  it('serializes tasks that share a persistent lineage while using other slots', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 3,
      maxQueuedSubAgents: 4,
      startDelayMs: 0,
    })

    const first = await bridge.spawnSubAgent({
      config: { taskDescription: 'lane first', lineageSessionId: 'lane-a' },
    })
    const second = await bridge.spawnSubAgent({
      config: { taskDescription: 'lane second', lineageSessionId: 'lane-a' },
    })
    const independent = await bridge.spawnSubAgent({
      config: { taskDescription: 'other lane', lineageSessionId: 'lane-b' },
    })

    await waitFor(() => mockState.runners.length === 2)
    expect(mockState.runners.map(r => r.taskId)).toEqual([first.taskId, independent.taskId])
    expect((await bridge.getStatus(second.taskId))?.status).toBe('queued')

    completeTask(first.taskId)
    await waitFor(() => mockState.runners.some(r => r.taskId === second.taskId))
  })

  it('assigns a stable logical task family id at spawn', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), { startDelayMs: 0 })
    const task = await bridge.spawnSubAgent({ config: { taskDescription: 'family root' } })
    expect(task.config.logicalTaskId).toBe(task.taskId)
  })

  it('keeps a cancelled running lineage fenced until the runner settles', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 2,
      maxQueuedSubAgents: 2,
      startDelayMs: 0,
    })
    const first = await bridge.spawnSubAgent({
      config: { taskDescription: 'first', lineageSessionId: 'lane-cancel' },
    })
    const second = await bridge.spawnSubAgent({
      config: { taskDescription: 'second', lineageSessionId: 'lane-cancel' },
    })
    await waitFor(() => mockState.runners.length === 1)

    await expect(bridge.cancelTask(first.taskId, 'replace')).resolves.toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await bridge.getStatus(second.taskId))?.status).toBe('queued')

    finishCancelledTask(first.taskId, 0.01)
    await waitFor(() => mockState.runners.some(r => r.taskId === second.taskId))
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

  it('waitForTerminal resolves when a running task finishes', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 4,
      startDelayMs: 0,
    })

    const task = await bridge.spawnSubAgent({ config: { taskDescription: 'wait' } })
    await waitFor(() => mockState.runners.length === 1)

    const done = bridge.waitForTerminal(task.taskId, { timeoutMs: 1000 })
    completeTask(task.taskId, 0.03)

    await expect(done).resolves.toMatchObject({
      taskId: task.taskId,
      status: 'completed',
      result: { costUsd: 0.03 },
    })
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

  it('caps the sub-agent pool at the shared ladder value', async () => {
    // Expressed relative to the ladder rather than a literal: the numbers move
    // as a group (infra/budgets.ts) and a hard-coded $10 here just re-breaks
    // every time they do. What must hold is the BEHAVIOUR — the pool total is
    // enforced, and the error names the ceiling.
    const pool = DEFAULT_SUB_AGENT_POOL_BUDGET_USD
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      conservativeAutoDefaults: true,
      startDelayMs: 0,
    })

    const almostAll = pool * 0.6
    await expect(
      bridge.spawnSubAgent({ config: { taskDescription: 'expensive research', maxBudgetUsd: almostAll } }),
    ).resolves.toMatchObject({ config: { maxBudgetUsd: almostAll } })

    await expect(
      bridge.spawnSubAgent({ config: { taskDescription: 'too much', maxBudgetUsd: pool * 0.5 } }),
    ).rejects.toThrow(new RegExp(`limit \\$${pool.toFixed(4)}`))
  })

  it('keeps conservative auto scheduling without a default total cap when a durable caller owns budget', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      conservativeAutoDefaults: true,
      budgetManagedExternally: true,
      startDelayMs: 0,
    })

    await expect(
      bridge.spawnSubAgent({ config: { taskDescription: 'graph segment', maxBudgetUsd: 15 } }),
    ).resolves.toMatchObject({ config: { maxBudgetUsd: 15 } })
  })

  it('internal safety-gate tasks bypass the shared budget cap', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 4,
      startDelayMs: 0,
      maxTotalSubAgentBudgetUsd: 1,
    })
    // Consume almost the whole cap with a normal (research-style) task.
    await bridge.spawnSubAgent({ config: { taskDescription: 'research', maxBudgetUsd: 0.9 } })
    // A second normal task over the cap is rejected...
    await expect(
      bridge.spawnSubAgent({ config: { taskDescription: 'more research', maxBudgetUsd: 0.5 } }),
    ).rejects.toThrow(/budget exceeded/)
    // ...but an internal safety-gate task (verify/drift) still spawns — the
    // completion gate must never be silently disabled by research spend.
    const gate = await bridge.spawnSubAgent({
      config: { taskDescription: 'verify', maxBudgetUsd: 0.5, internal: true },
    })
    expect(gate.taskId).toBeTruthy()
  })

  it('keeps internal safety-gate tasks inside the whole auto-session budget', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 4,
      startDelayMs: 0,
      maxTotalSubAgentBudgetUsd: 1,
      costLedger: new AutoCostLedger(1),
    })

    // The local bridge cap reserves capacity for a gate, but the outer ledger
    // includes every child role so an auto run cannot overspend its session cap.
    await bridge.spawnSubAgent({
      config: { taskDescription: 'research', maxBudgetUsd: 0.9 },
    })
    await expect(
      bridge.spawnSubAgent({
        config: { taskDescription: 'verify', maxBudgetUsd: 0.5, internal: true },
      }),
    ).rejects.toThrow(/Auto session budget exceeded/)
  })

  it('internal safety-gate tasks bypass the queue-full cap', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 1,
      startDelayMs: 0,
    })
    await bridge.spawnSubAgent({ config: { taskDescription: 'first' } })
    await bridge.spawnSubAgent({ config: { taskDescription: 'second' } })
    // Normal task is rejected once running+queued capacity is exhausted...
    await expect(
      bridge.spawnSubAgent({ config: { taskDescription: 'third' } }),
    ).rejects.toThrow(/queue is full/)
    // ...but an internal gate task jumps the queue and is accepted.
    const gate = await bridge.spawnSubAgent({
      config: { taskDescription: 'verify', internal: true },
    })
    expect(gate.taskId).toBeTruthy()
  })

  it('removes write tools from shared_readonly sub-agents', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      maxConcurrentSubAgents: 1,
      maxQueuedSubAgents: 4,
      startDelayMs: 0,
    })
    bridge.setToolRegistry(new Map([
      ['read_file', tool('read_file', 'read')],
      ['write_file', tool('write_file', 'write')],
      ['edit_file', tool('edit_file', 'write')],
      ['experience_write', tool('experience_write')],
      ['custom_mutator', tool('custom_mutator', 'write')],
    ]))

    const record = await bridge.spawnSubAgent({
      config: {
        taskDescription: 'inspect only',
        workspaceMode: 'shared_readonly',
        allowedTools: [
          'read_file',
          'write_file',
          'edit_file',
          'experience_write',
          'custom_mutator',
        ],
      },
    })

    expect(record.config.allowedTools).toEqual(['read_file', 'experience_write'])
    expect(record.config.sandbox).toMatchObject({
      readonlyWorkspace: true,
      writeAllowPaths: [],
      allowUnsandboxedFallback: false,
    })
  })

  it('does not expose task records owned by another parent session', async () => {
    const owner = new SubAgentBridge(`owner-${crypto.randomUUID()}`, { startDelayMs: 60_000 })
    const foreign = new SubAgentBridge(`foreign-${crypto.randomUUID()}`, { startDelayMs: 60_000 })
    const task = await owner.spawnSubAgent({ config: { taskDescription: 'private result' } })

    expect(await owner.getStatus(task.taskId)).not.toBeNull()
    expect((await owner.lookupStatus(task.taskId)).kind).toBe('owned')
    expect((await foreign.lookupStatus(task.taskId)).kind).toBe('foreign')
    expect(await foreign.getStatus(task.taskId)).toBeNull()
    expect((await foreign.lookupStatus('subtask-missing' as SubAgentTaskId)).kind).toBe('not_found')
  })
})

describe('SubAgentBridge isolated-write contract', () => {
  it('fails closed when isolated_write is requested without a git coordinator', async () => {
    const bridge = new SubAgentBridge(`isolated-${crypto.randomUUID()}`)
    bridge.setToolRegistry(new Map([['write_file', tool('write_file', 'write')]]))
    try {
      await expect(bridge.spawnSubAgent({
        config: {
          taskDescription: 'write code',
          workspaceMode: 'isolated_write',
          allowedTools: ['write_file'],
        },
      })).rejects.toThrow(/requires an auto-mode git worktree coordinator/)
    } finally {
      await bridge.dispose()
    }
  })

  it('automatically finalizes an isolated worktree on completion', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'bridge-isolated-'))
    initRepo(repo)
    const sessionId = `isolated-${crypto.randomUUID()}`
    const bridge = new SubAgentBridge(sessionId, { startDelayMs: 0 })
    const coordinator = new AutoWorktreeCoordinator(repo)
    bridge.setWorktreeCoordinator(coordinator)
    bridge.setToolRegistry(new Map([['write_file', tool('write_file', 'write')]]))
    try {
      const task = await bridge.spawnSubAgent({
        config: {
          taskDescription: 'write code',
          workspaceMode: 'isolated_write',
          allowedTools: ['write_file'],
        },
      })
      await waitFor(() => mockState.runners.some(r => r.taskId === task.taskId))
      const record = mockState.tasks.get(task.taskId)!
      writeFileSync(join(record.config.projectDir!, 'feature.txt'), 'done\n')
      completeTask(task.taskId)
      const completed = mockState.tasks.get(task.taskId)!.result!
      CampaignEventBus.emit('subagent:completed', {
        taskId: task.taskId,
        parentSessionId: sessionId,
        result: completed,
      })

      await waitFor(() =>
        coordinator.recordFor(task.taskId)?.phase === 'awaiting_merge',
      )
      expect(coordinator.recordFor(task.taskId)?.finalizedCommit).toBeTruthy()
      expect(git(record.config.projectDir!, ['status', '--porcelain'])).toBe('')
      let notifications = ''
      await waitFor(() => {
        notifications += bridge.drainNotifications().join('\n')
        return notifications.includes('等待 auto_merge_subagent')
      })
      expect(mockState.tasks.get(task.taskId)?.result?.integration).toMatchObject({
        mergeRequired: true,
        status: 'committed',
      })
    } finally {
      await bridge.dispose()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it.each([
    ['omitted', undefined],
    ['empty', []],
  ] as const)('rejects isolated_write when allowed_tools is %s', async (_label, allowedTools) => {
    const repo = mkdtempSync(join(tmpdir(), 'bridge-isolated-empty-'))
    initRepo(repo)
    const bridge = new SubAgentBridge(`isolated-${crypto.randomUUID()}`)
    bridge.setWorktreeCoordinator(new AutoWorktreeCoordinator(repo))
    try {
      await expect(bridge.spawnSubAgent({
        config: {
          taskDescription: 'write code',
          workspaceMode: 'isolated_write',
          allowedTools,
        },
      })).rejects.toThrow(/requires at least one resolved workspace mutation tool/)
    } finally {
      await bridge.dispose()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('rejects isolated_write when requested tools resolve but are read-only', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'bridge-isolated-readonly-'))
    initRepo(repo)
    const bridge = new SubAgentBridge(`isolated-${crypto.randomUUID()}`)
    bridge.setWorktreeCoordinator(new AutoWorktreeCoordinator(repo))
    bridge.setToolRegistry(new Map([['read_file', tool('read_file', 'read')]]))
    try {
      await expect(bridge.spawnSubAgent({
        config: {
          taskDescription: 'write code',
          workspaceMode: 'isolated_write',
          allowedTools: ['read_file'],
        },
      })).rejects.toThrow(/requires at least one resolved workspace mutation tool/)
    } finally {
      await bridge.dispose()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('marks an unchanged worktree merge_required=false and reclaims it', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'bridge-isolated-nochange-'))
    initRepo(repo)
    const sessionId = `isolated-${crypto.randomUUID()}`
    const bridge = new SubAgentBridge(sessionId, { startDelayMs: 0 })
    const coordinator = new AutoWorktreeCoordinator(repo)
    bridge.setWorktreeCoordinator(coordinator)
    bridge.setToolRegistry(new Map([['write_file', tool('write_file', 'write')]]))
    try {
      const task = await bridge.spawnSubAgent({
        config: {
          taskDescription: 'write code',
          workspaceMode: 'isolated_write',
          allowedTools: ['write_file'],
        },
      })
      await waitFor(() => mockState.runners.some(r => r.taskId === task.taskId))
      const worktree = mockState.tasks.get(task.taskId)!.config.projectDir!
      completeTask(task.taskId)
      const completed = mockState.tasks.get(task.taskId)!.result!
      CampaignEventBus.emit('subagent:completed', {
        taskId: task.taskId,
        parentSessionId: sessionId,
        result: completed,
      })
      await waitFor(() => mockState.tasks.get(task.taskId)?.result?.integration !== undefined)
      expect(mockState.tasks.get(task.taskId)?.result?.integration).toMatchObject({
        status: 'no_changes',
        mergeRequired: false,
      })
      expect(coordinator.activeTasks()).not.toContain(task.taskId)
      expect(existsSync(worktree)).toBe(false)
    } finally {
      await bridge.dispose()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('allows shared_readonly without tools for pure reasoning', async () => {
    const bridge = new SubAgentBridge(`readonly-${crypto.randomUUID()}`, { startDelayMs: 0 })
    try {
      const record = await bridge.spawnSubAgent({
        config: {
          taskDescription: 'reason only',
          workspaceMode: 'shared_readonly',
          allowedTools: [],
        },
      })
      expect(record.status).toBe('queued')
    } finally {
      await bridge.dispose(0)
    }
  })
})
