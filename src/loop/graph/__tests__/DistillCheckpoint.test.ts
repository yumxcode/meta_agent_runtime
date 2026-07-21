import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SEMANTIC_REVIEW_LAYERS,
  createDefaultGraphRuntimeCatalog,
  createFileDistillCheckpointStore,
  distillLoopGraph,
  type GraphDistillExecutor,
  type LoopBlueprint,
  type LoopConstraintLedger,
  type LoopGraphSpec,
} from '../index.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const constraints: LoopConstraintLedger = {
  schemaVersion: 'loop-constraints-2.0', goal: 'Resume compilation.', unresolved: [],
  constraints: [{ id: 'C1', kind: 'goal', statement: 'Resume compilation.', strength: 'hard', sources: [{ path: 'requirements.md', locator: 'line 1' }] }],
}
const design: LoopBlueprint = {
  schemaVersion: 'loop-blueprint-2.0', goal: constraints.goal, intent: 'Resume a bounded compiler.',
  successCriteria: ['The graph terminates.'], workspace: [], lanes: [],
  control: ['Run one deterministic function and terminate.'], assumptions: [], capabilityGaps: [],
}
const graph: LoopGraphSpec = {
  schemaVersion: 'graph-2.0', id: 'resumed', version: 1, goal: constraints.goal,
  state: {}, lanes: {},
  nodes: { work: { type: 'function', function: 'builtin/identity@1' }, done: { type: 'terminal', status: 'done' } },
  transitions: [{ id: 'done', from: 'work', to: 'done' }, { id: 'failed', from: 'work', on: 'failure', to: 'done' }],
  entrypoints: [{ id: 'start', node: 'work' }], limits: { maxActivations: 3 },
}
const review = {
  schemaVersion: 'loop-semantic-review-2.1', accepted: true, issues: [], warnings: [],
  layers: Object.fromEntries(SEMANTIC_REVIEW_LAYERS.map(layer => [layer, {
    status: 'pass', issues: [], evidence: [{ sourceRefs: ['requirements.md:line 1'], designRefs: ['intent'], graphRefs: ['/goal'], statement: 'Aligned.' }],
  }])),
}

function rejectedReview(
  issue: string,
  failedLayer: typeof SEMANTIC_REVIEW_LAYERS[number] = 'workspace_contract',
): typeof review {
  const layers = Object.fromEntries(SEMANTIC_REVIEW_LAYERS.map(layer => [layer, {
    status: layer === failedLayer ? 'fail' : 'pass',
    issues: layer === failedLayer ? [issue] : [],
    evidence: [{ sourceRefs: ['requirements.md:line 1'], designRefs: ['workspace'], graphRefs: ['/lanes'], statement: layer === failedLayer ? issue : 'Aligned.' }],
  }]))
  return { ...review, accepted: false, layers, issues: [issue] }
}

