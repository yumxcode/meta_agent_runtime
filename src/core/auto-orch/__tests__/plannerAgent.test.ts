/**
 * PlannerAgent — unit coverage for the graph-authoring half of (C).
 *
 * A stub ISubAgentDispatcher returns canned summary text so we exercise the
 * full pipeline (spawn → poll → parse → validate → fallback) without a live LLM:
 *   • a valid JSON plan is parsed and accepted (source: 'planner');
 *   • an unparsable / invalid / empty-goal / no-summary result falls back to the
 *     degenerate single-executor plan (always valid) — the fail-open guarantee;
 *   • parseOrchPlan + singleExecutorPlan behave as specified.
 */
import { describe, it, expect } from 'vitest'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../../subagent/types.js'
import { makeSubAgentTaskId } from '../../../subagent/types.js'
import {
  makeAutoOrchPlanner,
  parseOrchPlan,
  singleExecutorPlan,
} from '../PlannerAgent.js'
import { validatePlan } from '../LoopIR.js'

/** A dispatcher whose spawned agent "completes" with a fixed summary string. */
function stubDispatcher(summary: string | null): ISubAgentDispatcher {
  const taskId = makeSubAgentTaskId()
  const rec: SubAgentRecord = {
    schemaVersion: '1.0',
    taskId,
    parentSessionId: 'parent',
    status: 'completed',
    config: { taskDescription: 'plan' } as SubAgentRecord['config'],
    createdAt: Date.now(),
    completedAt: Date.now(),
    pendingHumanApproval: false,
    result: summary === null
      ? undefined
      : {
          success: true,
          summary,
          turnsUsed: 1,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          durationMs: 1,
        },
  }
  return {
    async spawnSubAgent() { return rec },
    async getStatus() { return rec },
    async cancelTask() { return true },
  }
}

const VALID_PLAN_JSON = '```json\n' + JSON.stringify({
  id: 'p1',
  entry: 'gen',
  nodes: [
    { id: 'gen', kind: 'executor', taskDescription: 'write the thing', allowedTools: ['edit_file'], workspaceMode: 'isolated_write' },
    { id: 'verify', kind: 'role', role: 'verify', taskDescription: 'check goal met' },
  ],
  edges: [
    { from: 'gen', to: 'verify' },
    { from: 'verify', to: 'gen', when: { on: 'verdictLabel', label: 'fail' } },
  ],
  bounds: { maxNodeVisits: 5 },
}) + '\n```'

const signal = (): AbortSignal => new AbortController().signal

describe('parseOrchPlan', () => {
  it('extracts and normalises a fenced JSON plan', () => {
    const plan = parseOrchPlan(VALID_PLAN_JSON)
    expect(plan).not.toBeNull()
    expect(plan!.entry).toBe('gen')
    expect(plan!.nodes).toHaveLength(2)
    expect(plan!.nodes[1].kind).toBe('role')
    expect(validatePlan(plan!)).toHaveLength(0)
  })

  it('coerces an unknown node kind to executor', () => {
    const plan = parseOrchPlan('```json\n' + JSON.stringify({
      entry: 'a',
      nodes: [{ id: 'a', kind: 'banana', taskDescription: 'x' }],
      edges: [],
    }) + '\n```')
    expect(plan!.nodes[0].kind).toBe('executor')
  })

  it('returns null when there is no JSON at all', () => {
    expect(parseOrchPlan('no plan here, just prose')).toBeNull()
  })
})

describe('singleExecutorPlan', () => {
  it('is always a valid runnable plan', () => {
    expect(validatePlan(singleExecutorPlan('do X'))).toHaveLength(0)
  })
})

describe('makeAutoOrchPlanner', () => {
  const deps = (summary: string | null, goal: string | null = 'build a feature') => ({
    dispatcher: stubDispatcher(summary),
    projectDir: '/tmp/ws',
    getGoal: () => goal,
  })

  it('accepts a valid planner plan (source: planner)', async () => {
    const out = await makeAutoOrchPlanner(deps(VALID_PLAN_JSON))(signal())
    expect(out.source).toBe('planner')
    expect(out.plan.entry).toBe('gen')
    expect(validatePlan(out.plan)).toHaveLength(0)
  })

  it('falls back when the goal is missing', async () => {
    const out = await makeAutoOrchPlanner(deps(VALID_PLAN_JSON, null))(signal())
    expect(out.source).toBe('fallback')
    expect(out.note).toContain('goal missing')
    expect(validatePlan(out.plan)).toHaveLength(0)
  })

  it('falls back on unparsable output', async () => {
    const out = await makeAutoOrchPlanner(deps('I could not produce a plan.'))(signal())
    expect(out.source).toBe('fallback')
    expect(out.note).toContain('parseable')
  })

  it('falls back on an invalid plan and surfaces validation errors', async () => {
    const invalid = '```json\n' + JSON.stringify({
      entry: 'missing',
      nodes: [{ id: 'gen', kind: 'executor', taskDescription: 'x', allowedTools: ['edit_file'] }],
      edges: [{ from: 'gen', to: 'ghost' }],
    }) + '\n```'
    const out = await makeAutoOrchPlanner(deps(invalid))(signal())
    expect(out.source).toBe('fallback')
    expect(out.errors && out.errors.length).toBeTruthy()
    expect(validatePlan(out.plan)).toHaveLength(0) // fallback is still runnable
  })

  it('falls back when the agent returns no summary', async () => {
    const out = await makeAutoOrchPlanner(deps(null))(signal())
    expect(out.source).toBe('fallback')
    expect(out.note).toContain('no summary')
  })
})
