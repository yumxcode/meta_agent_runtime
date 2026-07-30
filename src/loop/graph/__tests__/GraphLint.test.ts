import { describe, expect, it } from 'vitest'
import { CANONICAL_GRAPH_DISTILL_EXAMPLE, lintLoopGraph, type LoopGraphSpec } from '../index.js'

function graph(): LoopGraphSpec {
  return {
    schemaVersion: 'graph-2.0', id: 'lint_fixture', version: 1, goal: 'Lint fixture.',
    state: { status: { type: { type: 'string' }, initial: 'healthy' } },
    lanes: {
      work: { context: 'persistent', workspace: { read: ['state'], write: [{ path: 'state', mode: 'owned' }], deny: [] } },
      review: { context: 'fresh_per_activation', workspace: { read: ['state'], write: [], deny: ['.git'] } },
    },
    nodes: {
      work: { type: 'agent', lane: 'work', prompt: 'Perform one bounded iteration.', tools: ['read_file'], budget: { turns: 20, usd: 5, wallTimeMs: 300_000 } },
      review: { type: 'agent', lane: 'review', prompt: 'Independently verify the completion candidate.', tools: ['read_file'], budget: { turns: 10, usd: 1, wallTimeMs: 300_000 } },
      done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
    },
    transitions: [
      // `status` is declared in state, so something has to maintain it —
      // otherwise dead-state-field (correctly) fires on the fixture itself.
      { id: 'candidate', from: 'work', to: 'review', updates: [{ target: 'status', reducer: 'builtin/set@1', args: { value: { literal: 'done' } } }] },
      { id: 'failed', from: 'work', on: 'failure', to: 'failed' },
      { id: 'verified', from: 'review', to: 'done' },
      { id: 'review_failed', from: 'review', on: 'failure', to: 'failed' },
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

  // A deny is an ownership boundary the design chose, so "add a write rule" is
  // the one repair that must NOT be suggested — it would install a second
  // writer and immediately trip lane-write-overlap or writer-boundary-bypass.
  it('separates a prompt write into a denied path from a merely undeclared one', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected agent')
    spec.lanes.work.workspace.write = [{ path: 'humanoid', mode: 'owned' }]
    spec.lanes.work.workspace.deny = ['.git', 'state']
    spec.lanes.writer = { context: 'persistent', workspace: { read: [], write: [{ path: 'state', mode: 'owned' }], deny: ['.git'] } }
    work.prompt = 'On the first round create state/ and write `state/progress.json`.'

    const denied = lintLoopGraph(spec).filter(f => f.rule === 'prompt-writes-denied-path')
    expect(denied.map(f => f.level)).toEqual(['error', 'error'])
    expect(denied[0]!.message).toContain("lane 'work' explicitly denies")
    // The owning lane is named, and widening is explicitly ruled out.
    expect(denied[0]!.message).toContain("lane 'writer' owns it")
    expect(denied[0]!.message).toContain('Do NOT add a write rule')
    // The same target must not also be reported as merely undeclared.
    expect(lintLoopGraph(spec).filter(f => f.rule === 'undeclared-workspace-write')).toEqual([])

    // Without the deny it is an ordinary undeclared write, and the message
    // offers both directions instead of only "declare it".
    spec.lanes.work.workspace.deny = ['.git']
    const undeclared = lintLoopGraph(spec).filter(f => f.rule === 'undeclared-workspace-write')
    expect(undeclared).toHaveLength(2)
    expect(undeclared[0]!.message).toContain('either add the write rule')
    expect(undeclared[0]!.message).toContain("delete the instruction and leave the write to the node on lane 'writer'")
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

  it('surfaces a work agent that signs its own business terminal but accepts an independent read-only reviewer', () => {
    const direct = graph()
    direct.transitions[0] = {
      id: 'done', from: 'work', on: 'success',
      when: '$output.complete == true', to: 'done',
      updates: [{ target: 'status', reducer: 'builtin/set@1', args: [{ literal: 'done' }] }],
    }
    const finding = lintLoopGraph(direct).find(item => item.rule === 'single-agent-terminal-authority')
    expect(finding?.level).toBe('warning')
    expect(finding?.message).toContain('independent read-only Agent')
    delete direct.transitions[0]!.when
    expect(lintLoopGraph(direct).map(item => item.rule)).toContain('single-agent-terminal-authority')

    const reviewed = structuredClone(direct)
    reviewed.lanes.review = {
      context: 'fresh_per_activation',
      workspace: { read: ['state'], write: [], deny: ['.git'] },
    }
    reviewed.nodes.review = {
      type: 'agent', lane: 'review', prompt: 'Independently review the completion candidate.',
      inputs: { candidate: { ref: '$input.candidate' } },
      outputSchema: {
        type: 'object', required: ['accepted'],
        properties: { accepted: { type: 'boolean' } },
        additionalProperties: false,
      },
      tools: ['read_file'],
      budget: { turns: 10, usd: 1, wallTimeMs: 300_000 },
    }
    reviewed.transitions[0] = {
      id: 'propose', from: 'work', on: 'success',
      when: '$output.complete == true',
      to: { node: 'review', inputs: { candidate: { ref: '$output' } } },
    }
    reviewed.transitions.push({
      id: 'verified', from: 'review', on: 'success',
      when: '$output.accepted == true', to: 'done',
    })
    expect(lintLoopGraph(reviewed).filter(item => item.rule === 'single-agent-terminal-authority')).toEqual([])
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

  // The strict $input-closure contract makes { "literal": null } the idiom for
  // "absent on THIS path" — and therefore an escape hatch: a compiler can
  // satisfy closure by nulling a field on every path, severing the dataflow
  // the source demanded (the F1 gate_evidence failure). All-paths-null is
  // exact, so it is deterministic lint, not semantic review.
  it('errors when every supplier binds an input to literal null', () => {
    const spec = graph()
    spec.nodes.check = {
      type: 'agent', lane: 'work', prompt: 'Verify the evidence before advancing.',
      tools: ['read_file'], budget: { turns: 10, usd: 5, wallTimeMs: 300_000 },
      inputs: { evidence: { ref: '$input.evidence' }, phase: { ref: '$input.phase' } },
    }
    spec.transitions.push({
      id: 'to_check', from: 'work', on: 'success',
      to: { node: 'check', inputs: { evidence: { literal: null }, phase: { literal: 'bootstrap' } } },
    })
    // `work` now has two success transitions; keep routing valid for realism.
    spec.transitions[0]!.when = '$state.status == \'healthy\''
    spec.transitions[0]!.priority = 100
    const dead = lintLoopGraph(spec).filter(f => f.rule === 'dead-null-input')
    expect(dead).toHaveLength(1)
    expect(dead[0]!.level).toBe('error')
    expect(dead[0]!.at).toBe('nodes.check.inputs.evidence')
    expect(dead[0]!.message).toContain("transition 'to_check'")

    // One real ref on ANY inbound edge is the legitimate optional-value idiom.
    spec.transitions.push({
      id: 'retry_check', from: 'check', on: 'failure',
      to: { node: 'check', inputs: { evidence: { ref: '$state.status' }, phase: { literal: null } } },
    })
    expect(lintLoopGraph(spec).filter(f => f.rule === 'dead-null-input')).toEqual([])
  })

  // Exact implication: the lower-priority edge repeats every condition of a
  // higher-priority one, so the higher one always wins first.
  it('blocks a route whose conditions are a superset of a higher-priority route', () => {
    const spec = graph()
    spec.state.count = { type: { type: 'integer', minimum: 0 }, initial: 0 }
    spec.transitions = [
      { id: 'broad', from: 'work', on: 'success', priority: 100, when: "$state.status == 'healthy'", to: 'done' },
      { id: 'narrow', from: 'work', on: 'success', priority: 90, when: "$state.status == 'healthy' && $state.count >= 3", to: 'done' },
      { id: 'fallback', from: 'work', on: 'success', default: true, to: 'done', updates: [{ target: 'status', reducer: 'builtin/set@1', args: [{ literal: 'done' }] }] },
      { id: 'counted', from: 'work', on: 'failure', to: 'failed', updates: [{ target: 'count', reducer: 'builtin/increment@1' }] },
    ]
    const shadowed = lintLoopGraph(spec).filter(f => f.rule === 'shadowed-route')
    expect(shadowed).toHaveLength(1)
    expect(shadowed[0]!.level).toBe('error')
    expect(shadowed[0]!.at).toBe("transitions 'narrow'.when")
    expect(shadowed[0]!.message).toContain("higher-priority transition 'broad'")

    // Raising the specific edge above the broad one resolves it.
    spec.transitions[0]!.priority = 90
    spec.transitions[1]!.priority = 100
    expect(lintLoopGraph(spec).filter(f => f.rule === 'shadowed-route')).toEqual([])
  })

  it('does not treat merely overlapping conditions as shadowing', () => {
    const spec = graph()
    spec.state.count = { type: { type: 'integer', minimum: 0 }, initial: 0 }
    spec.transitions = [
      { id: 'a', from: 'work', on: 'success', priority: 100, when: "$state.status == 'healthy'", to: 'done' },
      { id: 'b', from: 'work', on: 'success', priority: 90, when: '$state.count >= 3', to: 'done' },
      { id: 'fallback', from: 'work', on: 'success', default: true, to: 'done', updates: [{ target: 'status', reducer: 'builtin/set@1', args: [{ literal: 'done' }] }] },
      { id: 'counted', from: 'work', on: 'failure', to: 'failed', updates: [{ target: 'count', reducer: 'builtin/increment@1' }] },
    ]
    expect(lintLoopGraph(spec).filter(f => f.rule === 'shadowed-route')).toEqual([])
  })

  // A source-mandated bound is only enforced if its edge wins when the threshold
  // is met. An unproven overlap with a higher-priority looping edge is advisory.
  it('warns when a looping route can outrank a $state-threshold terminal route', () => {
    const spec = graph()
    spec.state.rounds = { type: { type: 'integer', minimum: 0 }, initial: 0 }
    spec.transitions = [
      { id: 'keep_going', from: 'work', on: 'success', priority: 100, when: "$state.status == 'healthy'", to: 'work' },
      { id: 'round_cap', from: 'work', on: 'success', priority: 90, when: '$state.rounds >= 20', to: 'done' },
      { id: 'fallback', from: 'work', on: 'success', default: true, to: 'work', updates: [{ target: 'rounds', reducer: 'builtin/increment@1' }, { target: 'status', reducer: 'builtin/set@1', args: [{ literal: 'healthy' }] }] },
      { id: 'boom', from: 'work', on: 'failure', to: 'failed' },
    ]
    const warned = lintLoopGraph(spec).filter(f => f.rule === 'terminal-route-shadowed')
    expect(warned).toHaveLength(1)
    expect(warned[0]!.level).toBe('warning')
    expect(warned[0]!.at).toBe("transitions 'round_cap'.when")
    expect(warned[0]!.message).toContain("'keep_going'")

    // A provably exclusive guard on the looping edge removes the warning.
    spec.transitions[0]!.when = "$state.status == 'healthy' && $state.rounds < 20"
    expect(lintLoopGraph(spec).filter(f => f.rule === 'terminal-route-shadowed')).toEqual([])

    // So does giving the bound the higher priority.
    spec.transitions[0]!.when = "$state.status == 'healthy'"
    spec.transitions[0]!.priority = 90
    spec.transitions[1]!.priority = 100
    expect(lintLoopGraph(spec).filter(f => f.rule === 'terminal-route-shadowed')).toEqual([])
  })

  // Only speaks when the conditional edges otherwise tile their own value space
  // and the uncovered pocket is small enough to enumerate; a broad default with
  // a large legitimate remainder must stay silent.
  it('reports a small truth-table pocket but stays quiet about a broad default', () => {
    const spec = graph()
    spec.state.count = { type: { type: 'integer', minimum: 0 }, initial: 0 }
    const edge = (id: string, priority: number, when: string) => ({ id, from: 'work', on: 'success' as const, priority, when, to: 'done' })
    // trend × count tiles fully except trend=='up' && count==2.
    spec.transitions = [
      edge('up_low', 140, "$output.trend == 'up' && $state.count < 2"),
      edge('flat_low', 130, "$output.trend == 'flat' && $state.count < 2"),
      edge('flat_high', 120, "$output.trend == 'flat' && $state.count >= 2"),
      edge('down_low', 110, "$output.trend == 'down' && $state.count < 2"),
      edge('down_high', 100, "$output.trend == 'down' && $state.count >= 2"),
      { id: 'fallback', from: 'work', on: 'success', default: true, to: 'done', updates: [{ target: 'count', reducer: 'builtin/increment@1' }, { target: 'status', reducer: 'builtin/set@1', args: [{ literal: 'done' }] }] },
      { id: 'boom', from: 'work', on: 'failure', to: 'failed' },
    ]
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected agent')
    work.outputSchema = { type: 'object', required: ['trend'], properties: { trend: { type: 'string' } }, additionalProperties: false }

    const gaps = lintLoopGraph(spec).filter(f => f.rule === 'route-partition-gap')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.level).toBe('warning')
    expect(gaps[0]!.message).toContain("$output.trend=up")
    expect(gaps[0]!.message).toContain("default 'fallback'")

    // Cover the pocket and the finding disappears.
    spec.transitions.splice(5, 0, edge('up_high', 105, "$output.trend == 'up' && $state.count >= 2"))
    expect(lintLoopGraph(spec).filter(f => f.rule === 'route-partition-gap')).toEqual([])
  })

  it('does not confuse empty-string or false constants with severed dataflow', () => {
    const spec = graph()
    spec.nodes.writer = {
      type: 'agent', lane: 'work', prompt: 'Persist the round.',
      tools: ['read_file'], budget: { turns: 10, usd: 5, wallTimeMs: 300_000 },
      inputs: { summary: { ref: '$input.summary' }, pivot: { ref: '$input.pivot' } },
    }
    spec.transitions.push({
      id: 'to_writer', from: 'work', on: 'success',
      to: { node: 'writer', inputs: { summary: { literal: '' }, pivot: { literal: false } } },
    })
    spec.transitions[0]!.when = '$state.status == \'healthy\''
    spec.transitions[0]!.priority = 100
    expect(lintLoopGraph(spec).filter(f => f.rule === 'dead-null-input')).toEqual([])
  })
})
