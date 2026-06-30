import { describe, expect, it } from 'vitest'
import {
  buildTeamPlannerUserMessage,
  parseTeamPlannerPlan,
  TEAM_PLANNER_SYSTEM,
  type TeamPlannerPlan,
  type TeamPlannerSnapshot,
} from '../TeamPlanner.js'

const validPlan: TeamPlannerPlan = {
  intent: 'start_work',
  risk: 'needs_confirmation',
  summary: '建议先认领 TASK-001 再切分支',
  guidance: '/team use TASK-001 并切到任务分支',
  actions: [
    {
      type: 'take_task',
      taskId: 'TASK-001',
      reason: '用户表达想接任务',
      requiresConfirmation: true,
    },
  ],
  continueToAgent: false,
}

describe('TEAM_PLANNER_SYSTEM', () => {
  it('contains the JSON-only hard rule', () => {
    expect(TEAM_PLANNER_SYSTEM).toMatch(/只输出 JSON/)
  })
})

describe('buildTeamPlannerUserMessage', () => {
  it('embeds input and snapshot JSON', () => {
    const snapshot: TeamPlannerSnapshot = { state: { foo: 'bar' }, recentAttempts: [], events: [] }
    const msg = buildTeamPlannerUserMessage('接个任务', snapshot)
    expect(msg).toContain('用户输入:\n接个任务')
    expect(msg).toContain('"foo": "bar"')
  })
  it('truncates pathologically large snapshots', () => {
    const huge = { state: { tasks: Array.from({ length: 10_000 }, (_, i) => ({ id: `T${i}`, payload: 'x'.repeat(200) })) }, recentAttempts: [], events: [] }
    const msg = buildTeamPlannerUserMessage('ping', huge)
    // 18_000 char snapshot cap + input prefix; allow some slack but must not be unbounded.
    expect(msg.length).toBeLessThan(20_000)
  })
})

describe('parseTeamPlannerPlan', () => {
  it('parses a raw JSON object', () => {
    const plan = parseTeamPlannerPlan(JSON.stringify(validPlan))
    expect(plan?.intent).toBe('start_work')
    expect(plan?.actions[0]?.type).toBe('take_task')
    expect(plan?.continueToAgent).toBe(false)
  })

  it('extracts JSON when wrapped in chatter', () => {
    const wrapped = `这里是规划:\n${JSON.stringify(validPlan)}\n请审阅。`
    const plan = parseTeamPlannerPlan(wrapped)
    expect(plan?.intent).toBe('start_work')
  })

  it('returns null for non-JSON output', () => {
    expect(parseTeamPlannerPlan('对不起，无法回答')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseTeamPlannerPlan('{ broken json')).toBeNull()
  })

  it('defaults missing fields to safe values', () => {
    const plan = parseTeamPlannerPlan('{}')
    expect(plan?.intent).toBe('none')
    expect(plan?.risk).toBe('safe')
    expect(plan?.actions).toEqual([])
    expect(plan?.continueToAgent).toBe(true)
  })

  it('clamps unknown risk to safe', () => {
    const plan = parseTeamPlannerPlan(JSON.stringify({ risk: 'apocalyptic' }))
    expect(plan?.risk).toBe('safe')
  })

  it('keeps blocked / needs_confirmation as-is', () => {
    expect(parseTeamPlannerPlan(JSON.stringify({ risk: 'blocked' }))?.risk).toBe('blocked')
    expect(parseTeamPlannerPlan(JSON.stringify({ risk: 'needs_confirmation' }))?.risk).toBe('needs_confirmation')
  })

  it('drops actions that are not objects or not known action types', () => {
    const plan = parseTeamPlannerPlan(JSON.stringify({
      actions: [null, 'not-an-action', 42, { type: 'show_status', reason: 'ok' }],
    }))
    expect(plan?.actions.length).toBe(0)
  })

  it('forces mutating actions to require confirmation even when the model says otherwise', () => {
    const plan = parseTeamPlannerPlan(JSON.stringify({
      actions: [{ type: 'sync_team', reason: 'x', requiresConfirmation: false }],
    }))
    expect(plan?.actions[0]?.requiresConfirmation).toBe(true)
  })

  it('keeps show_board non-confirming by default', () => {
    const plan = parseTeamPlannerPlan(JSON.stringify({
      actions: [{ type: 'show_board', reason: 'x', requiresConfirmation: false }],
    }))
    expect(plan?.actions[0]?.requiresConfirmation).toBe(false)
  })
})
