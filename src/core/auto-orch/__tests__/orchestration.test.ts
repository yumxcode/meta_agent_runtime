/**
 * End-to-end coverage for the EXECUTION half of (C): KernelNodeRunner mapping,
 * the AutoOrchController (Planner → PlanRunner → KernelNodeRunner) full run, and
 * the launch phase hook. A queue-backed stub dispatcher returns canned sub-agent
 * records so the whole pipeline runs deterministically without a live LLM.
 */
import { describe, it, expect } from 'vitest'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord, SubAgentStatus } from '../../../subagent/types.js'
import { makeSubAgentTaskId } from '../../../subagent/types.js'
import { KernelNodeRunner, parseRoleVerdict } from '../KernelNodeRunner.js'
import { AutoOrchController, buildAutoOrchLaunchHooks } from '../AutoOrchController.js'
import { RoleCatalog } from '../RoleRegistry.js'
import { runReviewer } from '../reviewer.js'
import type { OrchNode } from '../LoopIR.js'
import type { PlanRunContext } from '../PlanRunner.js'
import type { PhaseHookEvent } from '../../../kernel/loop/PhaseHooks.js'

/**
 * A catalogue where verify/drift resolve to the GENERIC reviewer (pass/fail
 * rubric) so stub-driven tests stay hermetic — the real verify/drift gates need
 * git-snapshot + judge infra exercised by the kernel suites, not here. This
 * also proves the catalogue is injectable/overridable.
 */
function reviewerCatalog(): RoleCatalog {
  const asReviewer = (name: string) => ({
    name,
    buildHandler: (ctx: { dispatcher: ISubAgentDispatcher }) =>
      ({ criteria, signal }: { criteria: string; signal: AbortSignal }) =>
        runReviewer(ctx.dispatcher, { role: name, criteria, signal }),
  })
  return new RoleCatalog()
    .register(asReviewer('verify'))
    .register(asReviewer('drift'))
    .register(asReviewer('reviewer'))
}

interface Canned {
  summary: string
  success?: boolean
  status?: SubAgentStatus
  costUsd?: number
}

/** A dispatcher that returns the next canned record per spawn (FIFO). */
function queueDispatcher(queue: Canned[]): ISubAgentDispatcher {
  const records = new Map<string, SubAgentRecord>()
  return {
    async spawnSubAgent({ config }) {
      const c = queue.shift() ?? { summary: '', success: false, status: 'failed' }
      const taskId = makeSubAgentTaskId()
      const rec: SubAgentRecord = {
        schemaVersion: '1.0',
        taskId,
        parentSessionId: 'p',
        status: c.status ?? 'completed',
        config: { taskDescription: config.taskDescription } as SubAgentRecord['config'],
        createdAt: Date.now(),
        completedAt: Date.now(),
        pendingHumanApproval: false,
        result: {
          success: c.success ?? true,
          summary: c.summary,
          turnsUsed: 1,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: c.costUsd ?? 0,
          durationMs: 1,
        },
      }
      records.set(taskId, rec)
      return rec
    },
    async getStatus(id) { return records.get(id) ?? null },
    async cancelTask() { return true },
  }
}

const ctx = (): PlanRunContext => ({
  signal: new AbortController().signal,
  visits: new Map(),
  totalSteps: 0,
  costUsd: 0,
})

// ── parseRoleVerdict ───────────────────────────────────────────────────────────

describe('parseRoleVerdict', () => {
  it('parses pass/fail + messages', () => {
    expect(parseRoleVerdict('```json\n{"label":"pass","messages":[]}\n```')).toMatchObject({ label: 'pass' })
    const fail = parseRoleVerdict('prose\n{"label":"fail","messages":["x","y"],"note":"n"}')
    expect(fail).toMatchObject({ label: 'fail', note: 'n' })
    expect(fail!.messages).toEqual(['x', 'y'])
  })
  it('returns null on garbage', () => {
    expect(parseRoleVerdict('no json')).toBeNull()
  })
})

// ── KernelNodeRunner ─────────────────────────────────────────────────────────

describe('KernelNodeRunner', () => {
  const exec: OrchNode = { id: 'gen', kind: 'executor', taskDescription: 'do', workspaceMode: 'isolated_write' }
  // 'reviewer' resolves to the generic read-only reviewer in the default catalogue.
  const role: OrchNode = { id: 'verify', kind: 'role', role: 'reviewer', taskDescription: 'check' }

  it('maps a successful executor to branch:ok with cost', async () => {
    const runner = new KernelNodeRunner(queueDispatcher([{ summary: 'built it', success: true, costUsd: 0.2 }]))
    const v = await runner.run(exec, ctx())
    expect(v).toMatchObject({ action: 'branch', label: 'ok' })
    expect(v.data?.['costUsd']).toBe(0.2)
  })

  it('maps a failed executor to branch:error', async () => {
    const runner = new KernelNodeRunner(queueDispatcher([{ summary: '', success: false }]))
    const v = await runner.run(exec, ctx())
    expect(v).toMatchObject({ action: 'branch', label: 'error' })
  })

  it('maps a role pass to done:pass and a fail to branch:fail with messages', async () => {
    const passRunner = new KernelNodeRunner(queueDispatcher([{ summary: '{"label":"pass","messages":[]}' }]))
    expect(await passRunner.run(role, ctx())).toMatchObject({ action: 'done', label: 'pass' })

    const failRunner = new KernelNodeRunner(queueDispatcher([{ summary: '{"label":"fail","messages":["missing tests"]}' }]))
    const v = await failRunner.run(role, ctx())
    expect(v).toMatchObject({ action: 'branch', label: 'fail' })
    expect(v.messages).toEqual(['missing tests'])
  })

  it('fail-open: an unparsable role verdict becomes a skipped pass', async () => {
    const runner = new KernelNodeRunner(queueDispatcher([{ summary: 'I think it is fine' }]))
    const v = await runner.run(role, ctx())
    expect(v).toMatchObject({ action: 'done', label: 'pass', skipped: true })
  })
})

