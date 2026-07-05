import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SubAgentRecord, SubAgentTaskId } from '../types.js'
import type { MetaAgentTool } from '../../core/types.js'

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

  it('uses a $10 total budget for conservative auto defaults', async () => {
    const bridge = new SubAgentBridge(crypto.randomUUID(), {
      conservativeAutoDefaults: true,
      startDelayMs: 0,
    })

    await expect(
      bridge.spawnSubAgent({ config: { taskDescription: 'expensive research', maxBudgetUsd: 6 } }),
    ).resolves.toMatchObject({ config: { maxBudgetUsd: 6 } })

    await expect(
      bridge.spawnSubAgent({ config: { taskDescription: 'too much', maxBudgetUsd: 5 } }),
    ).rejects.toThrow(/limit \$10\.0000/)
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
})

describe('SubAgentBridge isolated-write contract', () => {
  it('fails closed when isolated_write is requested without a git coordinator', async () => {
    const bridge = new SubAgentBridge(`isolated-${crypto.randomUUID()}`)
    try {
      await expect(bridge.spawnSubAgent({
        config: {
          taskDescription: 'write code',
          workspaceMode: 'isolated_write',
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
    try {
      const task = await bridge.spawnSubAgent({
        config: {
          taskDescription: 'write code',
          workspaceMode: 'isolated_write',
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
    } finally {
      await bridge.dispose()
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
