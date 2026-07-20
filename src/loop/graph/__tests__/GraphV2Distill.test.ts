import { describe, expect, it } from 'vitest'
import {
  CANONICAL_GRAPH_DISTILL_EXAMPLE,
  buildGraphDistillerSystem,
  buildGraphImplementationManifest,
  buildGraphSemanticReviewerSystem,
  buildLoopArchitectSystem,
  createDefaultGraphRuntimeCatalog,
  createGraphDistillTools,
  freezeLoopGraph,
  graphReference,
  parseLayeredSemanticReview,
  validateGraphTraceability,
  validateLoopGraph,
} from '../index.js'

describe('graph-v2 Distill contract', () => {
  it('keeps the canonical example executable', () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    expect(validateLoopGraph(CANONICAL_GRAPH_DISTILL_EXAMPLE, catalog)).toEqual([])
    expect(() => freezeLoopGraph(CANONICAL_GRAPH_DISTILL_EXAMPLE, catalog, 1)).not.toThrow()
  })

  it('teaches the same small vocabulary in Architect, Compiler, and Reviewer', () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    const prompts = [buildLoopArchitectSystem(), buildGraphDistillerSystem(catalog), buildGraphSemanticReviewerSystem()].join('\n')
    expect(prompts).toContain('Workspace')
    expect(prompts).toContain('Lane')
    expect(prompts).toContain('Kernel 不复制、不投影、不保存第二份用户数据')
  })

  it('exposes exact graph-2.0 reference sections and direct workspace rules', () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    expect(graphReference('overview', catalog)).toContain('graph-2.0')
    expect(graphReference('workspace', catalog)).toContain('append_only')
    expect(graphReference('lanes', catalog)).toContain('never creates a worktree')
    expect(graphReference('capabilities', catalog)).toContain('agentTools')
  })

  it('validates one complete candidate through the foreground tool', async () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    const validate = createGraphDistillTools(catalog).find(tool => tool.name === 'graph_validate')!
    const result = await validate.call({ graph: CANONICAL_GRAPH_DISTILL_EXAMPLE }, {
      sessionId: 'test', workspaceRoot: process.cwd(), toolNames: new Set(),
    })
    const parsed = JSON.parse(result.content)
    expect(parsed.valid).toBe(true)
    expect(parsed.frozen).toBe(true)
    expect(parsed.summary).toEqual(expect.objectContaining({ nodes: 3, lanes: 1, workspaceWrites: 0 }))
  })

  it('gives the semantic reviewer the Agent prompt needed to audit workspace writes', () => {
    const manifest = buildGraphImplementationManifest(CANONICAL_GRAPH_DISTILL_EXAMPLE)
    expect(manifest.nodes.work).toEqual(expect.objectContaining({
      prompt: CANONICAL_GRAPH_DISTILL_EXAMPLE.nodes.work.type === 'agent'
        ? CANONICAL_GRAPH_DISTILL_EXAMPLE.nodes.work.prompt
        : '',
    }))
  })

  it('does not let non-executable annotations satisfy a hard constraint', () => {
    const ledger = {
      schemaVersion: 'loop-constraints-2.0' as const,
      goal: CANONICAL_GRAPH_DISTILL_EXAMPLE.goal,
      constraints: [{
        id: 'C1', kind: 'capability' as const, statement: 'The worker must execute the capability.',
        strength: 'hard' as const, sources: [{ path: 'requirements.md', locator: 'L1' }],
      }],
    }
    const graph = { ...CANONICAL_GRAPH_DISTILL_EXAMPLE, annotations: { capability: 'claimed only' } }
    const errors = validateGraphTraceability({
      schemaVersion: 'graph-traceability-2.0',
      mappings: [{ constraintId: 'C1', graphRefs: ['/annotations/capability'], rationale: 'Claimed in metadata.' }],
    }, ledger, graph)
    expect(errors.join('\n')).toContain('only to non-executable annotations')
  })

  it('rejects accepted semantic reviews that still contain discrepancies as warnings', () => {
    const layers = Object.fromEntries([
      'intent_constraints', 'workspace_contract', 'lane_ownership', 'control_flow', 'capability_resolution', 'runtime_preconditions',
    ].map(name => [name, {
      status: 'pass', issues: [],
      evidence: [{ sourceRefs: ['requirements.md:L1'], designRefs: ['intent'], graphRefs: ['/goal'], statement: 'Aligned.' }],
    }]))
    expect(parseLayeredSemanticReview({
      schemaVersion: 'loop-semantic-review-2.1', accepted: true, layers, issues: [],
      warnings: ['A declared write target is outside the Lane workspace contract.'],
    })).toBeNull()
  })

  it('teaches strict $input dataflow and runtime preconditions to the model', () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    expect(graphReference('nodes', catalog)).toContain('STRICT')
    expect(graphReference('nodes', catalog)).toContain('optionalInputIdiom')
    expect(graphReference('nodes', catalog)).toContain('pausedTerminal')
    expect(graphReference('control', catalog)).toContain('PRE-update')
    expect(buildGraphDistillerSystem(catalog)).toContain('preconditions')
    expect(buildGraphDistillerSystem(catalog)).toContain('$input 引用是严格的')
    expect(buildLoopArchitectSystem()).toContain('不得虚构')
    expect(buildGraphSemanticReviewerSystem()).toContain('runtime_preconditions')
  })

  it('teaches the git scm capability and the nested-repo idiom', () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    expect(graphReference('lanes', catalog)).toContain('gitCommitter')
    expect(graphReference('lanes', catalog)).toContain('nestedRepoIdiom')
    expect(buildGraphDistillerSystem(catalog)).toContain("scm:'git'")
    expect(buildGraphSemanticReviewerSystem()).toContain('权限升级')
  })

  it('teaches that nothing outside the project root is writable', () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    expect(graphReference('workspace', catalog)).toContain('NO writable location outside the project root')
    expect(buildGraphDistillerSystem(catalog)).toContain('项目外没有任何可写位置')
    expect(buildLoopArchitectSystem()).toContain('项目外没有可写位置')
    expect(buildGraphSemanticReviewerSystem()).toContain('机械 Lint 提示')
  })
})