// ── AutoOrchController (end-to-end) ────────────────────────────────────────────

const PLAN = '```json\n' + JSON.stringify({
  entry: 'gen',
  nodes: [
    { id: 'gen', kind: 'executor', taskDescription: 'generate', allowedTools: ['edit_file'], workspaceMode: 'isolated_write' },
    { id: 'verify', kind: 'role', role: 'verify', taskDescription: 'verify goal met' },
  ],
  edges: [
    { from: 'gen', to: 'verify' },
    { from: 'verify', to: 'gen', when: { on: 'verdictLabel', label: 'fail' } },
  ],
  bounds: { maxNodeVisits: 4 },
}) + '\n```'

describe('AutoOrchController', () => {
  it('plans then runs the graph to completion (gen → verify pass)', async () => {
    // queue: planner plan, then gen (executor ok), then verify (pass)
    const dispatcher = queueDispatcher([
      { summary: PLAN },
      { summary: 'generated', success: true, costUsd: 0.3 },
      { summary: '{"label":"pass","messages":[]}', costUsd: 0.1 },
    ])
    const controller = new AutoOrchController({ dispatcher, projectDir: '/tmp', getGoal: () => 'build X', nodeRunnerOptions: { roleCatalog: reviewerCatalog() } })
    const result = await controller.run(new AbortController().signal)
    expect(result.planSource).toBe('planner')
    expect(result.run.status).toBe('completed')
    expect(result.run.visitedPath).toEqual(['gen', 'verify'])
    expect(result.run.costUsd).toBeCloseTo(0.4, 5)
    expect(result.summary).toContain('gen → verify')
  })

  it('drives a generate→verify→fix cycle (fail then pass)', async () => {
    const dispatcher = queueDispatcher([
      { summary: PLAN },
      { summary: 'attempt 1', success: true },         // gen
      { summary: '{"label":"fail","messages":["fix bug"]}' }, // verify → fail → back to gen
      { summary: 'attempt 2', success: true },         // gen again
      { summary: '{"label":"pass","messages":[]}' },   // verify → pass
    ])
    const controller = new AutoOrchController({ dispatcher, projectDir: '/tmp', getGoal: () => 'build X', nodeRunnerOptions: { roleCatalog: reviewerCatalog() } })
    const result = await controller.run(new AbortController().signal)
    expect(result.run.status).toBe('completed')
    expect(result.run.visitedPath).toEqual(['gen', 'verify', 'gen', 'verify'])
  })

  it('falls back to a single-executor plan when planning is unparsable, and still runs', async () => {
    const dispatcher = queueDispatcher([
      { summary: 'I could not plan' },                 // planner → unparsable → fallback
      { summary: 'did the work', success: true },      // execute
      { summary: '{"label":"pass","messages":[]}' },   // verify
    ])
    const controller = new AutoOrchController({ dispatcher, projectDir: '/tmp', getGoal: () => 'build X', nodeRunnerOptions: { roleCatalog: reviewerCatalog() } })
    const result = await controller.run(new AbortController().signal)
    expect(result.planSource).toBe('fallback')
    expect(result.run.status).toBe('completed')
    expect(result.run.visitedPath).toEqual(['execute', 'verify'])
  })
})

// ── launch phase hook ──────────────────────────────────────────────────────────

describe('buildAutoOrchLaunchHooks', () => {
  function event(): PhaseHookEvent {
    return {
      point: 'pre_query',
      workspaceRoot: '/tmp',
      state: { turnCount: 0, estimatedCostUsd: 0 },
      signal: new AbortController().signal,
    }
  }

  it('runs the controller once on pre_query and aborts with the summary', async () => {
    const dispatcher = queueDispatcher([
      { summary: PLAN },
      { summary: 'generated', success: true },
      { summary: '{"label":"pass","messages":[]}' },
    ])
    const controller = new AutoOrchController({ dispatcher, projectDir: '/tmp', getGoal: () => 'g', nodeRunnerOptions: { roleCatalog: reviewerCatalog() } })
    const fn = buildAutoOrchLaunchHooks(controller)

    const first = await fn(event())
    expect(first.abort).toBe(true)
    expect(first.note).toContain('auto-orch')

    // idempotent: a second pre_query does not re-run orchestration
    const second = await fn(event())
    expect(second.abort).toBeUndefined()
  })
})