describe('Distill Architect checkpoint', () => {
  it('resumes a source-matched contract and clears it only after full success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-checkpoint-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Resume compilation.', 'utf8')
    const source = { projectDir: root, requirement: 'requirements.md' }
    const checkpoint = createFileDistillCheckpointStore(root)
    await checkpoint.save(source, { constraints, design })
    const phases: string[] = []
    const policies: Array<Pick<Parameters<GraphDistillExecutor['execute']>[0], 'phase' | 'thinkingBudgetTokens' | 'maxOutputTokens' | 'maxWallTimeMs' | 'maxTurns' | 'maxBudgetUsd'>> = []
    const executor: GraphDistillExecutor = {
      async execute(request) {
        phases.push(request.phase)
        policies.push({
          phase: request.phase,
          thinkingBudgetTokens: request.thinkingBudgetTokens,
          maxOutputTokens: request.maxOutputTokens,
          maxWallTimeMs: request.maxWallTimeMs,
          maxTurns: request.maxTurns,
          maxBudgetUsd: request.maxBudgetUsd,
        })
        if (request.phase === 'compiler') return { status: 'completed', output: {
          graph,
          traceability: { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] },
          taskSpec: 'resumed',
        } }
        return { status: 'completed', output: review }
      },
    }
    const result = await distillLoopGraph(source, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), checkpoint,
    })
    expect(phases).toEqual(['compiler', 'semantic_review'])
    expect(policies).toEqual([
      { phase: 'compiler', thinkingBudgetTokens: 0, maxOutputTokens: 49_152, maxWallTimeMs: 1_200_000, maxTurns: 30, maxBudgetUsd: 10 },
      { phase: 'semantic_review', thinkingBudgetTokens: 0, maxOutputTokens: 16_384, maxWallTimeMs: 1_200_000, maxTurns: 30, maxBudgetUsd: 10 },
    ])
    expect(result.phaseAttempts).toMatchObject({ architect: 0, compiler: 1, reviewer: 1 })
    expect(await checkpoint.load(source)).toBeNull()
  })

  it('invalidates the checkpoint when the requirement changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-checkpoint-stale-'))
    roots.push(root)
    const source = { projectDir: root, requirement: 'requirements.md' }
    await writeFile(join(root, 'requirements.md'), 'Version one.', 'utf8')
    const checkpoint = createFileDistillCheckpointStore(root)
    await checkpoint.save(source, { constraints, design })
    await writeFile(join(root, 'requirements.md'), 'Version two.', 'utf8')
    expect(await checkpoint.load(source)).toBeNull()
  })

  it('revisits Architect once only after an intent-contract rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-semantic-revision-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Resume compilation.', 'utf8')
    const phases: string[] = []
    const limits: Array<Pick<Parameters<GraphDistillExecutor['execute']>[0], 'phase' | 'maxTurns' | 'maxBudgetUsd' | 'maxWallTimeMs'>> = []
    let reviews = 0
    const executor: GraphDistillExecutor = {
      async execute(request) {
        phases.push(request.phase)
        limits.push({
          phase: request.phase,
          maxTurns: request.maxTurns,
          maxBudgetUsd: request.maxBudgetUsd,
          maxWallTimeMs: request.maxWallTimeMs,
        })
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') return { status: 'completed', output: {
          graph,
          traceability: { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] },
          taskSpec: 'compiled',
        } }
        reviews++
        return { status: 'completed', output: reviews === 1
          ? rejectedReview('The Constraint Ledger omitted a hard source rule.', 'intent_constraints')
          : review }
      },
    }
    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 2,
    })
    expect(result.semanticReview.accepted).toBe(true)
    expect(phases).toEqual(['architect', 'compiler', 'semantic_review', 'architect', 'compiler', 'semantic_review'])
    expect(limits).toEqual(phases.map(phase => ({
      phase, maxTurns: 30, maxBudgetUsd: 10, maxWallTimeMs: 1_200_000,
    })))
  })

  it('repairs a lossy tri-state route locally with the previous Compiler candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-local-semantic-repair-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Stale on zero findings or worsened; otherwise reset.', 'utf8')
    const lossyGraph: LoopGraphSpec = structuredClone(graph)
    lossyGraph.id = 'lossy_tri_state'
    lossyGraph.lanes = {
      work: { context: 'persistent', workspace: { read: [], write: [], deny: ['.git'] } },
    }
    lossyGraph.nodes.work = {
      type: 'agent', lane: 'work', prompt: 'Evaluate one round.', tools: [], maxAttempts: 1,
      outputSchema: {
        type: 'object', required: ['new_findings_count', 'trend', 'is_result_better'],
        properties: {
          new_findings_count: { type: 'integer', minimum: 0 },
          trend: { type: 'string', enum: ['worsened', 'unchanged', 'improved'] },
          is_result_better: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    }
    lossyGraph.transitions = [
      {
        id: 'stale', from: 'work', on: 'success', priority: 100,
        when: '$output.new_findings_count == 0 || $output.is_result_better == false',
        to: 'done',
      },
      { id: 'reset', from: 'work', on: 'success', default: true, to: 'done' },
      { id: 'failed', from: 'work', on: 'failure', to: 'done' },
    ]
    const correctedGraph = structuredClone(lossyGraph)
    correctedGraph.transitions[0]!.when = "$output.new_findings_count == 0 || $output.trend == 'worsened'"

    const phases: string[] = []
    const compilerPrompts: string[] = []
    let compiles = 0
    let reviews = 0
    const compilerOutput = (candidate: LoopGraphSpec) => ({
      graph: candidate,
      traceability: { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] },
      taskSpec: 'compiled',
    })
    const executor: GraphDistillExecutor = {
      async execute(request) {
        phases.push(request.phase)
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          compilerPrompts.push(request.taskDescription)
          compiles++
          const candidate = compiles === 1 ? lossyGraph : correctedGraph
          return {
            status: 'completed',
            output: compilerOutput(candidate),
            // A graph_validate capture must not trap a semantically rejected
            // candidate in metadata-only recovery mode.
            validatedGraph: candidate,
          }
        }
        reviews++
        return { status: 'completed', output: reviews === 1
          ? rejectedReview(
            "C7 requires reset for new findings plus unchanged, but is_result_better=false also routes unchanged as stale; use the existing tri-state trend.",
            'control_flow',
          )
          : review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      // The semantic-repair allowance is independent from the one mechanical
      // lowering attempt. A reviewer rejection must still get a local fix.
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 1,
    })

    expect(phases).toEqual(['architect', 'compiler', 'semantic_review', 'compiler', 'semantic_review'])
    expect(compilerPrompts[1]).toContain('上一版完整候选（局部修复锚点）')
    expect(compilerPrompts[1]).not.toContain('只返回上面指定的 metadata JSON')
    expect(compilerPrompts[1]).toContain('$output.is_result_better == false')
    expect(compilerPrompts[1]).toContain('use the existing tri-state trend')
    expect(compilerPrompts[1]).toContain('lint(warning) precomputed-routing')
    expect(result.graph.transitions[0]!.when).toBe("$output.new_findings_count == 0 || $output.trend == 'worsened'")
  })

  it('reserves semantic repair calls even when envelope retries reach the initial limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-late-semantic-repair-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Repair a late semantic rejection.', 'utf8')
    const phases: string[] = []
    let compiles = 0
    let reviews = 0
    const output = {
      graph,
      traceability: { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] },
      taskSpec: 'compiled',
    }
    const executor: GraphDistillExecutor = {
      async execute(request) {
        phases.push(request.phase)
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          compiles++
          if (compiles <= 2) return { status: 'failed', error: `envelope failure ${compiles}` }
          return { status: 'completed', output }
        }
        reviews++
        return { status: 'completed', output: reviews === 1
          ? rejectedReview('Late control-flow discrepancy.', 'control_flow')
          : review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 1,
    })

    expect(result.semanticReview.accepted).toBe(true)
    expect(phases).toEqual([
      'architect', 'compiler', 'compiler', 'compiler', 'semantic_review', 'compiler', 'semantic_review',
    ])
  })

  it('reuses a graph accepted by graph_validate when final envelope formatting times out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-validated-draft-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Resume compilation.', 'utf8')
    const phases: string[] = []
    const compilerPrompts: string[] = []
    let compiles = 0
    const executor: GraphDistillExecutor = {
      async execute(request) {
        phases.push(request.phase)
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          compilerPrompts.push(request.taskDescription)
          compiles++
          if (compiles === 1) return {
            status: 'failed', error: 'compiler wall timeout after validation', validatedGraph: graph,
          }
          return { status: 'completed', output: {
            traceability: { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] },
            preconditions: { schemaVersion: 'loop-preconditions-1.0', items: [] },
            taskSpec: 'reused validator draft',
          } }
        }
        return { status: 'completed', output: review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 2,
    })

    expect(result.graph).toEqual(graph)
    expect(phases).toEqual(['architect', 'compiler', 'compiler', 'semantic_review'])
    expect(compilerPrompts[1]).toContain('已冻结 Graph：宿主保留，不要重复输出')
    expect(compilerPrompts[1]).toContain('只返回上面指定的 metadata JSON')
  })

  it('unfreezes a validator-accepted graph when host lint requires an executable repair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-lint-unfreeze-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Write state through the declared lane.', 'utf8')
    const linted = structuredClone(graph)
    linted.lanes = { work: { context: 'persistent', workspace: { read: [], write: [], deny: ['.git'] } } }
    linted.nodes.work = {
      type: 'agent', lane: 'work', prompt: 'Write `state/progress.json` after the bounded iteration.',
      tools: ['write_file'], maxAttempts: 1,
    }
    const corrected = structuredClone(linted)
    corrected.lanes.work!.workspace.write = [{ path: 'state/progress.json', mode: 'atomic_replace' }]
    const prompts: string[] = []
    let compiles = 0
    const envelope = (candidate: LoopGraphSpec) => ({
      graph: candidate,
      traceability: { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] },
      taskSpec: 'compiled',
    })
    const executor: GraphDistillExecutor = {
      async execute(request) {
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          prompts.push(request.taskDescription)
          compiles++
          const candidate = compiles === 1 ? linted : corrected
          return { status: 'completed', output: envelope(candidate), validatedGraph: candidate }
        }
        return { status: 'completed', output: review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 2,
    })

    expect(prompts[1]).toContain('上一版完整候选（局部修复锚点）')
    expect(prompts[1]).toContain('undeclared-workspace-write')
    expect(prompts[1]).not.toContain('只返回上面指定的 metadata JSON')
    expect(result.graph.lanes.work!.workspace.write).toEqual([{ path: 'state/progress.json', mode: 'atomic_replace' }])
  })

  it('reserves one full-graph repair when host lint first appears at the attempt boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-late-lint-repair-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Write state through the declared lane.', 'utf8')
    const linted = structuredClone(graph)
    linted.lanes = { work: { context: 'persistent', workspace: { read: [], write: [], deny: ['.git'] } } }
    linted.nodes.work = {
      type: 'agent', lane: 'work', prompt: 'Write `state/progress.json` after the bounded iteration.',
      tools: ['write_file'], maxAttempts: 1,
    }
    const corrected = structuredClone(linted)
    corrected.lanes.work!.workspace.write = [{ path: 'state/progress.json', mode: 'atomic_replace' }]
    const prompts: string[] = []
    let compiles = 0
    const envelope = (candidate: LoopGraphSpec) => ({
      graph: candidate,
      traceability: { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] },
      taskSpec: 'compiled',
    })
    const executor: GraphDistillExecutor = {
      async execute(request) {
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          prompts.push(request.taskDescription)
          compiles++
          if (compiles <= 2) return { status: 'failed', error: `envelope failure ${compiles}` }
          const candidate = compiles === 3 ? linted : corrected
          return { status: 'completed', output: envelope(candidate), validatedGraph: candidate }
        }
        return { status: 'completed', output: review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 1,
    })

    expect(compiles).toBe(4)
    expect(prompts[3]).toContain('undeclared-workspace-write')
    expect(prompts[3]).toContain('上一版完整候选（局部修复锚点）')
    expect(result.graph.lanes.work!.workspace.write).toEqual([{ path: 'state/progress.json', mode: 'atomic_replace' }])
  })

  it('reserves compact metadata recovery when a graph freezes at the attempt boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-late-frozen-recovery-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Recover a frozen graph envelope.', 'utf8')
    const prompts: string[] = []
    let compiles = 0
    const executor: GraphDistillExecutor = {
      async execute(request) {
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          prompts.push(request.taskDescription)
          compiles++
          if (compiles <= 2) return { status: 'failed', error: `envelope failure ${compiles}` }
          if (compiles === 3) return { status: 'completed', output: 'malformed oversized envelope', validatedGraph: graph }
          return { status: 'completed', output: {
            traceability: { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] },
            preconditions: { schemaVersion: 'loop-preconditions-1.0', items: [] },
            taskSpec: 'recovered compact metadata',
          } }
        }
        return { status: 'completed', output: review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 1,
    })

    expect(compiles).toBe(4)
    expect(prompts[3]).toContain('已冻结 Graph：宿主保留，不要重复输出')
    expect(prompts[3]).toContain('只返回上面指定的 metadata JSON')
    expect(result.graph).toEqual(graph)
  })
})
