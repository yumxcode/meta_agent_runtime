import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { runLoopCli } from '../../cli.js'
import { prepareAndClaim, runClaimedWake, tickOnce } from '../../runner.js'
import { HostSchedulerCoordinator } from '../../host/HostSchedulerCoordinator.js'
import { ensureWorkspaceIdentity } from '../../workspace/WorkspaceIdentity.js'
import { WakeStore } from '../../wake/WakeStore.js'
import { createDefaultGraphRuntimeCatalog, GraphStore } from '../index.js'
import type { GraphAgentExecutor, GraphDistillExecutor, GraphProgressEvent, LoopGraphSpec } from '../index.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const unusedGraphAgent: GraphAgentExecutor = {
  id: 'test/unused-graph-agent@1',
  async execute() { throw new Error('pure graph should not execute a Graph Agent') },
}

function graph(): LoopGraphSpec {
  return {
    schemaVersion: 'graph-1.0', id: 'cli-graph', version: 1, goal: 'CLI graph',
    state: {}, lanes: {},
    nodes: {
      calculate: { type: 'function', function: 'builtin/identity@1', inputs: { answer: { literal: 42 } } },
      done: { type: 'terminal', status: 'done', result: { ref: '$input.value' } },
    },
    transitions: [
      { id: 'finish', from: 'calculate', to: { node: 'done', inputs: { value: { ref: '$output' } } } },
      { id: 'calculate-failed', from: 'calculate', on: 'failure', to: 'done' },
    ],
    entrypoints: [{ id: 'start', node: 'calculate' }],
    limits: { maxActivations: 4 },
  }
}

function timerGraph(): LoopGraphSpec {
  return {
    schemaVersion: 'graph-1.0', id: 'cli-timer', version: 1, goal: 'Repair a missing durable wake',
    state: {}, lanes: {},
    nodes: {
      wait: { type: 'wait', wait: { kind: 'timer', delayMs: { literal: 100 }, maxDelayMs: 1_000 } },
      done: { type: 'terminal', status: 'done' },
    },
    transitions: [
      { id: 'elapsed', from: 'wait', on: 'timer', to: 'done' },
      { id: 'wait-failed', from: 'wait', on: 'failure', to: 'done' },
    ],
    entrypoints: [{ id: 'start', node: 'wait' }],
    limits: { maxActivations: 4, maxPendingTimers: 1 },
  }
}

function pausedGraph(): LoopGraphSpec {
  return {
    schemaVersion: 'graph-1.0', id: 'cli-paused', version: 1, goal: 'Resume a graph-authored pause',
    state: {}, lanes: {}, nodes: {
      before: { type: 'function', function: 'builtin/identity@1' },
      pause: { type: 'terminal', status: 'paused' },
      after: { type: 'function', function: 'builtin/identity@1' },
      done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
    }, transitions: [
      { id: 'pause', from: 'before', to: 'pause' }, { id: 'before-failed', from: 'before', on: 'failure', to: 'failed' },
      { id: 'resume', from: 'pause', on: 'resume', to: 'after' },
      { id: 'done', from: 'after', to: 'done' }, { id: 'after-failed', from: 'after', on: 'failure', to: 'failed' },
    ], entrypoints: [{ id: 'start', node: 'before' }], limits: { maxActivations: 6 },
  }
}

