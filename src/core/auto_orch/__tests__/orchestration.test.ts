/**
 * End-to-end coverage for the EXECUTION half of (C): KernelNodeRunner mapping,
 * the AutoOrchController (Planner → PlanRunner → KernelNodeRunner) full run, and
 * the launch phase hook. A queue-backed stub dispatcher returns canned sub-agent
 * records so the whole pipeline runs deterministically without a live LLM.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord, SubAgentStatus } from '../../../subagent/types.js'
import { makeSubAgentTaskId } from '../../../subagent/types.js'
import { KernelNodeRunner, parseRoleVerdict } from '../KernelNodeRunner.js'
import { AutoOrchController, buildAutoOrchLaunchHooks } from '../AutoOrchController.js'
import { materializeCodeNodes } from '../CodeNodeAuthor.js'
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
  output?: unknown
}

/** A dispatcher that returns the next canned record per spawn (FIFO). When a
 * `captured` array is supplied, each spawn's taskDescription is recorded so a
 * test can assert what a re-run executor actually received (e.g. correctives). */
function queueDispatcher(queue: Canned[], captured?: string[]): ISubAgentDispatcher {
  const records = new Map<string, SubAgentRecord>()
  return {
    async spawnSubAgent({ config }) {
      captured?.push(config.taskDescription)
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
          output: c.output,
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

  it('maps an executor return_result error label to branch:error', async () => {
    const runner = new KernelNodeRunner(queueDispatcher([{
      summary: 'missing state',
      success: true,
      output: { label: 'error', note: 'state files are missing' },
    }]))
    const v = await runner.run(exec, ctx())
    expect(v).toMatchObject({ action: 'branch', label: 'error', note: 'state files are missing' })
  })

  it('maps legacy executor summaries that start with error to branch:error', async () => {
    const runner = new KernelNodeRunner(queueDispatcher([{
      summary: '返回 error。无法完成任务：所需 state 文件缺失。',
      success: true,
    }]))
    const v = await runner.run(exec, ctx())
    expect(v).toMatchObject({ action: 'branch', label: 'error' })
  })

  it('maps an auto_orch pause payload to branch:paused with a resume handle', async () => {
    const runner = new KernelNodeRunner(queueDispatcher([{
      summary: 'paused',
      success: true,
      output: {
        auto_orch_pause: {
          kind: 'auto_orch_pause_external',
          reason: 'waiting_training_result',
          externalRunId: 'train-1',
          resumeInstruction: 'resume with metrics',
        },
      },
    }]))
    const v = await runner.run(exec, ctx())
    expect(v).toMatchObject({ action: 'branch', label: 'paused', note: 'resume with metrics' })
    expect(v.data?.['resumeHandle']).toMatchObject({
      nodeId: 'gen',
      externalRunId: 'train-1',
    })
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

describe('materializeCodeNodes', () => {
  it('authors and freezes missing code nodes as codeRef/sourceHash artifacts', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'auto-orch-author-'))
    const source = 'export async function main() { return { action: "branch", label: "healthy" } }'
    const dispatcher = queueDispatcher([{
      summary: '```json\n' + JSON.stringify({ source, note: 'simple reducer' }) + '\n```',
    }])
    const out = await materializeCodeNodes({
      entry: 'reduce',
      nodes: [{
        id: 'reduce',
        kind: 'code',
        taskDescription: 'reduce',
        codeSpec: { description: 'return healthy', labels: ['healthy'] },
      }],
      edges: [],
    }, { dispatcher, projectDir }, new AbortController().signal)
    expect(out.errors).toHaveLength(0)
    expect(out.materialized).toBe(1)
    expect(out.plan.nodes[0].codeRef).toMatch(/^code_nodes\//)
    expect(out.plan.nodes[0].sourceHash).toHaveLength(64)
  })

  it('retries code authoring with review feedback after forbidden source', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'auto-orch-author-retry-'))
    const badSource = 'export async function main() { return { action: "branch", label: "healthy", data: { at: new Date().toISOString() } } }'
    const fixedSource = 'export async function main(input, api) { return { action: "branch", label: "healthy", data: { at: api.nowIso } } }'
    const captured: string[] = []
    const dispatcher = queueDispatcher([
      { summary: '```json\n' + JSON.stringify({ source: badSource, note: 'uses Date' }) + '\n```' },
      { summary: '```json\n' + JSON.stringify({ source: fixedSource, note: 'uses api.nowIso' }) + '\n```' },
    ], captured)

    const out = await materializeCodeNodes({
      entry: 'reduce',
      nodes: [{
        id: 'reduce',
        kind: 'code',
        taskDescription: 'reduce',
        codeSpec: { description: 'return healthy with a timestamp', labels: ['healthy'] },
      }],
      edges: [],
    }, { dispatcher, projectDir }, new AbortController().signal)

    expect(out.errors).toHaveLength(0)
    expect(out.materialized).toBe(1)
    expect(captured).toHaveLength(2)
    expect(captured[1]).toContain('source uses forbidden construct')
    expect(captured[1]).toContain('api.nowIso')
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

  it('persists an explicitly approved graph, materialized plan, and run record', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'auto-orch-approved-plan-'))
    const dispatcher = queueDispatcher([
      { summary: PLAN },
      { summary: 'generated', success: true },
      { summary: '{"label":"pass","messages":[]}' },
    ])
    const controller = new AutoOrchController({
      dispatcher,
      projectDir,
      getGoal: () => 'build X',
      plannerReview: { enabled: true, askUser: async () => 'Approve plan' },
      nodeRunnerOptions: { roleCatalog: reviewerCatalog() },
    })

    const result = await controller.run(new AbortController().signal)

    expect(result.run.status).toBe('completed')
    const latest = JSON.parse(await readFile(join(projectDir, '.meta-agent/auto_orch/plans/latest.json'), 'utf-8'))
    const dir = join(projectDir, '.meta-agent/auto_orch/plans', latest.planId, `v${String(latest.version).padStart(4, '0')}`)
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8'))
    await expect(readFile(join(dir, 'approved.plan.json'), 'utf-8')).resolves.toContain('"entry"')
    await expect(readFile(join(dir, 'materialized.plan.json'), 'utf-8')).resolves.toContain('"entry"')
    await expect(readFile(join(dir, 'runs.jsonl'), 'utf-8')).resolves.toContain('"status":"completed"')
    expect(manifest).toMatchObject({ approvedByUser: true, latestRunAt: expect.any(Number) })
  })

  it('drives a generate→verify→fix cycle and flows correctives via the blackboard', async () => {
    const captured: string[] = []
    const dispatcher = queueDispatcher([
      { summary: PLAN },
      { summary: 'attempt 1', success: true },         // gen
      { summary: '{"label":"fail","messages":["fix the null check"]}' }, // verify → fail → back to gen
      { summary: 'attempt 2', success: true },         // gen again (should see the corrective)
      { summary: '{"label":"pass","messages":[]}' },   // verify → pass
    ], captured)
    const controller = new AutoOrchController({ dispatcher, projectDir: '/tmp', getGoal: () => 'build X', nodeRunnerOptions: { roleCatalog: reviewerCatalog() } })
    const result = await controller.run(new AbortController().signal)
    expect(result.run.status).toBe('completed')
    expect(result.run.visitedPath).toEqual(['gen', 'verify', 'gen', 'verify'])

    // captured spawns: [planner, gen1, verify1, gen2, verify2]
    const gen1Task = captured[1]
    const gen2Task = captured[3]
    expect(gen1Task).not.toContain('fix the null check')      // first pass: no feedback yet
    expect(gen2Task).toContain('fix the null check')          // re-run: corrective injected
    expect(gen2Task).toContain('上一轮审查反馈')
    // surfaced in the summary
    expect(result.summary).toContain('审查纠偏轮数：1')
  })

  it('falls back to a single-executor plan when planning is unparsable, and still runs', async () => {
    const dispatcher = queueDispatcher([
      { summary: 'I could not plan' },                 // planner attempt 1 → unparsable
      { summary: 'still cannot plan' },                // planner attempt 2 (retry, maxAttempts=2) → unparsable → fallback
      { summary: 'did the work', success: true },      // execute
      { summary: '{"label":"pass","messages":[]}' },   // verify → real pass
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
    expect(first.note).toContain('auto_orch')

    // idempotent: a second pre_query does not re-run orchestration
    const second = await fn(event())
    expect(second.abort).toBeUndefined()
  })
})
