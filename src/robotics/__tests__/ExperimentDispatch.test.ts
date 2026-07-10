import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { SpawnSubAgentOptions } from '../../subagent/SubAgentBridge.js'
import type { SubAgentRecord } from '../../subagent/types.js'
import type { GitWorkspaceManager } from '../../infra/git/GitWorkspaceManager.js'
import { RoboticsProjectStore } from '../persistence/RoboticsProjectStore.js'
import { createExperimentDispatchTool } from '../tools/experiment_dispatch/index.js'

const PROJECT_DIR = '/repo/main'
const SESSION_ID = 'robotics-session-test'

afterEach(() => {
  vi.restoreAllMocks()
})

function input(): Record<string, unknown> {
  return {
    title: 'Compare gait gains',
    hypothesis: 'Higher hip damping improves tracking',
    environment: 'sim',
    procedure: 'Run baseline and candidate policies',
    success_criteria: 'tracking_error <= baseline',
    purpose: 'evaluate whether the proposed damping change is worth merging',
    on_complete: 'poll get_sub_agent_status and compare metrics',
  }
}

function toolCtx(): { abortSignal: AbortSignal } {
  return { abortSignal: new AbortController().signal }
}

function makeRecord(opts: SpawnSubAgentOptions): SubAgentRecord {
  return {
    schemaVersion: '1.0',
    taskId: opts.taskId ?? 'subtask-test',
    parentSessionId: SESSION_ID,
    status: 'queued',
    config: opts.config as SubAgentRecord['config'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    checkpoints: [],
    pendingHumanApproval: false,
  } as SubAgentRecord
}

function stubBridge(): { bridge: ISubAgentDispatcher; spawnSubAgent: ReturnType<typeof vi.fn> } {
  const spawnSubAgent = vi.fn(async (opts: SpawnSubAgentOptions) => makeRecord(opts))
  return {
    spawnSubAgent,
    bridge: {
      spawnSubAgent,
      getStatus: vi.fn(),
      cancelTask: vi.fn(),
    } as unknown as ISubAgentDispatcher,
  }
}

function stubCompletedBridge(): { bridge: ISubAgentDispatcher; spawnSubAgent: ReturnType<typeof vi.fn> } {
  const spawnSubAgent = vi.fn(async (opts: SpawnSubAgentOptions) => makeRecord(opts))
  const getStatus = vi.fn(async (taskId: string) => ({
    ...makeRecord({ taskId } as unknown as SpawnSubAgentOptions),
    status: 'completed',
    result: { success: true, summary: 'completed summary' },
  }))
  return {
    spawnSubAgent,
    bridge: {
      spawnSubAgent,
      getStatus,
      cancelTask: vi.fn(),
    } as unknown as ISubAgentDispatcher,
  }
}

describe('experiment_dispatch', () => {
  it('binds the ExperimentAgent projectDir to the git worktree it created', async () => {
    const worktreePath = '/tmp/meta-agent-robotics/subtask-abc12345'
    const { bridge, spawnSubAgent } = stubBridge()
    const gitMgr = {
      enabled: true,
      createWorktreeForTask: vi.fn(async () => ({
        taskId: 'subtask-abc12345',
        role: 'experiment',
        branchName: 'robotics/experiment/subtask-abc12345',
        worktreePath,
        forkPoint: 'abc123',
        createdAt: Date.now(),
      })),
    } as unknown as GitWorkspaceManager
    const updateGitState = vi.spyOn(RoboticsProjectStore, 'updateGitState').mockResolvedValue(undefined)
    const registerSubAgentTask = vi.spyOn(RoboticsProjectStore, 'registerSubAgentTask').mockResolvedValue(undefined)

    const tool = createExperimentDispatchTool(bridge, gitMgr, PROJECT_DIR, SESSION_ID)
    const result = await tool.call(input(), toolCtx())

    expect(result.isError).toBe(false)
    expect(spawnSubAgent).toHaveBeenCalledTimes(1)
    const opts = spawnSubAgent.mock.calls[0]?.[0] as SpawnSubAgentOptions
    expect(opts.config.projectDir).toBe(worktreePath)
    expect(opts.config.workspaceMode).toBeUndefined()
    expect(opts.config.isolateWorktree).toBeUndefined()
    expect(updateGitState).toHaveBeenCalledWith(PROJECT_DIR, SESSION_ID, {
      subAgentBranches: { [opts.taskId!]: 'robotics/experiment/subtask-abc12345' },
      forkPoints: { [opts.taskId!]: 'abc123' },
    })
    expect(registerSubAgentTask).toHaveBeenCalledWith(PROJECT_DIR, SESSION_ID, expect.objectContaining({
      taskId: opts.taskId,
      branchName: 'robotics/experiment/subtask-abc12345',
      worktreePath,
    }))
  })

  it('binds a non-git experiment to the requested robotics project', async () => {
    const { bridge, spawnSubAgent } = stubBridge()
    const gitMgr = {
      enabled: false,
      createWorktreeForTask: vi.fn(),
    } as unknown as GitWorkspaceManager
    vi.spyOn(RoboticsProjectStore, 'updateGitState').mockResolvedValue(undefined)
    vi.spyOn(RoboticsProjectStore, 'registerSubAgentTask').mockResolvedValue(undefined)

    const tool = createExperimentDispatchTool(bridge, gitMgr, PROJECT_DIR, SESSION_ID)
    const result = await tool.call(input(), toolCtx())

    expect(result.isError).toBe(false)
    expect(gitMgr.createWorktreeForTask).not.toHaveBeenCalled()
    const opts = spawnSubAgent.mock.calls[0]?.[0] as SpawnSubAgentOptions
    expect(opts.config.projectDir).toBe(PROJECT_DIR)
    expect(opts.config.workspaceMode).toBeUndefined()
    expect(opts.config.isolateWorktree).toBeUndefined()
    expect(String(opts.config.taskDescription)).toContain('Git worktree isolation is unavailable')
  })

  it('fails closed when a git project cannot allocate its isolated worktree', async () => {
    const { bridge, spawnSubAgent } = stubBridge()
    const gitMgr = {
      enabled: true,
      createWorktreeForTask: vi.fn(async () => { throw new Error('worktree locked') }),
    } as unknown as GitWorkspaceManager

    const tool = createExperimentDispatchTool(bridge, gitMgr, PROJECT_DIR, SESSION_ID)
    const result = await tool.call(input(), toolCtx())

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Unable to create an isolated git worktree')
    expect(spawnSubAgent).not.toHaveBeenCalled()
  })

  it('await_completion keeps branch-backed completed experiments active until merge/discard', async () => {
    const worktreePath = '/tmp/meta-agent-robotics/subtask-complete'
    const { bridge } = stubCompletedBridge()
    const gitMgr = {
      enabled: true,
      createWorktreeForTask: vi.fn(async () => ({
        taskId: 'subtask-complete',
        role: 'experiment',
        branchName: 'robotics/experiment/subtask-complete',
        worktreePath,
        forkPoint: 'abc123',
        createdAt: Date.now(),
      })),
    } as unknown as GitWorkspaceManager
    vi.spyOn(RoboticsProjectStore, 'updateGitState').mockResolvedValue(undefined)
    vi.spyOn(RoboticsProjectStore, 'registerSubAgentTask').mockResolvedValue(undefined)
    const completeSubAgentTask = vi.spyOn(RoboticsProjectStore, 'completeSubAgentTask').mockResolvedValue(undefined)

    const tool = createExperimentDispatchTool(bridge, gitMgr, PROJECT_DIR, SESSION_ID)
    const result = await tool.call({ ...input(), await_completion: true }, toolCtx())

    expect(result.isError).toBe(false)
    expect(result.content).toContain('git_diff_subagent')
    expect(result.content).toContain('remains active')
    expect(completeSubAgentTask).not.toHaveBeenCalled()
  })
})