describe('durable graph CLI and shared scheduler', () => {
  it('distills through the foreground executor without requiring a SubAgent dispatcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-cli-distill-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Create a deterministic loop.', 'utf8')
    const outputs: unknown[] = [
      { graph: graph(), taskSpec: 'Foreground compiler output.' },
      { accepted: true, issues: [] },
    ]
    const phases: string[] = []
    const prompts: string[] = []
    const executor: GraphDistillExecutor = {
      async execute(request) {
        phases.push(request.phase)
        prompts.push(request.taskDescription)
        return { status: 'completed', output: outputs.shift() }
      },
    }

    const result = await runLoopCli(['distill', 'requirements.md', '--out', 'compiled.json'], {
      projectDir: root,
      distillExecutor: executor,
    })

    expect(result).toContain('compiled.json')
    expect(phases).toEqual(['compiler', 'semantic_review'])
    expect(prompts[0]).toContain('用户的 Loop 需求是：requirements.md')
    expect(prompts[0]).toContain(`项目地址是：${root}`)
    expect(prompts[0]).not.toContain('Create a deterministic loop.')
    expect(prompts[1]).not.toContain('Create a deterministic loop.')
    expect(JSON.parse(await readFile(join(root, 'compiled.json'), 'utf8'))).toMatchObject({ id: 'cli-graph' })
    expect(await readFile(join(root, 'loop.graph.review.md'), 'utf8')).toBe('Foreground compiler output.')
  })

  it('resumes a graph-authored paused Terminal through its durable resume edge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-cli-paused-'))
    roots.push(root)
    await writeFile(join(root, 'loop.json'), JSON.stringify(pausedGraph()), 'utf8')
    await runLoopCli(['create', 'loop.json', '--id', 'graph-paused'], { projectDir: root })
    await tickOnce({ projectDir: root, graphAgent: unusedGraphAgent })
    expect((await tickOnce({ projectDir: root, graphAgent: unusedGraphAgent })).outcomes[0]?.graphOutcome?.instance.status).toBe('paused')
    expect(await runLoopCli(['resume', 'graph-paused'], { projectDir: root })).toContain('status: active')
    await tickOnce({ projectDir: root, graphAgent: unusedGraphAgent })
    expect((await tickOnce({ projectDir: root, graphAgent: unusedGraphAgent })).outcomes[0]?.graphOutcome?.instance.status).toBe('done')
  })

  it('auto-detects graph create, routes wakes through GraphKernel, and inspects state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-cli-'))
    roots.push(root)
    await writeFile(join(root, 'loop.json'), JSON.stringify(graph()), 'utf8')
    const created = await runLoopCli(['create', 'loop.json', '--id', 'graph-one'], { projectDir: root })
    expect(created).toContain('durable-graph-v1')

    const progress: GraphProgressEvent[] = []
    const first = await tickOnce({ projectDir: root, graphAgent: unusedGraphAgent, onGraphProgress: event => progress.push(event) })
    expect(first.outcomes[0]?.graphOutcome?.committed).toBe(1)
    const second = await tickOnce({ projectDir: root, graphAgent: unusedGraphAgent, onGraphProgress: event => progress.push(event) })
    expect(second.outcomes[0]?.graphOutcome?.instance.status).toBe('done')
    expect(progress.map(event => event.type)).toEqual([
      'phase_started', 'phase_completed', 'phase_started', 'phase_completed',
    ])

    const listed = await runLoopCli(['list'], { projectDir: root })
    expect(listed).toContain('graph-one  done')
    expect(listed).toContain('engine=durable-graph-v1')
    const inspected = await runLoopCli(['inspect', 'graph-one'], { projectDir: root })
    expect(inspected).toContain('status: done')
    expect(inspected).toContain('durable-graph-v1')
    expect(inspected).toContain('recent phase results: 2')
    expect(inspected).toContain('Function builtin/identity@1 ended with outcome success')
  })

  it('derives operator views and archives only a quiescent terminal instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-cli-operator-'))
    roots.push(root)
    await writeFile(join(root, 'loop.json'), JSON.stringify(graph()), 'utf8')
    await runLoopCli(['create', 'loop.json', '--id', 'operator-one'], { projectDir: root })
    await expect(runLoopCli(['archive', 'operator-one'], { projectDir: root })).rejects.toThrow(/non-terminal/)
    await tickOnce({ projectDir: root, graphAgent: unusedGraphAgent })
    await tickOnce({ projectDir: root, graphAgent: unusedGraphAgent })

    expect(await runLoopCli(['timeline', 'operator-one', '--limit', '10'], { projectDir: root }))
      .toContain('activation_committed')
    expect(await runLoopCli(['files', 'operator-one'], { projectDir: root }))
      .toContain('graph declares no workspace files or records')
    expect(await runLoopCli(['disk', 'operator-one'], { projectDir: root }))
      .toContain('lane worktrees: 0B')

    const archived = await runLoopCli(['archive', 'operator-one'], { projectDir: root })
    expect(archived).toContain('archived to')
    expect(await runLoopCli(['inspect', 'operator-one'], { projectDir: root })).toContain('not found')
    expect(await runLoopCli(['gc', '--older-than-days', '1', '--include-archives'], { projectDir: root }))
      .toContain('dry-run')
  })

  it('requeues a claimed wake when host admission is interrupted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-cli-abort-'))
    roots.push(root)
    await writeFile(join(root, 'loop.json'), JSON.stringify(graph()), 'utf8')
    await runLoopCli(['create', 'loop.json', '--id', 'graph-abort'], { projectDir: root })
    const claimed = await prepareAndClaim({ projectDir: root, graphAgent: unusedGraphAgent }, Date.now(), 1)
    const abort = new AbortController()
    abort.abort(new Error('scheduler stopping'))
    const outcome = await runClaimedWake({
      projectDir: root,
      graphAgent: unusedGraphAgent,
      signal: abort.signal,
      hostCoordinator: new HostSchedulerCoordinator({ rootDir: join(root, 'host') }),
      workspaceIdentity: await ensureWorkspaceIdentity(root),
    }, claimed.wakeStore, claimed.wakes[0]!)
    expect(outcome.error).toContain('interrupted')
    expect((await claimed.wakeStore.list())[0]?.status).toBe('pending')
    expect((await new GraphStore(root, 'graph-abort').snapshot()).instance.status).toBe('active')
  })

  it('backs off an unclassified transient graph error without failing the instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-cli-transient-'))
    roots.push(root)
    await writeFile(join(root, 'loop.json'), JSON.stringify(graph()), 'utf8')
    await runLoopCli(['create', 'loop.json', '--id', 'graph-transient'], { projectDir: root })
    const claimed = await prepareAndClaim({ projectDir: root, graphAgent: unusedGraphAgent }, Date.now(), 1)
    const catalog = createDefaultGraphRuntimeCatalog()
    catalog.functions.get = (() => { throw new Error('temporary capability registry I/O outage') }) as typeof catalog.functions.get

    const outcome = await runClaimedWake({
      projectDir: root,
      graphAgent: unusedGraphAgent,
      graphCatalog: catalog,
    }, claimed.wakeStore, claimed.wakes[0]!)

    expect(outcome.error).toContain('graph tick retry 1/5')
    const wake = (await claimed.wakeStore.list()).find(item => item.wakeId === claimed.wakes[0]!.wakeId)!
    expect(wake.status).toBe('pending')
    expect(wake.fireAt).toBeGreaterThan(Date.now())
    expect((await new GraphStore(root, 'graph-transient').snapshot()).instance.status).toBe('active')
  })

  it('reconstructs a missing timer wake from the waiting Activation projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-cli-wake-repair-'))
    roots.push(root)
    await writeFile(join(root, 'loop.json'), JSON.stringify(timerGraph()), 'utf8')
    await runLoopCli(['create', 'loop.json', '--id', 'graph-wake-repair'], { projectDir: root })
    expect((await tickOnce({ projectDir: root, graphAgent: unusedGraphAgent })).outcomes[0]?.graphOutcome?.parked).toBe(1)

    const wakeStore = new WakeStore(root)
    const pending = (await wakeStore.list()).find(wake => wake.status === 'pending' && wake.activationId !== '__graph__')!
    await rm(join(root, '.loop', 'wakes', `${pending.wakeId}.json`))
    const activation = [...(await new GraphStore(root, 'graph-wake-repair').snapshot()).activations.values()]
      .find(item => item.nodeId === 'wait')!

    const repaired = await prepareAndClaim({ projectDir: root, graphAgent: unusedGraphAgent }, Date.now() + 10_000, 1)
    expect(repaired.wakes).toHaveLength(1)
    expect(repaired.wakes[0]?.activationId).toBe(activation.id)
  })
})
