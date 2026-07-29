import { describe, expect, it } from 'vitest'
import { CANONICAL_GRAPH_DISTILL_EXAMPLE, lintLoopGraph, type LoopGraphSpec } from '../index.js'

function graph(): LoopGraphSpec {
  return {
    schemaVersion: 'graph-2.0', id: 'lint_fixture', version: 1, goal: 'Lint fixture.',
    state: { status: { type: { type: 'string' }, initial: 'healthy' } },
    lanes: {
      work: { context: 'persistent', workspace: { read: ['state'], write: [{ path: 'state', mode: 'owned' }], deny: [] } },
    },
    nodes: {
      work: { type: 'agent', lane: 'work', prompt: 'Perform one bounded iteration.', tools: ['read_file'], budget: { turns: 20, usd: 5, wallTimeMs: 300_000 } },
      done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
    },
    transitions: [
      // `status` is declared in state, so something has to maintain it —
      // otherwise dead-state-field (correctly) fires on the fixture itself.
      { id: 'done', from: 'work', to: 'done', updates: [{ target: 'status', reducer: 'builtin/set@1', args: { value: { literal: 'done' } } }] },
      { id: 'failed', from: 'work', on: 'failure', to: 'failed' },
    ],
    entrypoints: [{ id: 'start', node: 'work' }], limits: { maxActivations: 10 },
  }
}

