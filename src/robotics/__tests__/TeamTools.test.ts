/**
 * Tests for the agent-facing team tools (team_note / team_take /
 * team_mark_done) — the "meta-agent half" of a unit.
 */
import { describe, expect, it, vi } from 'vitest'
import { createTeamTools, type TeamToolsHost } from '../tools/team/index.js'
import type { TeamTask } from '../team/TeamStore.js'

function makeTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'TASK-001',
    title: 'PID 调参',
    status: 'open',
    attempts: [{ at: new Date().toISOString(), unit: 'me-host', direction: 'd', outcome: 'o' }],
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeHost(overrides: Partial<TeamToolsHost> = {}): TeamToolsHost {
  return {
    teamExists: vi.fn(async () => true),
    teamUnitId: () => 'me-host',
    teamStatus: vi.fn(async () => null),
    teamNote: vi.fn(async () => ({ task: makeTask() })),
    teamTake: vi.fn(async () => ({ task: makeTask({ ownerUnit: 'me-host' }) })),
    teamTaskStatus: vi.fn(async () => ({ task: makeTask({ status: 'done' }) })),
    teamPublishState: vi.fn(async () => ({ dirty: ['M team/team.json'], unpushedCommits: 0, isGitRepo: true })),
    ...overrides,
  }
}

const ctx = {} as never

describe('agent team tools', () => {
  it('registers exactly note/take/mark_done — steal is not exposed', () => {
    const names = createTeamTools(makeHost()).map(t => t.name)
    expect(names).toEqual(['team_note', 'team_take', 'team_mark_done'])
  })

  it('team_note forwards fields and appends the publish reminder', async () => {
    const host = makeHost()
    const [note] = createTeamTools(host)
    const result = await note!.call(
      { task_id: 'TASK-001', direction: '试 LQR 替代 PID', outcome: '超调 3.2%，达标', ref: 'wandb/run-9' },
      ctx,
    )
    expect(result.isError).toBe(false)
    expect(host.teamNote).toHaveBeenCalledWith({
      taskId: 'TASK-001', direction: '试 LQR 替代 PID', outcome: '超调 3.2%，达标', ref: 'wandb/run-9',
    })
    expect(result.content).toContain('已为 TASK-001 记录')
    expect(result.content).toContain('/team push')
  })

  it('all tools fail cleanly when team mode is not initialised (and never create it)', async () => {
    const host = makeHost({ teamExists: vi.fn(async () => false) })
    for (const tool of createTeamTools(host)) {
      const result = await tool.call({ task_id: 'TASK-001', direction: 'd', outcome: 'o' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('/team init')
    }
    expect(host.teamNote).not.toHaveBeenCalled()
    expect(host.teamTake).not.toHaveBeenCalled()
    expect(host.teamTaskStatus).not.toHaveBeenCalled()
  })

  it('team_take surfaces ownership errors instead of throwing', async () => {
    const host = makeHost({
      teamTake: vi.fn(async () => { throw new Error('TASK-001 已被 alice-laptop 领取') }),
    })
    const [, take] = createTeamTools(host)
    const result = await take!.call({ task_id: 'TASK-001' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('alice-laptop')
  })

  it('team_mark_done marks done via teamTaskStatus', async () => {
    const host = makeHost()
    const [, , done] = createTeamTools(host)
    const result = await done!.call({ task_id: 'TASK-001' }, ctx)
    expect(result.isError).toBe(false)
    expect(host.teamTaskStatus).toHaveBeenCalledWith('TASK-001', 'done')
  })
})
