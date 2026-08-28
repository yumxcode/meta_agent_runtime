import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SEMANTIC_REVIEW_LAYERS,
  WITNESS_REQUIRED_RULE_CLASSES,
  createDefaultGraphRuntimeCatalog,
  createFileDistillCheckpointStore,
  distillLoopGraph,
  type GraphDistillExecutor,
  type LoopBlueprint,
  type LoopConstraintLedger,
  type LoopGraphSpec,
} from '../index.js'
import { DEFAULT_DISTILL_STAGE_BUDGET_USD } from '../../../infra/budgets.js'

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
// Every hard constraint in scope needs a row, and `satisfied` needs a pointer
// that actually resolves — the enumeration contract is what makes "not
// mentioned" stop meaning "probably fine".
const review = {
  schemaVersion: 'loop-semantic-review-2.2', accepted: true, issues: [] as string[], advisories: [] as string[],
  verdicts: [{ constraintId: 'C1', verdict: 'satisfied', graphRefs: ['/goal'] }] as unknown[],
  layers: Object.fromEntries(SEMANTIC_REVIEW_LAYERS.map(layer => [layer, {
    status: 'pass', findings: [] as unknown[], evidence: [{ sourceRefs: ['requirements.md:line 1'], designRefs: ['intent'], graphRefs: ['/goal'], statement: 'Aligned.' }],
  }])),
}

/** A rejection now needs a blocking rule class: the host derives `accepted`
 * from the findings, so a bare issue string would parse as acceptance.
 *
 * Control-flow classes additionally need a structurally valid witness, or the
 * host demotes them to advisory. The fixture supplies a real Transition id from
 * `graph` so these rejections keep testing accumulation rather than accidentally
 * exercising the demotion path. */
