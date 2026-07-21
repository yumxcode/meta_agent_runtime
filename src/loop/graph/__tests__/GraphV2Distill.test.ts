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
  type LoopGraphSpec,
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
    let captured: unknown
    const validate = createGraphDistillTools(catalog, {
      onValidatedGraph: graph => { captured = graph },
    }).find(tool => tool.name === 'graph_validate')!
    const result = await validate.call({ graph: CANONICAL_GRAPH_DISTILL_EXAMPLE }, {
      sessionId: 'test', workspaceRoot: process.cwd(), toolNames: new Set(),
    })
    const parsed = JSON.parse(result.content)
    expect(parsed.valid).toBe(true)
    expect(parsed.frozen).toBe(true)
    expect(parsed.summary).toEqual(expect.objectContaining({ nodes: 3, lanes: 1, workspaceWrites: 0 }))
    expect(captured).toEqual(CANONICAL_GRAPH_DISTILL_EXAMPLE)
  })

  it('repairs the saved candidate with small JSON Pointer operations', async () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    let captured: unknown
    const tools = createGraphDistillTools(catalog, {
      onValidatedGraph: graph => { captured = graph },
    })
    const validate = tools.find(tool => tool.name === 'graph_validate')!
    const patchValidate = tools.find(tool => tool.name === 'graph_patch_validate')!
    const invalid = { ...structuredClone(CANONICAL_GRAPH_DISTILL_EXAMPLE), unexpected: true }
    const context = { sessionId: 'test', workspaceRoot: process.cwd(), toolNames: new Set<string>() }

    const rejected = JSON.parse((await validate.call({ graph: invalid }, context)).content)
    expect(rejected.valid).toBe(false)
    const repaired = JSON.parse((await patchValidate.call({
      operations: [{ op: 'remove', path: '/unexpected' }],
    }, context)).content)

    expect(repaired.valid).toBe(true)
    expect(repaired.frozen).toBe(true)
    expect(captured).toEqual(CANONICAL_GRAPH_DISTILL_EXAMPLE)
  })

  it('uses stable transition ids and rolls a bad patch back to the last valid graph', async () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    let captured: LoopGraphSpec | undefined
    const tools = createGraphDistillTools(catalog, {
      onValidatedGraph: graph => { captured = graph },
    })
    const validate = tools.find(tool => tool.name === 'graph_validate')!
    const patchValidate = tools.find(tool => tool.name === 'graph_patch_validate')!
    const context = { sessionId: 'test', workspaceRoot: process.cwd(), toolNames: new Set<string>() }
    const initial = JSON.parse((await validate.call({ graph: CANONICAL_GRAPH_DISTILL_EXAMPLE }, context)).content)
    expect(initial.patchSelectors.transitions.goal_reached).toBe('/transitions/@id=goal_reached')

    const rejected = JSON.parse((await patchValidate.call({
      operations: [{ op: 'set', path: '/transitions/@id=continue_work/when', value: '$output.complete == false' }],
    }, context)).content)
    expect(rejected.valid).toBe(false)
    expect(rejected.draftRolledBackToLastValid).toBe(true)

    const repaired = JSON.parse((await patchValidate.call({
      operations: [{ op: 'set', path: '/transitions/@id=goal_reached/priority', value: 101 }],
    }, context)).content)
    expect(repaired.valid).toBe(true)
    const transitions = captured!.transitions
    expect(transitions.find(transition => transition.id === 'goal_reached')?.priority).toBe(101)
    expect(transitions.find(transition => transition.id === 'continue_work')?.when).toBeUndefined()
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

  it('normalizes omitted empty issues on passing review layers only', () => {
    const passingLayers = Object.fromEntries([
      'intent_constraints', 'workspace_contract', 'lane_ownership', 'control_flow', 'capability_resolution', 'runtime_preconditions',
    ].map(name => [name, {
      status: 'pass',
      evidence: [{ sourceRefs: ['requirements.md:L1'], designRefs: ['intent'], graphRefs: ['/goal'], statement: 'Aligned.' }],
    }]))
    const parsed = parseLayeredSemanticReview({
      schemaVersion: 'loop-semantic-review-2.1', accepted: true, layers: passingLayers, issues: [], warnings: [],
    })
    expect(parsed?.layers.control_flow.issues).toEqual([])

    passingLayers.control_flow = {
      status: 'fail',
      evidence: [{ sourceRefs: ['requirements.md:L1'], designRefs: ['control'], graphRefs: ['/transitions/0'], statement: 'Broken.' }],
    }
    expect(parseLayeredSemanticReview({
      schemaVersion: 'loop-semantic-review-2.1', accepted: false, layers: passingLayers,
      issues: ['Broken.'], warnings: [],
    })).toBeNull()
  })

  it('teaches strict $input dataflow and runtime preconditions to the model', () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    const compiler = buildGraphDistillerSystem(catalog)
    expect(graphReference('nodes', catalog)).toContain('STRICT')
    expect(graphReference('nodes', catalog)).toContain('optionalInputIdiom')
    expect(graphReference('nodes', catalog)).toContain('pausedTerminal')
    expect(graphReference('control', catalog)).toContain('PRE-update')
    expect(graphReference('control', catalog)).toContain("$output.trend == 'worsened'")
    expect(graphReference('control', catalog)).toContain('current>=threshold-1')
    expect(compiler).toContain('preconditions')
    expect(compiler).toContain('$input 引用是严格的')
    expect(compiler).toContain('一组确定性 Transition 的 when + updates')
    expect(compiler).toContain('target inputs 读取 Reducer 更新后的 $state')
    expect(compiler).toContain('同一个 persistent Agent 通过 mode/input')
    expect(compiler).toContain('禁止串联 identity/reduce/status gate')
    expect(compiler).toContain('不得让 research→pivot 或 pivot→pivot 绕过 writer')
    expect(compiler).toContain('bootstrap 只读取/发现并输出初始化 payload')
    expect(compiler).toContain('绝不会回写或合并 Agent 的 $output 对象')
    expect(compiler).toContain('不要另写 bash mkdir state/、logs/')
    expect(compiler).toContain('不要一次加载全部 section')
    expect(compiler).toContain('graph_patch_validate')
    expect(compiler).toContain('attention = no_progress && current_stale_count>=3')
    expect(compiler).toContain('禁止把 stale_count 阈值与 no_progress 用 OR 连接')
    expect(buildLoopArchitectSystem()).toContain('不得虚构')
    expect(buildGraphSemanticReviewerSystem()).toContain('runtime_preconditions')
    expect(buildGraphSemanticReviewerSystem()).toContain('唯一权威项目路径')
    expect(buildGraphSemanticReviewerSystem()).toContain('attention、pivot、普通 stale 都必须受 no_progress 约束')
    expect(buildGraphSemanticReviewerSystem()).toContain('只约束结果属于该集合')
    expect(buildGraphSemanticReviewerSystem()).toContain('正确闭环是工作分支→writer')
    expect(buildGraphSemanticReviewerSystem()).toContain('Reducer 不会修改 $output.progress_patch')
    expect(buildGraphSemanticReviewerSystem()).toContain('自动创建缺失父目录')
  })

  it('returns an exact repair hint for unquoted enum literals', async () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    const invalid = structuredClone(CANONICAL_GRAPH_DISTILL_EXAMPLE)
    invalid.transitions[0]!.when = '$output.complete == worsened'
    const validate = createGraphDistillTools(catalog).find(tool => tool.name === 'graph_validate')!
    const result = await validate.call({ graph: invalid }, {
      sessionId: 'test', workspaceRoot: process.cwd(), toolNames: new Set(),
    })
    const parsed = JSON.parse(result.content)
    expect(parsed.valid).toBe(false)
    expect(parsed.repairHints.join('\n')).toContain("$output.trend == 'worsened'")
    expect(parsed.repairHints.join('\n')).toContain('Do not replace it with numeric codes')
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

  it('keeps project-resident operating manuals out of repeated Agent prompts', () => {
    const prompt = buildGraphDistillerSystem(createDefaultGraphRuntimeCatalog())
    expect(prompt).toContain('不要把整份正文复制进每个 Agent prompt')
    expect(prompt).toContain('Lane.workspace.read')
    expect(prompt).toContain('来源仍是单一事实源')
  })
})