describe('graph write-surface lint', () => {
  it('keeps the canonical example and a clean fixture lint-free', () => {
    expect(lintLoopGraph(CANONICAL_GRAPH_DISTILL_EXAMPLE)).toEqual([])
    expect(lintLoopGraph(graph())).toEqual([])
  })

  it('requires every agent node to declare budget.wallTimeMs >= the 5-minute floor', () => {
    // Missing budget entirely.
    const missing = graph()
    const missingWork = missing.nodes.work
    if (missingWork.type !== 'agent') throw new Error('expected agent')
    delete missingWork.budget
    expect(lintLoopGraph(missing).filter(f => f.rule === 'agent-budget-walltime').map(f => f.level)).toEqual(['error'])

    // Present but below the floor.
    const tooSmall = graph()
    const tooSmallWork = tooSmall.nodes.work
    if (tooSmallWork.type !== 'agent') throw new Error('expected agent')
    tooSmallWork.budget = { turns: 20, usd: 5, wallTimeMs: 299_999 }
    expect(lintLoopGraph(tooSmall).filter(f => f.rule === 'agent-budget-walltime').map(f => f.level)).toEqual(['error'])

    // Exactly the floor is accepted (inclusive).
    const atFloor = graph()
    const atFloorWork = atFloor.nodes.work
    if (atFloorWork.type !== 'agent') throw new Error('expected agent')
    atFloorWork.budget = { turns: 20, usd: 5, wallTimeMs: 300_000 }
    expect(lintLoopGraph(atFloor).filter(f => f.rule === 'agent-budget-walltime')).toEqual([])
  })

  it('flags prompts that direct writes outside the project (the X1 v3 failure)', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected agent')
    work.prompt = 'Locate the F1 git work tree (outside this project — search common locations). Edit training code, then git commit and push.'
    const findings = lintLoopGraph(spec)
    expect(findings.map(f => f.rule)).toContain('outside-project-write')
    // git ops with an owned prefix present downgrade to the nested-repo reminder.
    expect(findings.find(f => f.rule === 'git-without-capability')?.level).toBe('warning')
  })

  it('does not flag prompts that merely FORBID writing outside the project', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected agent')
    work.prompt = 'Edit files under state/. Never write outside this project.'
    expect(lintLoopGraph(spec).filter(f => f.rule === 'outside-project-write')).toEqual([])
  })

  it('flags absolute and home paths used as prompt targets', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected agent')
    work.prompt = 'Write results into /Users/yumx/code/F1_locomotion/out.json'
    expect(lintLoopGraph(spec).map(f => f.rule)).toContain('absolute-path')
    work.prompt = 'Wait ~30 minutes between checks, then update state/progress.json'
    expect(lintLoopGraph(spec)).toEqual([])
  })

  it('flags git mutations on a lane with neither scm nor an owned prefix', () => {
    const spec = graph()
    spec.lanes.work.workspace.write = [{ path: 'state/progress.json', mode: 'atomic_replace' }]
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected agent')
    work.prompt = 'Implement the change, then git commit and git push.'
    const finding = lintLoopGraph(spec).find(f => f.rule === 'git-without-capability')
    expect(finding?.level).toBe('error')
  })

  it('blocks explicit prompt writes not covered by the Agent lane', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected agent')
    spec.lanes.work.workspace.write = [{ path: 'humanoid', mode: 'owned' }]
    work.prompt = 'Write initial `state/progress.json`, then create artifacts under `.oma/experiments/exp-<N>/`.'
    const findings = lintLoopGraph(spec).filter(f => f.rule === 'undeclared-workspace-write')
    expect(findings.map(f => f.message)).toEqual([
      expect.stringContaining("'state/progress.json'"),
      expect.stringContaining("'.oma/experiments/exp-'"),
    ])

    spec.lanes.work.workspace.write.push({ path: 'state', mode: 'owned' }, { path: '.oma/experiments', mode: 'owned' })
    expect(lintLoopGraph(spec).filter(f => f.rule === 'undeclared-workspace-write')).toEqual([])
  })

  it('recognizes plain directory write targets without relying on Markdown backticks', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected agent')
    spec.lanes.work.workspace.write = []
    work.prompt = 'If this is the first run, create state/ and logs/ directories and write state/progress.json.'
    const findings = lintLoopGraph(spec).filter(f => f.rule === 'undeclared-workspace-write')
    expect(findings.map(f => f.message)).toEqual([
      expect.stringContaining("'state'"),
      expect.stringContaining("'logs'"),
      expect.stringContaining("'state/progress.json'"),
    ])
  })

  it('does not treat an explicit prohibition as a write instruction', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected agent')
    spec.lanes.work.workspace.write = []
    work.prompt = 'Do not write `state/progress.json`; return routing facts only.'
    expect(lintLoopGraph(spec).filter(f => f.rule === 'undeclared-workspace-write')).toEqual([])
    work.prompt = '绝不修改 `humanoid/**` 或 `.oma/experiments/` 下的文件。'
    expect(lintLoopGraph(spec).filter(f => f.rule === 'undeclared-workspace-write')).toEqual([])
  })

  it('does not apply a write verb to a read-only path in the next sentence', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected agent')
    spec.lanes.work.workspace.write = [{ path: 'state/task_spec.md', mode: 'atomic_replace' }]
    work.prompt = 'First create state/task_spec.md if absent. Use the inherited baseline from .oma/loop-history.md.'
    expect(lintLoopGraph(spec).filter(f => f.rule === 'undeclared-workspace-write')).toEqual([])
  })

  it('flags routing on agent-precomputed booleans and dead literal routes', () => {
    const spec = graph()
    spec.transitions = [
      { id: 'stale', from: 'work', when: '$output.is_stale == true', priority: 10, to: 'done', updates: [{ target: 'status', reducer: 'builtin/set@1', args: [{ literal: 'stale' }] }] },
      { id: 'done', from: 'work', default: true, to: 'done' },
      { id: 'dead', from: 'work', when: "$state.status == 'error'", priority: 20, to: 'failed' },
      { id: 'failed', from: 'work', on: 'failure', to: 'failed' },
    ]
    const rules = lintLoopGraph(spec).map(f => f.rule)
    expect(rules).toContain('precomputed-routing')
    expect(rules).toContain('dead-literal-route')
  })

  it('blocks duplicate deterministic predicates that shadow later routes', () => {
    const spec = graph()
    spec.transitions = [
      { id: 'attention', from: 'work', on: 'success', when: "$output.count == 0 || $output.trend == 'worsened'", priority: 30, to: 'failed' },
      { id: 'pivot', from: 'work', when: "  $output.count == 0   || $output.trend == 'worsened'  ", priority: 20, to: 'done' },
      { id: 'failed', from: 'work', on: 'failure', to: 'failed' },
    ]
    const finding = lintLoopGraph(spec).find(f => f.rule === 'duplicate-route-condition')
    expect(finding?.level).toBe('error')
    expect(finding?.message).toContain("transition 'attention'")

    spec.transitions[1]!.when = "$state.status == 'stale' && ($output.count == 0 || $output.trend == 'worsened')"
    expect(lintLoopGraph(spec).filter(f => f.rule === 'duplicate-route-condition')).toEqual([])
  })

  it('asks semantic review to justify multiple Agents sharing one persistent session', () => {
    const spec = graph()
    spec.nodes.pivot = { type: 'agent', lane: 'work', prompt: 'Perform a pivot phase.', tools: ['read_file'] }
    const finding = lintLoopGraph(spec).find(f => f.rule === 'same-lane-agent-split')
    expect(finding?.level).toBe('warning')
    expect(finding?.message).toContain('work, pivot')

    spec.lanes.work!.context = 'fresh_per_activation'
    expect(lintLoopGraph(spec).filter(f => f.rule === 'same-lane-agent-split')).toEqual([])
  })

  it('warns when a bounded graph can wait forever but permits intentional continuous waits', () => {
    const spec = graph()
    spec.nodes.work = { type: 'wait', wait: { kind: 'event', event: 'next' } }
    spec.transitions = [
      { id: 'next', from: 'work', on: 'event', to: 'done' },
      { id: 'failed', from: 'work', on: 'failure', to: 'failed' },
    ]
    expect(lintLoopGraph(spec).map(f => f.rule)).toContain('unbounded-wait')
    spec.limits = { maxLiveActivations: 1 }
    expect(lintLoopGraph(spec).filter(f => f.rule === 'unbounded-wait')).toEqual([])
  })

  it('warns when commit_latest mixes fresh State with stale-snapshot Agent output', () => {
    const spec = graph()
    spec.concurrency = { maxActivations: 2, stateConsistency: 'commit_latest' }
    spec.transitions[0]!.when = '$state.status == $output.observed_status'
    expect(lintLoopGraph(spec).map(f => f.rule)).toContain('mixed-snapshot-routing')
    spec.concurrency.stateConsistency = 'serializable'
    expect(lintLoopGraph(spec).filter(f => f.rule === 'mixed-snapshot-routing')).toEqual([])
  })

  it('warns about static Effect idempotency keys inside a cycle', () => {
    const spec = graph()
    spec.nodes.work = { type: 'effect', effect: 'test/effect@1', timeoutMs: 1000, idempotencyKey: { literal: 'same-key' } }
    spec.transitions = [
      { id: 'again', from: 'work', to: 'work' },
      { id: 'failed', from: 'work', on: 'failure', to: 'failed' },
    ]
    expect(lintLoopGraph(spec).map(f => f.rule)).toContain('static-effect-idempotency')
  })

  it('warns when fan-out can terminate globally before joining siblings', () => {
    const spec = graph()
    spec.nodes.other = { type: 'terminal', status: 'done' }
    spec.transitions[0]!.to = ['done', 'other']
    expect(lintLoopGraph(spec).map(f => f.rule)).toContain('terminal-fanout-cancellation')
  })

  // Moved out of the semantic reviewer's prose contract: a prefix comparison is
  // deterministic, so re-deriving it from an LLM sample only added variance.
  it('errors when two lanes claim overlapping write prefixes', () => {
    const spec = graph()
    spec.lanes.writer = { context: 'persistent', workspace: { read: [], write: [{ path: 'state/progress.md', mode: 'append_only' }], deny: [] } }
    const overlap = lintLoopGraph(spec).filter(f => f.rule === 'lane-write-overlap')
    expect(overlap).toHaveLength(1)
    expect(overlap[0]!.level).toBe('error')
    expect(overlap[0]!.message).toContain('only one owning Lane')

    // Disjoint prefixes are the normal single-writer shape and stay clean.
    spec.lanes.writer.workspace.write = [{ path: 'logs/run.md', mode: 'append_only' }]
    expect(lintLoopGraph(spec).filter(f => f.rule === 'lane-write-overlap')).toEqual([])
  })

  it('warns about mkdir for a directory the lane already covers', () => {
    const spec = graph()
    spec.nodes.work = {
      ...spec.nodes.work,
      prompt: 'Run `mkdir -p state/history` before the first write.',
    } as typeof spec.nodes.work
    const findings = lintLoopGraph(spec).filter(f => f.rule === 'redundant-mkdir')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.level).toBe('warning')

    // An uncovered path is a genuine workspace gap, reported by the existing
    // write-surface rules rather than as a redundant mkdir.
    spec.nodes.work = { ...spec.nodes.work, prompt: 'Run `mkdir -p elsewhere/tmp` first.' } as typeof spec.nodes.work
    expect(lintLoopGraph(spec).filter(f => f.rule === 'redundant-mkdir')).toEqual([])
  })

  it('keeps the canonical distill example free of the new deterministic rules', () => {
    const rules = lintLoopGraph(CANONICAL_GRAPH_DISTILL_EXAMPLE).map(f => f.rule)
    expect(rules).not.toContain('lane-write-overlap')
    expect(rules).not.toContain('redundant-mkdir')
    expect(rules).not.toContain('dead-state-field')
  })

  // A counter the source asked for but no Reducer maintains is frozen at its
  // initial value, which silently makes every threshold on it unreachable.
  it('errors on state fields no transition ever updates', () => {
    const spec = graph()
    spec.state.iteration = { type: { type: 'integer', minimum: 0 }, initial: 0 }
    const dead = lintLoopGraph(spec).filter(f => f.rule === 'dead-state-field')
    expect(dead).toHaveLength(1)
    expect(dead[0]!.level).toBe('error')
    expect(dead[0]!.at).toBe('state.iteration')

    spec.transitions[1]!.updates = [{ target: 'iteration', reducer: 'builtin/increment@1' }]
    expect(lintLoopGraph(spec).filter(f => f.rule === 'dead-state-field')).toEqual([])
  })
})