function rejectedReview(
  issue: string,
  failedLayer: typeof SEMANTIC_REVIEW_LAYERS[number] = 'workspace_contract',
  ruleClass = 'writer-boundary-bypass',
): typeof review {
  const witness = WITNESS_REQUIRED_RULE_CLASSES.includes(ruleClass as typeof WITNESS_REQUIRED_RULE_CLASSES[number])
    ? { state: {}, path: ['done'], outcome: 'terminal_unreachable' }
    : undefined
  const layers = Object.fromEntries(SEMANTIC_REVIEW_LAYERS.map(layer => [layer, {
    status: layer === failedLayer ? 'fail' : 'pass',
    findings: layer === failedLayer
      ? [{
          ruleClass, statement: issue, sourceRefs: ['requirements.md:line 1'], designRefs: ['workspace'], graphRefs: ['/lanes'],
          ...(witness ? { witness } : {}),
        }]
      : [],
    evidence: [{ sourceRefs: ['requirements.md:line 1'], designRefs: ['workspace'], graphRefs: ['/lanes'], statement: layer === failedLayer ? issue : 'Aligned.' }],
  }]))
  return {
    ...review, accepted: false, layers, issues: [issue],
    verdicts: [{ constraintId: 'C1', verdict: 'violated', ruleClass, graphRefs: ['/lanes'] }],
  }
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
      { phase: 'compiler', thinkingBudgetTokens: 0, maxOutputTokens: 49_152, maxWallTimeMs: 1_200_000, maxTurns: 30, maxBudgetUsd: DEFAULT_DISTILL_STAGE_BUDGET_USD },
      // The verdict table scales with the ledger, so review shares the 32K
      // ceiling rather than the old 16K one it kept overrunning.
      { phase: 'semantic_review', thinkingBudgetTokens: 0, maxOutputTokens: 32_768, maxWallTimeMs: 1_200_000, maxTurns: 30, maxBudgetUsd: DEFAULT_DISTILL_STAGE_BUDGET_USD },
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
      phase, maxTurns: 30, maxBudgetUsd: DEFAULT_DISTILL_STAGE_BUDGET_USD, maxWallTimeMs: 1_200_000,
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
      budget: { turns: 20, usd: 5, wallTimeMs: 300_000 },
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

  // That metadata turn is told the graph is host-retained and must not be
  // repeated. Models spell "omitted" as an absent key, `null`, or a placeholder
  // string. Requiring strict absence put the last two in a gap between the two
  // parsers — one rejects them for not being an object, the other for being
  // present — and a frozen, executable graph was discarded over the spelling.
  it.each([
    ['absent key', undefined],
    ['null', null],
    ['placeholder string', '已冻结，见上一轮 graph_validate'],
    ['empty object', {}],
  ])('recovers the retained graph when the compiler spells it as %s', async (_label, spelling) => {
    const root = await mkdtemp(join(tmpdir(), 'distill-metadata-spelling-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Resume compilation.', 'utf8')
    let compiles = 0
    const executor: GraphDistillExecutor = {
      async execute(request) {
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          if (++compiles === 1) return { status: 'failed', error: 'envelope timeout', validatedGraph: graph }
          const envelope: Record<string, unknown> = {
            traceability: { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] },
            preconditions: { schemaVersion: 'loop-preconditions-1.0', items: [] },
            taskSpec: 'metadata only',
          }
          if (spelling !== undefined) envelope.graph = spelling
          return { status: 'completed', output: envelope }
        }
        return { status: 'completed', output: review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 2,
    })

    expect(result.graph).toEqual(graph)
    expect(result.taskSpec).toBe('metadata only')
  })

  it('unfreezes a validator-accepted graph when host lint requires an executable repair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-lint-unfreeze-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Write state through the declared lane.', 'utf8')
    const linted = structuredClone(graph)
    linted.lanes = { work: { context: 'persistent', workspace: { read: [], write: [], deny: ['.git'] } } }
    linted.nodes.work = {
      type: 'agent', lane: 'work', prompt: 'Write `state/progress.json` after the bounded iteration.',
      tools: ['write_file'], maxAttempts: 1, budget: { turns: 20, usd: 5, wallTimeMs: 300_000 },
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
      tools: ['write_file'], maxAttempts: 1, budget: { turns: 20, usd: 5, wallTimeMs: 300_000 },
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

  // Regression for the F1 run lost at attempt 5: after a semantic rejection the
  // compiler re-froze a graph whose claimed fix never landed, then failed on
  // traceability only. The host locked the graph into metadata-only recovery
  // AND the traceability errors overwrote the reviewer's diagnosis, so the next
  // attempt re-submitted the unfixed graph to the reviewer and burned a scarce
  // semantic-repair call. Both diagnostic pools must survive the interleaving,
  // and the graph must stay patchable until the reviewer accepts.
  it('keeps semantic diagnostics and full-graph repair after an intervening metadata failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-semantic-metadata-interleave-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Carry the evidence to the gate.', 'utf8')
    const corrected = structuredClone(graph)
    corrected.version = 2
    const goodTraceability = { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] }
    const badTraceability = { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/nodes/nonexistent'], rationale: 'Claimed fix.' }] }
    const prompts: string[] = []
    const phases: string[] = []
    let compiles = 0
    let reviews = 0
    const executor: GraphDistillExecutor = {
      async execute(request) {
        phases.push(request.phase)
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          prompts.push(request.taskDescription)
          compiles++
          if (compiles === 1) return { status: 'completed', output: { graph, traceability: goodTraceability, taskSpec: 'compiled' }, validatedGraph: graph }
          if (compiles === 2) return { status: 'completed', output: { graph: corrected, traceability: badTraceability, taskSpec: 'claimed fix' }, validatedGraph: corrected }
          return { status: 'completed', output: { graph: corrected, traceability: goodTraceability, taskSpec: 'landed fix' }, validatedGraph: corrected }
        }
        reviews++
        return { status: 'completed', output: reviews === 1
          ? rejectedReview('The gate input is null on every edge, severing the evidence dataflow.', 'control_flow')
          : review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(),
    })

    expect(phases).toEqual(['architect', 'compiler', 'semantic_review', 'compiler', 'compiler', 'semantic_review'])
    // The third compiler turn follows a metadata-only failure while the
    // semantic rejection is still unresolved: the graph must stay patchable
    // and BOTH diagnostic pools must reach the model.
    expect(prompts[2]).not.toContain('只返回上面指定的 metadata JSON')
    expect(prompts[2]).toContain('上一版完整候选（局部修复锚点）')
    expect(prompts[2]).toContain('severing the evidence dataflow')
    expect(prompts[2]).toContain('does not exist in the Graph')
    expect(result.graph).toEqual(corrected)
    expect(result.taskSpec).toBe('landed fix')
  })

  // Lint reads the Graph and nothing else, so review metadata must never
  // suppress it. It used to run only after traceability and preconditions were
  // clean, which let one wrong JSON pointer hide the same real permission
  // defect across four consecutive candidates while the compiler fixed
  // pointers.
  it('reports write-surface lint in the same attempt as a broken traceability pointer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-lint-not-gated-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Write state through the declared lane.', 'utf8')
    const linted = structuredClone(graph)
    linted.lanes = { work: { context: 'persistent', workspace: { read: [], write: [], deny: ['.git'] } } }
    linted.nodes.work = {
      type: 'agent', lane: 'work', prompt: 'Write `state/progress.json` after the bounded iteration.',
      tools: ['write_file'], maxAttempts: 1, budget: { turns: 20, usd: 5, wallTimeMs: 300_000 },
    }
    const corrected = structuredClone(linted)
    corrected.lanes.work!.workspace.write = [{ path: 'state/progress.json', mode: 'atomic_replace' }]
    const goodTraceability = { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] }
    const badTraceability = { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/transitions/99/when'], rationale: 'Typo.' }] }
    const prompts: string[] = []
    let compiles = 0
    const executor: GraphDistillExecutor = {
      async execute(request) {
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          prompts.push(request.taskDescription)
          compiles++
          const candidate = compiles === 1 ? linted : corrected
          return {
            status: 'completed',
            output: { graph: candidate, traceability: compiles === 1 ? badTraceability : goodTraceability, taskSpec: 'compiled' },
            validatedGraph: candidate,
          }
        }
        return { status: 'completed', output: review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 2,
    })

    // One attempt, both diagnostics: the pointer typo did not hide the
    // permission defect, so the repair needs no extra round trip.
    expect(compiles).toBe(2)
    expect(prompts[1]).toContain('undeclared-workspace-write')
    expect(prompts[1]).toContain('does not exist in the Graph')
    // A blocking lint finding is an executable defect, so the frozen draft must
    // be unlocked for a full-graph repair rather than metadata-only recovery.
    expect(prompts[1]).toContain('上一版完整候选（局部修复锚点）')
    expect(prompts[1]).not.toContain('只返回上面指定的 metadata JSON')
    expect(result.graph.lanes.work!.workspace.write).toEqual([{ path: 'state/progress.json', mode: 'atomic_replace' }])
  })

  // The Compiler session is persistent, so a graph frozen in an earlier turn
  // stays visible to the model — while the host drops that draft once a
  // blocking lint finding lands. The model then replies with metadata alone,
  // believing the host still holds the graph. Reporting a generic parse
  // failure gave it nothing to change and it repeated the identical reply
  // until the budget ran out; the diagnostic has to name the disagreement.
  it('tells the compiler to resend the graph when metadata arrives with no retained draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-metadata-deadlock-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Write state through the declared lane.', 'utf8')
    const linted = structuredClone(graph)
    linted.lanes = { work: { context: 'persistent', workspace: { read: [], write: [], deny: ['.git'] } } }
    linted.nodes.work = {
      type: 'agent', lane: 'work', prompt: 'Write `state/progress.json` after the bounded iteration.',
      tools: ['write_file'], maxAttempts: 1, budget: { turns: 20, usd: 5, wallTimeMs: 300_000 },
    }
    const corrected = structuredClone(linted)
    corrected.lanes.work!.workspace.write = [{ path: 'state/progress.json', mode: 'atomic_replace' }]
    const traceability = { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] }
    const prompts: string[] = []
    let compiles = 0
    const executor: GraphDistillExecutor = {
      async execute(request) {
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          prompts.push(request.taskDescription)
          compiles++
          // 1: blocking lint → host drops the frozen draft.
          if (compiles === 1) return { status: 'completed', output: { graph: linted, traceability, taskSpec: 'compiled' }, validatedGraph: linted }
          // 2: model assumes the host kept it and sends metadata only.
          if (compiles === 2) return { status: 'completed', output: { traceability, preconditions: { schemaVersion: 'loop-preconditions-1.0', items: [] }, taskSpec: 'metadata only' } }
          return { status: 'completed', output: { graph: corrected, traceability, taskSpec: 'resent' }, validatedGraph: corrected }
        }
        return { status: 'completed', output: review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 2,
    })

    expect(compiles).toBe(3)
    expect(prompts[2]).toContain('宿主当前不持有任何已冻结 Graph')
    expect(prompts[2]).toContain('必须重新输出完整 {graph,traceability,taskSpec}')
    expect(prompts[2]).not.toContain('no parseable')
    expect(result.graph.lanes.work!.workspace.write).toEqual([{ path: 'state/progress.json', mode: 'atomic_replace' }])
  })

  // A bare "no parseable" is unactionable, and the persistent Compiler session
  // keeps the corrupted text in context — one run re-emitted the same stray
  // double quote at the same byte offset for four attempts and died with a
  // valid graph already frozen on the host. The diagnostic has to point at the
  // character.
  it('points at the offset and excerpt when the envelope is corrupted JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-envelope-syntax-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Resume compilation.', 'utf8')
    const traceability = { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] }
    const clean = JSON.stringify({ graph, traceability, taskSpec: 'compiled' })
    // Exactly the observed corruption: a stray quote between two array
    // elements, deep inside the graph rather than at the envelope edges.
    const corrupted = `我已修复诊断项，输出最终 JSON：\n${clean.replace('},{"id":"failed"', '},"{"id":"failed"')}`
    expect(corrupted).toContain('},"{"id":"failed"')

    const prompts: string[] = []
    let compiles = 0
    const executor: GraphDistillExecutor = {
      async execute(request) {
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          prompts.push(request.taskDescription)
          return { status: 'completed', output: ++compiles === 1 ? corrupted : clean }
        }
        return { status: 'completed', output: review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 2,
    })

    expect(compiles).toBe(2)
    expect(prompts[1]).toMatch(/offset \d+ 处语法无效/)
    // The excerpt must carry the broken text with the marker at the reported
    // position — the stray quote sits a few characters ahead of it, which is
    // exactly what the guidance tells the compiler to look for.
    expect(prompts[1]).toContain('},"{"⟪HERE⟫id":"failed"')
    expect(prompts[1]).toContain('Graph 内容不需要重新设计')
    expect(result.graph).toEqual(graph)
  })

  it('names the actual keys when the envelope parses but is incomplete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-envelope-keys-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Resume compilation.', 'utf8')
    const traceability = { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] }
    const prompts: string[] = []
    let compiles = 0
    const executor: GraphDistillExecutor = {
      async execute(request) {
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          prompts.push(request.taskDescription)
          // Valid JSON, but graph is missing and no draft is retained.
          return { status: 'completed', output: ++compiles === 1
            ? JSON.stringify({ taskSpec: 'only the notes', preconditions: { schemaVersion: 'loop-preconditions-1.0', items: [] } })
            : JSON.stringify({ graph, traceability, taskSpec: 'compiled' }) }
        }
        return { status: 'completed', output: review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 2,
    })

    expect(prompts[1]).toContain('实际顶层键为 [taskSpec, preconditions]')
    expect(result.graph).toEqual(graph)
  })

  // The reviewer reports a few findings per round, so a graph converges over
  // several rounds. Replacing the previous round's feedback made convergence
  // impossible when two findings constrain the same mechanism: one run was told
  // a counter reset made a terminal unreachable, removed the reset, and was
  // then told the source mandates that reset — never seeing both at once.
  it('carries earlier semantic findings forward instead of replacing them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-semantic-accumulate-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Reset the counter after a pivot, and stop at four.', 'utf8')
    const traceability = { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] }
    const prompts: string[] = []
    let compiles = 0
    let reviews = 0
    const executor: GraphDistillExecutor = {
      async execute(request) {
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          prompts.push(request.taskDescription)
          compiles++
          return { status: 'completed', output: { graph, traceability, taskSpec: `attempt ${compiles}` } }
        }
        reviews++
        if (reviews === 1) return { status: 'completed', output: rejectedReview('The pivot reset makes the attention terminal unreachable.', 'control_flow', 'unbounded-or-unreachable-control') }
        if (reviews === 2) return { status: 'completed', output: rejectedReview('The source mandates the pivot reset at L196.', 'control_flow', 'constraint-weakened') }
        return { status: 'completed', output: review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 1,
    })

    expect(result.semanticReview.accepted).toBe(true)
    // Second repair turn: the newest finding AND the one from the round before
    // are both present, with the older one marked as still binding.
    expect(prompts[2]).toContain('The source mandates the pivot reset')
    expect(prompts[2]).toContain('The pivot reset makes the attention terminal unreachable')
    expect(prompts[2]).toContain('compiler attempt 1 提出，未被撤销，仍须满足')
    expect(prompts[2]).toContain('【累积约束】')
    // The first repair turn has only one round, so no accumulation preamble.
    expect(prompts[1]).toContain('The pivot reset makes the attention terminal unreachable')
    expect(prompts[1]).not.toContain('【累积约束】')
  })

  it('does not duplicate a semantic finding that recurs across rounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-semantic-dedupe-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Stop at four.', 'utf8')
    const traceability = { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] }
    const repeated = 'The threshold is still 3 where the source says 4.'
    const prompts: string[] = []
    let reviews = 0
    const executor: GraphDistillExecutor = {
      async execute(request) {
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          prompts.push(request.taskDescription)
          return { status: 'completed', output: { graph, traceability, taskSpec: 'compiled' } }
        }
        reviews++
        return { status: 'completed', output: reviews <= 2
          ? rejectedReview(repeated, 'control_flow', 'constraint-weakened')
          : review }
      },
    }

    await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 1,
    })

    const occurrences = prompts[2]!.split(repeated).length - 1
    expect(occurrences).toBe(1)
  })

  // A wrong traceability pointer is the cheapest boundary failure to repair —
  // the host still holds the frozen, ABI-valid, lint-clean graph — but the
  // boundary reserve used to be granted only for executable defects, so this
  // one class died at the limit. One run lost its last attempt to four
  // out-of-range array indices with every semantic finding already addressed.
  it('reserves a repair when only review metadata fails at the attempt boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-late-metadata-repair-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Resume compilation.', 'utf8')
    const good = { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] }
    const bad = { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/transitions/99'], rationale: 'Off by one.' }] }
    const prompts: string[] = []
    let compiles = 0
    const executor: GraphDistillExecutor = {
      async execute(request) {
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          prompts.push(request.taskDescription)
          compiles++
          return {
            status: 'completed',
            output: { graph, traceability: compiles <= 3 ? bad : good, taskSpec: 'compiled' },
            validatedGraph: graph,
          }
        }
        return { status: 'completed', output: review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      // maxAttempts 1 → ordinary limit 3; the third failure sits exactly on the
      // boundary and must still earn the reserved fourth attempt.
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 1,
    })

    expect(compiles).toBe(4)
    expect(result.traceability).toEqual(good)
    // The reserved turn must carry the host's pointer facts, not just the raw error.
    expect(prompts[3]).toContain('does not exist in the Graph')
    expect(prompts[3]).toContain('合法下标是 0..1')
  })

  // Fix 1: the graph reaches the host through graph_validate's structured
  // argument, so re-serializing it into the text envelope buys nothing and risks
  // a corruption that discards a perfectly good graph. A metadata-only reply on
  // the very first attempt must therefore be the normal, accepted shape.
  it('accepts a metadata-only reply on the first attempt when graph_validate froze the graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-metadata-default-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Resume compilation.', 'utf8')
    const prompts: string[] = []
    const executor: GraphDistillExecutor = {
      async execute(request) {
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          prompts.push(request.taskDescription)
          return {
            status: 'completed',
            validatedGraph: graph,
            output: {
              traceability: { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] },
              preconditions: { schemaVersion: 'loop-preconditions-1.0', items: [] },
              taskSpec: 'metadata only',
            },
          }
        }
        return { status: 'completed', output: review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 2,
    })

    expect(result.graph).toEqual(graph)
    expect(result.taskSpec).toBe('metadata only')
    // The first prompt must state which side holds the graph and ask for
    // metadata only after validation.
    expect(prompts[0]).toContain('【宿主持图状态】')
    expect(prompts[0]).toContain('宿主当前**不持有**任何 Graph')
    expect(prompts[0]).toContain('不要把 graph 再抄进文本回答')
  })

  // Fix 5: metadata repairs are granted on top of the design allowance, so a
  // wrong pointer cannot consume an attempt that a real repair needed.
  it('does not spend design budget on metadata-only failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-metadata-pool-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Resume compilation.', 'utf8')
    const good = { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] }
    const bad = { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/transitions/99'], rationale: 'Off by one.' }] }
    const phases: string[] = []
    let compiles = 0
    let reviews = 0
    const executor: GraphDistillExecutor = {
      async execute(request) {
        phases.push(request.phase)
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') {
          compiles++
          // Two metadata-only failures, then a real semantic repair cycle.
          return {
            status: 'completed',
            validatedGraph: graph,
            output: { graph, traceability: compiles <= 2 ? bad : good, taskSpec: `attempt ${compiles}` },
          }
        }
        reviews++
        return { status: 'completed', output: reviews === 1
          ? rejectedReview('Control flow needs one real repair.', 'control_flow')
          : review }
      },
    }

    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      // Design allowance is 1 + 2 semantic repairs; the two metadata failures
      // must be paid for from their own pool, leaving the semantic repair intact.
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 1,
    })

    expect(result.semanticReview.accepted).toBe(true)
    // a1,a2 metadata → a3 reviewed+rejected → a4 reviewed+accepted.
    expect(phases).toEqual(['architect', 'compiler', 'compiler', 'compiler', 'semantic_review', 'compiler', 'semantic_review'])
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
