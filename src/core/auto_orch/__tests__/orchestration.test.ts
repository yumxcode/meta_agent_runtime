/**
 * End-to-end coverage for the EXECUTION half of (C): KernelNodeRunner mapping,
 * the AutoOrchController (Planner → PlanRunner → KernelNodeRunner) full run, and
 * the launch phase hook. A queue-backed stub dispatcher returns canned sub-agent
 * records so the whole pipeline runs deterministically without a live LLM.
 */
import { describe, it, expect } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord, SubAgentStatus } from '../../../subagent/types.js'
import { makeSubAgentTaskId } from '../../../subagent/types.js'
import { KernelNodeRunner, parseRoleVerdict } from '../KernelNodeRunner.js'
import { AutoOrchController, buildAutoOrchLaunchHooks } from '../AutoOrchController.js'
import { materializeCodeNodes } from '../CodeNodeAuthor.js'
import { loadAutoOrchPlan, saveApprovedAutoOrchPlan, saveMaterializedAutoOrchPlan } from '../PlanStore.js'
import { RoleCatalog } from '../RoleRegistry.js'
import { runReviewer } from '../reviewer.js'
import type { OrchNode } from '../LoopIR.js'
import type { PlanRunContext } from '../PlanRunner.js'
import type { PhaseHookEvent } from '../../../kernel/loop/PhaseHooks.js'
import type { AutoWorktreeCoordinator } from '../../auto/AutoWorktreeCoordinator.js'

