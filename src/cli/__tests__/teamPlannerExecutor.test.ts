import { describe, expect, it, vi } from 'vitest'
import { executePlan } from '../teamPlannerExecutor.js'
import type { TeamPlannerPlan } from '../../robotics/team/TeamPlanner.js'
import type { RoboticsTeamController } from '../../routing/SessionRouter.js'

function makePlan(overrides: Partial<TeamPlannerPlan> = {}): TeamPlannerPlan {
  return {
    intent: 'start_work',
    risk: 'safe',
    summary: '',
    guidance: '',
    actions: [],
    continueToAgent: true,
    ...overrides,
  }
}

const yes = async () => 'y'
const no = async () => 'n'

describe('executePlan (v2.0)', () => {
  it('does nothing when there are no actions', async () => {
    const r = await executePlan({} as RoboticsTeamController, makePlan(), yes)
    expect(r).toEqual({ executed: [], skipped: [], failed: [], aborted: false })
  })

  it('aborts when risk === blocked', async () => {
    const ctl = { teamTake: vi.fn() } as unknown as RoboticsTeamController
    const r = await executePlan(
      ctl,
      makePlan({ risk: 'blocked', actions: [{ type: 'take_task', taskId: 'TASK-001', reason: 'x', requiresConfirmation: false }] }),
      yes,
    )
    expect(r.aborted).toBe(true)
    expect((ctl as { teamTake: ReturnType<typeof vi.fn> }).teamTake).not.toHaveBeenCalled()
  })

  it('executes safe show_board without asking', async () => {
    const teamStatus = vi.fn().mockResolvedValue(null)
    const ask = vi.fn()
    const r = await executePlan(
      { teamStatus } as unknown as RoboticsTeamController,
      makePlan({ actions: [{ type: 'show_board', reason: 'check', requiresConfirmation: false }] }),
      ask,
    )
    expect(teamStatus).toHaveBeenCalledOnce()
    expect(ask).not.toHaveBeenCalled()
    expect(r.executed).toHaveLength(1)
  })

  it('asks before take_task when requiresConfirmation', async () => {
    const teamTake = vi.fn().mockResolvedValue({ task: { id: 'TASK-001' }, state: {} })
    const ask = vi.fn().mockResolvedValue('y')
    const r = await executePlan(
      { teamTake } as unknown as RoboticsTeamController,
      makePlan({ actions: [{ type: 'take_task', taskId: 'TASK-001', reason: 'user wants it', requiresConfirmation: true }] }),
      ask,
    )
    expect(ask).toHaveBeenCalledOnce()
    expect(teamTake).toHaveBeenCalledWith('TASK-001')
    expect(r.executed).toHaveLength(1)
  })

  it('asks before mutating actions even if requiresConfirmation is false', async () => {
    const teamTake = vi.fn().mockResolvedValue({ task: { id: 'TASK-001' }, state: {} })
    const ask = vi.fn().mockResolvedValue('y')
    await executePlan(
      { teamTake } as unknown as RoboticsTeamController,
      makePlan({ actions: [{ type: 'take_task', taskId: 'TASK-001', reason: 'model omitted confirmation', requiresConfirmation: false }] }),
      ask,
    )
    expect(ask).toHaveBeenCalledOnce()
    expect(teamTake).toHaveBeenCalledWith('TASK-001')
  })

  it('skips when user declines', async () => {
    const teamTake = vi.fn()
    const r = await executePlan(
      { teamTake } as unknown as RoboticsTeamController,
      makePlan({ actions: [{ type: 'take_task', taskId: 'TASK-001', reason: '', requiresConfirmation: true }] }),
      no,
    )
    expect(teamTake).not.toHaveBeenCalled()
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0]?.reason).toBe('user declined')
  })

  it('continues after a failed action', async () => {
    const teamTake = vi.fn().mockRejectedValue(new Error('owned by other'))
    const teamStatus = vi.fn().mockResolvedValue(null)
    const r = await executePlan(
      { teamTake, teamStatus } as unknown as RoboticsTeamController,
      makePlan({
        actions: [
          { type: 'take_task', taskId: 'TASK-001', reason: '', requiresConfirmation: false },
          { type: 'show_board', reason: '', requiresConfirmation: false },
        ],
      }),
      yes,
    )
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]?.error).toBe('owned by other')
    expect(r.executed).toHaveLength(1)
    expect(r.executed[0]?.type).toBe('show_board')
  })

  it('autoApprove bypasses confirmation', async () => {
    const teamTake = vi.fn().mockResolvedValue({ task: { id: 'TASK-001' }, state: {} })
    const ask = vi.fn()
    await executePlan(
      { teamTake } as unknown as RoboticsTeamController,
      makePlan({ actions: [{ type: 'take_task', taskId: 'TASK-001', reason: '', requiresConfirmation: true }] }),
      ask,
      { autoApprove: true },
    )
    expect(ask).not.toHaveBeenCalled()
    expect(teamTake).toHaveBeenCalledOnce()
  })

  it('add_note dispatches to teamNote with parsed fields', async () => {
    const teamNote = vi.fn().mockResolvedValue({ task: { id: 'TASK-001' }, state: {}, attempt: {} })
    await executePlan(
      { teamNote } as unknown as RoboticsTeamController,
      makePlan({
        actions: [{
          type: 'add_note',
          taskId: 'TASK-001',
          direction: '试 ResNet',
          outcome: '失败',
          ref: 'wandb.ai/abc',
          reason: '',
          requiresConfirmation: false,
        }],
      }),
      yes,
    )
    expect(teamNote).toHaveBeenCalledWith({
      taskId: 'TASK-001',
      direction: '试 ResNet',
      outcome: '失败',
      ref: 'wandb.ai/abc',
    })
  })

  it('add_note rejects when missing direction/outcome', async () => {
    const teamNote = vi.fn()
    const r = await executePlan(
      { teamNote } as unknown as RoboticsTeamController,
      makePlan({ actions: [{ type: 'add_note', taskId: 'TASK-001', reason: '', requiresConfirmation: false }] }),
      yes,
    )
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]?.error).toMatch(/direction/)
    expect(teamNote).not.toHaveBeenCalled()
  })

  it('steal_task requires a reason', async () => {
    const teamSteal = vi.fn()
    const r = await executePlan(
      { teamSteal } as unknown as RoboticsTeamController,
      makePlan({ actions: [{ type: 'steal_task', taskId: 'TASK-001', reason: '', requiresConfirmation: false }] }),
      yes,
    )
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]?.error).toMatch(/reason/)
    expect(teamSteal).not.toHaveBeenCalled()
  })

  it('mark_done dispatches teamTaskStatus(.., done)', async () => {
    const teamTaskStatus = vi.fn().mockResolvedValue({ task: { id: 'TASK-001' }, state: {} })
    await executePlan(
      { teamTaskStatus } as unknown as RoboticsTeamController,
      makePlan({ actions: [{ type: 'mark_done', taskId: 'TASK-001', reason: '', requiresConfirmation: false }] }),
      yes,
    )
    expect(teamTaskStatus).toHaveBeenCalledWith('TASK-001', 'done')
  })

  it('onAction callback fires for each phase', async () => {
    const teamSync = vi.fn().mockResolvedValue({})
    const seen: string[] = []
    await executePlan(
      { teamSync } as unknown as RoboticsTeamController,
      makePlan({ actions: [{ type: 'sync_team', reason: '', requiresConfirmation: false }] }),
      yes,
      { onAction: (_a, s) => seen.push(s) },
    )
    expect(seen).toEqual(['starting', 'done'])
  })
})
