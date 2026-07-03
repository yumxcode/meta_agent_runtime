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
import { mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../../subagent/types.js'
import { makeSubAgentTaskId } from '../../../subagent/types.js'
import {
  makeAutoOrchPlanner,
  parseOrchPlan,
  singleExecutorPlan,
} from '../PlannerAgent.js'
import { validatePlan } from '../LoopIR.js'
import { loadAutoOrchPlan, saveApprovedAutoOrchPlan, saveMaterializedAutoOrchPlan } from '../PlanStore.js'

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

/** A dispatcher that yields a DIFFERENT canned summary per spawn (FIFO), so we
 * can exercise the planner's retry loop (invalid plan → re-plan → valid). */
function queueStub(summaries: (string | null)[]): ISubAgentDispatcher {
  const recs = new Map<string, SubAgentRecord>()
  return {
    async spawnSubAgent() {
      const summary = summaries.shift() ?? null
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
        result: summary === null ? undefined : {
          success: true, summary, turnsUsed: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1,
        },
      }
      recs.set(taskId, rec)
      return rec
    },
    async getStatus(id) { return recs.get(id) ?? null },
    async cancelTask() { return true },
  }
}

function queueStubWithCapturedTasks(summaries: (string | null)[], captured: string[]): ISubAgentDispatcher {
  const recs = new Map<string, SubAgentRecord>()
  return {
    async spawnSubAgent({ config }) {
      captured.push(config.taskDescription)
      const summary = summaries.shift() ?? null
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
        result: summary === null ? undefined : {
          success: true, summary, turnsUsed: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1,
        },
      }
      recs.set(taskId, rec)
      return rec
    },
    async getStatus(id) { return recs.get(id) ?? null },
    async cancelTask() { return true },
  }
}

const TRAPPED_PLAN_JSON = '```json\n' + JSON.stringify({
  entry: 'A',
  nodes: [
    { id: 'A', kind: 'executor', taskDescription: 'a' },
    { id: 'B', kind: 'executor', taskDescription: 'b' },
  ],
  edges: [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }], // unconditional cycle → no exit
}) + '\n```'

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