const execFileAsync = promisify(execFile)

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

  it('lets auto_orch override executor maxTurns for saved plans', async () => {
    const captured: string[] = []
    const dispatcher = queueDispatcher([{ summary: 'built it', success: true }])
    const seenMaxTurns: number[] = []
    const wrapped: ISubAgentDispatcher = {
      async spawnSubAgent(opts) {
        seenMaxTurns.push(opts.config.maxTurns ?? -1)
        return dispatcher.spawnSubAgent(opts)
      },
      getStatus: dispatcher.getStatus,
      cancelTask: dispatcher.cancelTask,
    }
    const runner = new KernelNodeRunner(wrapped, { executorMaxTurns: 90 })

    const v = await runner.run({ ...exec, maxTurns: 12 }, ctx())

    expect(v).toMatchObject({ action: 'branch', label: 'ok' })
    expect(seenMaxTurns).toEqual([90])
    expect(captured).toHaveLength(0)
  })

  it('merges a successful isolated_write executor before routing forward', async () => {
    const merged: string[] = []
    const worktrees = {
      enabled: true,
      recordFor(taskId: string) {
        return { taskId, worktreePath: '/tmp/worktree' }
      },
      async finalize() {
        return { status: 'committed', changedFiles: ['src/app.ts'], commitHash: 'def456' }
      },
      async merge(taskId: string) {
        merged.push(taskId)
        return { merged: true, commitHash: 'abc123' }
      },
    } as unknown as AutoWorktreeCoordinator
    const runner = new KernelNodeRunner(
      queueDispatcher([{ summary: 'bootstrapped state', success: true, output: { label: 'ok' } }]),
      { worktrees },
    )

    const v = await runner.run(exec, ctx())

    expect(v).toMatchObject({ action: 'branch', label: 'ok' })
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatch(/^subtask-/)
  })

  it('syncs state-only isolated_write changes without git-merging the main tree', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'auto-orch-main-'))
    const worktreePath = await mkdtemp(join(tmpdir(), 'auto-orch-wt-'))
    await mkdir(join(worktreePath, 'state'), { recursive: true })
    await writeFile(join(worktreePath, 'state', 'progress.json'), '{"iteration":1}\n', 'utf-8')
    const calls: string[] = []
    const worktrees = {
      enabled: true,
      recordFor(taskId: string) {
        return { taskId, worktreePath }
      },
      async finalize(taskId: string) {
        calls.push(`finalize:${taskId}`)
        return { status: 'committed', changedFiles: ['state/progress.json'], commitHash: 'def456' }
      },
      async discard(taskId: string) {
        calls.push(`discard:${taskId}`)
      },
      async merge(taskId: string) {
        calls.push(`merge:${taskId}`)
        return { merged: true, commitHash: 'abc123' }
      },
    } as unknown as AutoWorktreeCoordinator
    const runner = new KernelNodeRunner(
      queueDispatcher([{ summary: 'bootstrapped state', success: true, output: { label: 'ok' } }]),
      { projectDir, worktrees },
    )

    const v = await runner.run(exec, ctx())

    expect(v).toMatchObject({ action: 'branch', label: 'ok' })
    await expect(readFile(join(projectDir, 'state', 'progress.json'), 'utf-8')).resolves.toBe('{"iteration":1}\n')
    expect(calls.some(c => c.startsWith('finalize:'))).toBe(true)
    expect(calls.some(c => c.startsWith('discard:'))).toBe(true)
    expect(calls.some(c => c.startsWith('merge:'))).toBe(false)
  })

  it('diffs committed worktree changes when finalize reports no changedFiles', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'auto-orch-main-'))
    const worktreePath = await mkdtemp(join(tmpdir(), 'auto-orch-wt-committed-'))
    await execFileAsync('git', ['init'], { cwd: worktreePath })
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktreePath })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: worktreePath })
    await writeFile(join(worktreePath, 'README.md'), 'base\n', 'utf-8')
    await execFileAsync('git', ['add', 'README.md'], { cwd: worktreePath })
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: worktreePath })
    const forkPoint = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })).stdout.trim()
    await mkdir(join(worktreePath, 'state'), { recursive: true })
    await writeFile(join(worktreePath, 'state', 'current_direction.json'), '{"id":"D1"}\n', 'utf-8')
    await execFileAsync('git', ['add', 'state/current_direction.json'], { cwd: worktreePath })
    await execFileAsync('git', ['commit', '-m', 'direction'], { cwd: worktreePath })

    const calls: string[] = []
    const worktrees = {
      enabled: true,
      recordFor(taskId: string) {
        return { taskId, worktreePath, forkPoint }
      },
      async finalize(taskId: string) {
        calls.push(`finalize:${taskId}`)
        return { status: 'already_committed', changedFiles: [], commitHash: 'def456' }
      },
      async discard(taskId: string) {
        calls.push(`discard:${taskId}`)
      },
      async merge(taskId: string) {
        calls.push(`merge:${taskId}`)
        return { merged: true, commitHash: 'abc123' }
      },
    } as unknown as AutoWorktreeCoordinator
    const runner = new KernelNodeRunner(
      queueDispatcher([{ summary: 'direction chosen', success: true, output: { label: 'ok' } }]),
      { projectDir, worktrees },
    )

    const v = await runner.run(exec, ctx())

    expect(v).toMatchObject({ action: 'branch', label: 'ok' })
    await expect(readFile(join(projectDir, 'state', 'current_direction.json'), 'utf-8')).resolves.toBe('{"id":"D1"}\n')
    expect(calls.some(c => c.startsWith('discard:'))).toBe(true)
    expect(calls.some(c => c.startsWith('merge:'))).toBe(false)
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

  it('retries code authoring after an unparsable author response', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'auto-orch-author-parse-retry-'))
    const source = 'export async function main(input, api) { return { action: "branch", label: "healthy", data: { at: api.nowIso } } }'
    const captured: string[] = []
    const dispatcher = queueDispatcher([
      { summary: 'I can do that, but here is prose instead of JSON.' },
      { summary: '```json\n' + JSON.stringify({ source, note: 'fixed format' }) + '\n```' },
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
    expect(captured[1]).toContain('no parseable source JSON')
  })

  it('batches multiple missing code nodes through one code_author spawn', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'auto-orch-author-batch-'))
    const sourceA = 'export async function main(input, api) { await api.state.writeJson("state/a.json", { ok: true }); return { action: "branch", label: "ok" } }'
    const sourceB = 'export async function main(input, api) { await api.state.writeJson("state/b.json", { ok: true }); return { action: "branch", label: "done" } }'
    const captured: string[] = []
    const dispatcher = queueDispatcher([{
      summary: '```json\n' + JSON.stringify({
        nodes: [
          { id: 'write_a', source: sourceA, note: 'writes a' },
          { id: 'write_b', source: sourceB, note: 'writes b' },
        ],
      }) + '\n```',
    }], captured)

    const out = await materializeCodeNodes({
      entry: 'write_a',
      nodes: [
        {
          id: 'write_a',
          kind: 'code',
          taskDescription: 'write a',
          codeSpec: { description: 'write state/a.json', outputs: ['state/a.json'], labels: ['ok'] },
        },
        {
          id: 'write_b',
          kind: 'code',
          taskDescription: 'write b',
          codeSpec: { description: 'write state/b.json', outputs: ['state/b.json'], labels: ['done'] },
        },
      ],
      edges: [],
    }, { dispatcher, projectDir }, new AbortController().signal)

    expect(out.errors).toHaveLength(0)
    expect(out.materialized).toBe(2)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toContain('write_a')
    expect(captured[0]).toContain('write_b')
    expect(out.plan.nodes[0].codeRef).toMatch(/^code_nodes\//)
    expect(out.plan.nodes[1].codeRef).toMatch(/^code_nodes\//)
  })

  it('materializes report writer code nodes with a deterministic built-in source', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'auto-orch-author-report-'))
    const dispatcher = queueDispatcher([])

    const out = await materializeCodeNodes({
      entry: 'attention_report_writer',
      nodes: [{
        id: 'attention_report_writer',
        kind: 'code',
        taskDescription: '生成需要人工干预的报告后停止',
        codeSpec: {
          description: 'Read progress and write an attention report.',
          inputs: ['state/progress.json'],
          outputs: ['state/attention_report.md'],
          labels: ['ok'],
        },
        capabilities: ['state.read', 'state.write'],
      }],
      edges: [],
    }, { dispatcher, projectDir }, new AbortController().signal)

    expect(out.errors).toHaveLength(0)
    expect(out.materialized).toBe(1)
    const codeRef = out.plan.nodes[0].codeRef
    expect(codeRef).toMatch(/^code_nodes\//)
    const source = await readFile(join(projectDir, '.meta-agent/auto_orch', codeRef!), 'utf-8')
    expect(source).toContain('Attention Required Report')
    expect(source).toContain('state/attention_report.md')
  })

  it('re-materializes saved code nodes when their local source artifact is missing', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'auto-orch-author-missing-artifact-'))
    const dispatcher = queueDispatcher([])

    const out = await materializeCodeNodes({
      entry: 'completion_report',
      nodes: [{
        id: 'completion_report',
        kind: 'code',
        taskDescription: '生成完成报告后停止',
        codeRef: 'code_node/missing.mjs',
        sourceHash: '0'.repeat(64),
        codeSpec: {
          description: 'Read progress and write a completion report.',
          inputs: ['state/progress.json'],
          outputs: ['state/completion_report.md'],
          labels: ['ok'],
        },
        capabilities: ['state.read', 'state.write'],
      }],
      edges: [],
    }, { dispatcher, projectDir }, new AbortController().signal)

    expect(out.errors).toHaveLength(0)
    expect(out.materialized).toBe(1)
    const codeRef = out.plan.nodes[0].codeRef
    expect(codeRef).toMatch(/^code_nodes\//)
    expect(codeRef).not.toBe('code_node/missing.mjs')
    await expect(readFile(join(projectDir, '.meta-agent/auto_orch', codeRef!), 'utf-8')).resolves.toContain('Completion Report')
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

const CODE_PLAN = '```json\n' + JSON.stringify({
  entry: 'compute_value',
  nodes: [{
    id: 'compute_value',
    kind: 'code',
    taskDescription: 'compute a deterministic value',
    codeSpec: { description: 'return ok after computing a deterministic value', labels: ['ok'] },
  }],
  edges: [],
}) + '\n```'

const FAILING_STATE_CODE_PLAN = '```json\n' + JSON.stringify({
  entry: 'write_then_fail',
  nodes: [{
    id: 'write_then_fail',
    kind: 'code',
    taskDescription: 'write process state, then fail',
    codeSpec: {
      description: 'write temporary process state and return an error verdict',
      outputs: ['state/progress.json', 'state/transient.txt'],
      labels: ['error'],
    },
    capabilities: ['state.write'],
  }],
  edges: [],
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

  it('cleans worktrees when graph setup exits early as invalid', async () => {
    const cleanupStrategies: string[] = []
    const controller = new AutoOrchController({
      dispatcher: queueDispatcher([
        { summary: CODE_PLAN },
        { summary: '', status: 'failed', success: false },
        { summary: '', status: 'failed', success: false },
        { summary: '', status: 'failed', success: false },
      ]),
      projectDir: '/tmp',
      getGoal: () => 'build X',
      worktreeCleanup: {
        strategy: 'safe',
        coordinator: {
          async cleanup(strategy: string) {
            cleanupStrategies.push(strategy)
          },
        } as unknown as AutoWorktreeCoordinator,
      },
    })

    const result = await controller.run(new AbortController().signal)

    expect(result.run.status).toBe('invalid')
    expect(cleanupStrategies).toEqual(['safe'])
  })

  it('restores process state files when graph execution fails', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'auto-orch-failed-state-'))
    await mkdir(join(projectDir, 'state'), { recursive: true })
    await writeFile(join(projectDir, 'state', 'progress.json'), '{"before":true}\n', 'utf-8')
    const source = `
export async function main(input, api) {
  await api.state.writeJson("state/progress.json", { before: false })
  await api.state.writeText("state/transient.txt", "temporary\\n")
  return { action: "branch", label: "error", note: "fail after writing state" }
}
`
    const controller = new AutoOrchController({
      dispatcher: queueDispatcher([
        { summary: FAILING_STATE_CODE_PLAN },
        { summary: '```json\n' + JSON.stringify({ source }) + '\n```' },
      ]),
      projectDir,
      getGoal: () => 'build X',
    })

    const result = await controller.run(new AbortController().signal)

    expect(result.run.status).toBe('failed')
    await expect(readFile(join(projectDir, 'state', 'progress.json'), 'utf-8')).resolves.toBe('{"before":true}\n')
    await expect(readFile(join(projectDir, 'state', 'transient.txt'), 'utf-8')).rejects.toThrow()
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

  it('repairs a saved materialized plan whose code artifact was deleted before execution', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'auto-orch-saved-missing-code-'))
    const stalePlan = {
      id: 'saved-missing-code',
      entry: 'completion_report',
      nodes: [{
        id: 'completion_report',
        kind: 'code' as const,
        taskDescription: '生成完成报告后停止',
        codeRef: 'code_node/missing.mjs',
        sourceHash: '0'.repeat(64),
        codeSpec: {
          description: 'Read progress and write a completion report.',
          inputs: ['state/progress.json'],
          outputs: ['state/completion_report.md'],
          labels: ['ok'],
        },
        capabilities: ['state.read', 'state.write'],
      }],
      edges: [],
    }
    const ref = await saveApprovedAutoOrchPlan(projectDir, {
      goal: 'run saved graph',
      plan: stalePlan,
      source: 'planner',
      approvedByUser: true,
    })
    await saveMaterializedAutoOrchPlan(projectDir, ref, stalePlan)

    const controller = new AutoOrchController({
      dispatcher: queueDispatcher([]),
      projectDir,
      getGoal: () => 'run saved graph',
      planRef: 'latest',
    })

    const result = await controller.run(new AbortController().signal)

    expect(result.planSource).toBe('saved')
    expect(result.run.status).toBe('completed')
    await expect(readFile(join(projectDir, 'state/completion_report.md'), 'utf-8')).resolves.toContain('Completion Report')
    const loaded = await loadAutoOrchPlan(projectDir, 'latest')
    const repairedRef = loaded?.plan.nodes[0].codeRef
    expect(repairedRef).toMatch(/^code_nodes\//)
    expect(repairedRef).not.toBe('code_node/missing.mjs')
    await expect(readFile(join(projectDir, '.meta-agent/auto_orch', repairedRef!), 'utf-8')).resolves.toContain('Completion Report')
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
