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

function rejectedReview(issue: string): typeof review {
  const layers = Object.fromEntries(SEMANTIC_REVIEW_LAYERS.map(layer => [layer, {
    status: layer === 'workspace_contract' ? 'fail' : 'pass',
    issues: layer === 'workspace_contract' ? [issue] : [],
    evidence: [{ sourceRefs: ['requirements.md:line 1'], designRefs: ['workspace'], graphRefs: ['/lanes'], statement: layer === 'workspace_contract' ? issue : 'Aligned.' }],
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
    const executor: GraphDistillExecutor = {
      async execute(request) {
        phases.push(request.phase)
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

  it('revisits Architect once after a semantic contract rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'distill-semantic-revision-'))
    roots.push(root)
    await writeFile(join(root, 'requirements.md'), 'Resume compilation.', 'utf8')
    const phases: string[] = []
    let reviews = 0
    const executor: GraphDistillExecutor = {
      async execute(request) {
        phases.push(request.phase)
        if (request.phase === 'architect') return { status: 'completed', output: { constraints, design } }
        if (request.phase === 'compiler') return { status: 'completed', output: {
          graph,
          traceability: { schemaVersion: 'graph-traceability-2.0', mappings: [{ constraintId: 'C1', graphRefs: ['/goal'], rationale: 'Goal is exact.' }] },
          taskSpec: 'compiled',
        } }
        reviews++
        return { status: 'completed', output: reviews === 1 ? rejectedReview('The Blueprint omitted a required write owner.') : review }
      },
    }
    const result = await distillLoopGraph({ projectDir: root, requirement: 'requirements.md' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 2,
    })
    expect(result.semanticReview.accepted).toBe(true)
    expect(phases).toEqual(['architect', 'compiler', 'semantic_review', 'architect', 'compiler', 'semantic_review'])
  })
})