const VALID_PLAN_JSON_2 = '```json\n' + JSON.stringify({
  id: 'p2',
  entry: 'only',
  nodes: [
    { id: 'only', kind: 'executor', taskDescription: 'revised plan' },
  ],
  edges: [],
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

  it('preserves planner-authored code node specs before materialization', () => {
    const plan = parseOrchPlan('```json\n' + JSON.stringify({
      entry: 'reduce',
      nodes: [{
        id: 'reduce',
        kind: 'code',
        taskDescription: 'reduce progress',
        codeSpec: {
          description: 'read progress and return healthy',
          inputs: ['state/progress.json'],
          outputs: ['state/progress.json'],
          labels: ['healthy'],
        },
        input: { taskDir: '.meta-agent/research/t1' },
        capabilities: ['state.read', 'state.write'],
      }],
      edges: [],
    }) + '\n```')
    expect(plan!.nodes[0].kind).toBe('code')
    expect(plan!.nodes[0].codeSpec?.labels).toEqual(['healthy'])
    expect(validatePlan(plan!, { allowUnmaterializedCode: true })).toHaveLength(0)
    expect(validatePlan(plan!)[0]).toContain('materialized')
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

  it('forwards planner sub-agent runtime events to the observer', async () => {
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
      result: {
        success: true,
        summary: VALID_PLAN_JSON,
        turnsUsed: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: 1,
      },
    }
    const dispatcher: ISubAgentDispatcher = {
      async spawnSubAgent(opts) {
        await opts.onRuntimeEvent?.({ type: 'runner_started', taskId })
        await opts.onRuntimeEvent?.({ type: 'session_submit_started', taskId })
        await opts.onRuntimeEvent?.({
          type: 'session_event',
          taskId,
          event: {
            type: 'tool_use',
            toolUseId: 'toolu_1',
            toolName: 'glob',
            toolInput: { pattern: '**/*.ts' },
            sessionId: 's1',
          },
        })
        return rec
      },
      async getStatus() { return rec },
      async cancelTask() { return true },
    }
    const events: string[] = []
    const out = await makeAutoOrchPlanner({
      dispatcher,
      projectDir: '/tmp',
      getGoal: () => 'g',
      observer: event => {
        if (event.type === 'planner_subagent_event') {
          events.push(`${event.eventType}:${event.toolName ?? ''}`)
        }
      },
    })(signal())

    expect(out.source).toBe('planner')
    expect(events).toEqual([
      'runner_started:',
      'model_call_started:',
    ])
  })

  it('falls back when the goal is missing', async () => {
    const out = await makeAutoOrchPlanner(deps(VALID_PLAN_JSON, null))(signal())
    expect(out.source).toBe('fallback')
    expect(out.note).toContain('goal missing')
    expect(validatePlan(out.plan)).toHaveLength(0)
  })

  it('falls back on unparsable output (after retries)', async () => {
    const out = await makeAutoOrchPlanner(deps('I could not produce a plan.'))(signal())
    expect(out.source).toBe('fallback')
    expect(out.note).toContain('within 2 attempts')
    expect((out.errors ?? []).join(' ')).toContain('parseable')
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

  it('falls back when the agent returns no summary (after retries)', async () => {
    const out = await makeAutoOrchPlanner(deps(null))(signal())
    expect(out.source).toBe('fallback')
    expect((out.errors ?? []).join(' ')).toContain('no summary')
    expect(validatePlan(out.plan)).toHaveLength(0)
  })

  it('re-plans after an invalid plan and accepts the corrected one', async () => {
    // attempt 1: a trapped (no-exit) cycle → rejected; attempt 2: valid plan.
    const dispatcher = queueStub([TRAPPED_PLAN_JSON, VALID_PLAN_JSON])
    const out = await makeAutoOrchPlanner({ dispatcher, projectDir: '/tmp', getGoal: () => 'g' })(signal())
    expect(out.source).toBe('planner')
    expect(out.note).toContain('attempt 2')
    expect(validatePlan(out.plan)).toHaveLength(0)
  })

  it('falls back after exhausting retries on a persistently trapped cycle', async () => {
    const dispatcher = queueStub([TRAPPED_PLAN_JSON, TRAPPED_PLAN_JSON])
    const out = await makeAutoOrchPlanner({ dispatcher, projectDir: '/tmp', getGoal: () => 'g', maxAttempts: 2 })(signal())
    expect(out.source).toBe('fallback')
    expect((out.errors ?? []).join(' ')).toContain('graceful exit')
    expect(validatePlan(out.plan)).toHaveLength(0) // fallback still runnable
  })

  it('planner review approves a valid draft without exposing ask_user as a tool', async () => {
    const answers = ['Approve plan']
    const out = await makeAutoOrchPlanner({
      dispatcher: queueStub([VALID_PLAN_JSON]),
      projectDir: '/tmp',
      getGoal: () => 'g',
      plannerReview: {
        enabled: true,
        askUser: async () => answers.shift() ?? 'Approve plan',
      },
    })(signal())
    expect(out.source).toBe('planner')
    expect(out.plan.id).toBe('p1')
    expect(out.approvedByUser).toBe(true)
  })

  it('loads a saved plan by ref without spawning a planner', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'auto-orch-plan-load-'))
    const plan = parseOrchPlan(VALID_PLAN_JSON)!
    await saveApprovedAutoOrchPlan(projectDir, {
      goal: 'g',
      plan,
      source: 'planner',
      approvedByUser: true,
    })
    let spawns = 0
    const out = await makeAutoOrchPlanner({
      dispatcher: {
        async spawnSubAgent() { spawns++; throw new Error('planner should not spawn') },
        async getStatus() { return null },
        async cancelTask() { return true },
      },
      projectDir,
      getGoal: () => 'g',
      planRef: 'p1',
    })(signal())

    expect(spawns).toBe(0)
    expect(out.source).toBe('saved')
    expect(out.plan.id).toBe('p1')
    expect(out.seedPlanRef).toMatchObject({ planId: 'p1', version: 1 })
  })

  it('loads the materialized graph before the approved graph', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'auto-orch-materialized-first-'))
    const approved = parseOrchPlan(VALID_PLAN_JSON)!
    const materialized: typeof approved = {
      ...approved,
      id: 'p1',
      entry: 'mat',
      nodes: [
        {
          id: 'mat',
          kind: 'executor',
          task: 'materialized task',
          labels: ['ok'],
        },
      ],
      edges: [],
    }
    const ref = await saveApprovedAutoOrchPlan(projectDir, {
      goal: 'g',
      plan: approved,
      source: 'planner',
      approvedByUser: true,
    })
    await saveMaterializedAutoOrchPlan(projectDir, ref, materialized)

    const loaded = await loadAutoOrchPlan(projectDir, 'p1')
    expect(loaded?.plan.entry).toBe(materialized.entry)
  })

  it('planner review can request a revision and feed the feedback into the next planner attempt', async () => {
    const captured: string[] = []
    const answers = ['Revise plan', 'Make it a single simple node']
    const out = await makeAutoOrchPlanner({
      dispatcher: queueStubWithCapturedTasks([VALID_PLAN_JSON, VALID_PLAN_JSON_2], captured),
      projectDir: '/tmp',
      getGoal: () => 'g',
      plannerReview: {
        enabled: true,
        maxRounds: 2,
        askUser: async () => answers.shift() ?? 'Approve plan',
      },
    })(signal())
    expect(out.source).toBe('planner')
    expect(out.plan.id).toBe('p2')
    expect(captured[1]).toContain('Make it a single simple node')
  })

  it('stops retrying when the parent signal is aborted during planning', async () => {
    const controller = new AbortController()
    let spawns = 0
    const dispatcher: ISubAgentDispatcher = {
      async spawnSubAgent() {
        spawns++
        controller.abort('test-abort')
        const taskId = makeSubAgentTaskId()
        return {
          schemaVersion: '1.0',
          taskId,
          parentSessionId: 'parent',
          status: 'completed',
          config: { taskDescription: 'plan' } as SubAgentRecord['config'],
          createdAt: Date.now(),
          completedAt: Date.now(),
          pendingHumanApproval: false,
          result: {
            success: true,
            summary: TRAPPED_PLAN_JSON,
            turnsUsed: 1,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            durationMs: 1,
          },
        }
      },
      async getStatus() { return null },
      async cancelTask() { return true },
    }
    const out = await makeAutoOrchPlanner({
      dispatcher,
      projectDir: '/tmp',
      getGoal: () => 'g',
      maxAttempts: 5,
      plannerReview: { enabled: true, maxRounds: 3, askUser: async () => 'Approve plan' },
    })(controller.signal)

    expect(spawns).toBe(1)
    expect(out.source).toBe('fallback')
    expect(out.note).toContain('aborted')
  })
})
