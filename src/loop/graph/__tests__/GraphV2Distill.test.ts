import { describe, expect, it } from 'vitest'
import {
  CANONICAL_GRAPH_DISTILL_EXAMPLE,
  buildGraphDistillerSystem,
  buildGraphImplementationManifest,
  buildGraphSemanticReviewerSystem,
  buildLoopArchitectSystem,
  createDefaultGraphRuntimeCatalog,
  formatGraphValidationFeedback,
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
    expect(parsed.summary).toEqual(expect.objectContaining({ nodes: 4, transitions: 6, lanes: 2, workspaceWrites: 0 }))
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

  const passingLayerSet = (): Record<string, Record<string, unknown>> => Object.fromEntries([
    'intent_constraints', 'workspace_contract', 'lane_ownership', 'control_flow', 'capability_resolution', 'runtime_preconditions',
  ].map(name => [name, {
    status: 'pass', findings: [],
    evidence: [{ sourceRefs: ['requirements.md:L1'], designRefs: ['intent'], graphRefs: ['/goal'], statement: 'Aligned.' }],
  }]))

  const finding = (ruleClass: string, statement: string): Record<string, unknown> => ({
    ruleClass, statement, sourceRefs: ['requirements.md:L1'], designRefs: ['control'], graphRefs: ['/transitions/0'],
  })

  it('derives acceptance from rule class, ignoring the model-supplied accepted flag', () => {
    // A reviewer that files a real hard-contract violation and then claims
    // acceptance must not get the graph through: severity is the host's.
    const layers = passingLayerSet()
    layers.control_flow = {
      status: 'fail', findings: [finding('missing-source-bound', 'Source caps rounds at 20; no transition routes on it.')],
      evidence: [{ sourceRefs: ['requirements.md:L152'], designRefs: ['control'], graphRefs: ['/limits'], statement: 'Checked.' }],
    }
    const parsed = parseLayeredSemanticReview({
      schemaVersion: 'loop-semantic-review-2.1', accepted: true, layers, issues: [],
    })
    expect(parsed?.accepted).toBe(false)
    expect(parsed?.issues).toHaveLength(1)
    expect(parsed?.issues[0]).toContain('missing-source-bound')
  })

  it('accepts a verdict whose only findings are advisory, and records them', () => {
    const layers = passingLayerSet()
    layers.lane_ownership = {
      ...layers.lane_ownership,
      findings: [finding('topology-granularity', 'research and reflect could share one agent.')],
    }
    const parsed = parseLayeredSemanticReview({
      schemaVersion: 'loop-semantic-review-2.1', accepted: false, layers, issues: [],
    })
    expect(parsed?.accepted).toBe(true)
    expect(parsed?.issues).toEqual([])
    expect(parsed?.advisories[0]).toContain('topology-granularity')
  })

  it('rejects a blocking finding parked on a passing layer, or an unknown rule class', () => {
    const smuggled = passingLayerSet()
    smuggled.control_flow = {
      ...smuggled.control_flow,
      findings: [finding('unbounded-or-unreachable-control', 'No terminal is reachable.')],
    }
    expect(parseLayeredSemanticReview({
      schemaVersion: 'loop-semantic-review-2.1', accepted: true, layers: smuggled, issues: [],
    })).toBeNull()

    const invented = passingLayerSet()
    invented.control_flow = { ...invented.control_flow, findings: [finding('cosmetic-nitpick', 'Naming.')] }
    expect(parseLayeredSemanticReview({
      schemaVersion: 'loop-semantic-review-2.1', accepted: true, layers: invented, issues: [],
    })).toBeNull()
  })

  it('normalizes omitted empty findings on passing review layers only', () => {
    const passingLayers = Object.fromEntries([
      'intent_constraints', 'workspace_contract', 'lane_ownership', 'control_flow', 'capability_resolution', 'runtime_preconditions',
    ].map(name => [name, {
      status: 'pass',
      evidence: [{ sourceRefs: ['requirements.md:L1'], designRefs: ['intent'], graphRefs: ['/goal'], statement: 'Aligned.' }],
    }]))
    const parsed = parseLayeredSemanticReview({
      schemaVersion: 'loop-semantic-review-2.1', accepted: true, layers: passingLayers, issues: [],
    })
    expect(parsed?.layers.control_flow.findings).toEqual([])

    // A `fail` layer with no blocking finding names nothing actionable, so the
    // whole verdict stays invalid.
    passingLayers.control_flow = {
      status: 'fail',
      evidence: [{ sourceRefs: ['requirements.md:L1'], designRefs: ['control'], graphRefs: ['/transitions/0'], statement: 'Broken.' }],
    }
    expect(parseLayeredSemanticReview({
      schemaVersion: 'loop-semantic-review-2.1', accepted: false, layers: passingLayers, issues: ['Broken.'],
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
    expect(compiler).toContain('一个可写 persistent Worker + 一个独立只读 completion Reviewer')
    expect(compiler).toContain('禁止串联 identity/reduce/status gate')
    expect(compiler).toContain('不得为了“审计”凭空制造 writer')
    expect(compiler).toContain('绝不回写或合并 Agent 的 $output')
    expect(compiler).toContain('不要一次加载全部 section')
    expect(compiler).toContain('graph_patch_validate')
    expect(compiler).toContain('budget.wallTimeMs')
    expect(compiler).toContain('不得小于 300000（5 分钟）')
    // Enforcement locus: governance belongs to Graph, domain procedure to the
    // thick worker, and completion criteria to an independent authority.
    expect(compiler).toContain('graph 落点')
    expect(compiler).toContain('agent 落点')
    expect(compiler).toContain('reviewer 落点')
    expect(compiler).toContain('一个可写 persistent Worker + 一个独立只读 completion Reviewer')
    expect(compiler).toContain('不能用 stop/done/target_reached/next_node 之类字段直接签发业务终态')
    // Choosing a Wait node over a hard park is what makes a per-round time
    // bound inexpressible; state the consequence, not just the preference.
    expect(compiler).toContain('lifetimeBudget.elapsedMs')
    expect(compiler).toContain('State 中声明的每个字段')
    // Graph travels via graph_validate's structured argument; the text envelope
    // carries metadata only, so a long-JSON serialization slip cannot discard a
    // graph that already arrived.
    expect(compiler).toContain('Graph **只通过 graph_validate 工具调用交付**')
    expect(compiler).toContain('最终文本回答**不要再包含 graph**')
    // The write surface has one source of truth: the Kernel already injects the
    // lane workspace contract into every Activation prompt.
    expect(compiler).toContain('不要在 Agent prompt 里枚举可写路径或目录')
    expect(compiler).toContain('写面的唯一事实源是 lane.workspace')
    // Domain templates leaked one project's vocabulary into a
    // supposedly domain-neutral compiler, and its literal thresholds were wrong
    // for every other source. They must not come back.
    for (const leaked of ['stale_count', 'no_progress', 'attention', 'worsened', 'findings', 'bash mkdir state/']) {
      expect(compiler).not.toContain(leaked)
    }
    const architect = buildLoopArchitectSystem()
    expect(architect).toContain('不得虚构')
    // `kind` decides the governance boundary, including independent completion.
    expect(architect).toContain('它决定该约束**在哪里被执行**')
    expect(architect).toContain('不能给自己签发完成证书')
    const reviewer = buildGraphSemanticReviewerSystem()
    expect(reviewer).toContain('runtime_preconditions')
    expect(reviewer).toContain('唯一权威项目路径')
    expect(reviewer).toContain('只约束结果属于该集合')
    expect(reviewer).toContain('不得反推出“必须有 writer Agent”')
    expect(reviewer).toContain('不能给自己签发完成证书')
    expect(reviewer).toContain('single-agent-terminal-authority')
    // The locus contract is what makes review satisfiable: an intent-shaped
    // constraint having no Graph element is correct design, not a defect.
    expect(reviewer).toContain('【执行落点：判断「实现了没有」的唯一标准】')
    expect(reviewer).toContain('Graph 中没有对应元素是正确设计，不得据此提出任何 finding')
    expect(reviewer).toContain('unbriefed-agent-constraint')
    // Severity is the host's: the reviewer is told both enums and told its own
    // `accepted` is discarded.
    expect(reviewer).toContain('【严重度不由你决定】')
    expect(reviewer).toContain('missing-source-bound')
    expect(reviewer).toContain('topology-granularity')
    // Rules owned by deterministic lint must NOT be restated here; duplicating
    // them is what made every review sample a different subset.
    expect(reviewer).toContain('【已由确定性 Lint 拥有，不要复查】')
    expect(reviewer).not.toContain('不得小于 300000（5 分钟）')
    expect(reviewer).not.toContain('自动创建缺失父目录')
  })

  // 67 identical @id= pointer errors once buried 2 blocking lint findings, and
  // the compiler concluded the graph was fine. The host owns the exact mapping,
  // so it hands it over instead of restating the rule, and folds the metadata
  // tail so the blocking findings stay legible.
  it('hands over the transition pointer map and folds metadata noise behind executable defects', () => {
    const pointerErrors = CANONICAL_GRAPH_DISTILL_EXAMPLE.transitions.map((transition, index) =>
      `traceability.mappings[${index}].graphRefs '/transitions/@id=${transition.id}' does not exist in the Graph`)
    const noise = [...pointerErrors, ...Array.from({ length: 10 }, (_, index) =>
      `traceability.mappings[${index}].graphRefs '/nodes/ghost${index}' does not exist in the Graph`)]

    const withMap = formatGraphValidationFeedback(pointerErrors, CANONICAL_GRAPH_DISTILL_EXAMPLE)
    expect(withMap).toContain('goal_reached→/transitions/0')
    expect(withMap).toContain('work_failed→/transitions/2')
    // Without a candidate graph the rule is still stated, just without a map.
    expect(formatGraphValidationFeedback(pointerErrors)).toContain('@id')
    expect(formatGraphValidationFeedback(pointerErrors)).not.toContain('→/transitions/0')

    // Metadata alone is never folded — there is nothing more important to read.
    expect(formatGraphValidationFeedback(noise)).not.toContain('条审阅元数据诊断已折叠')

    // With a blocking executable defect present, the tail folds into a class
    // breakdown and the lint finding stays at the top.
    const withBlocking = formatGraphValidationFeedback([
      'lint(error) undeclared-workspace-write at nodes.work.prompt: prompt explicitly writes \'state\'',
      ...noise,
    ], CANONICAL_GRAPH_DISTILL_EXAMPLE)
    expect(withBlocking).toContain('undeclared-workspace-write')
    expect(withBlocking).toContain('条审阅元数据诊断已折叠')
    expect(withBlocking).toContain('先修复上面的可执行缺陷')
    expect(withBlocking.indexOf('undeclared-workspace-write')).toBeLessThan(withBlocking.indexOf('traceability.mappings'))
  })

  // Numeric pointers fail the same way for two reasons the host can state
  // exactly: 1-based off-by-one past the end of the array, and /when aimed at a
  // default edge that has no `when` field. One run lost its last attempt to
  // four such errors with every semantic finding already addressed.
  it('states the legal index range and the when-less edges for failing numeric pointers', () => {
    const errors = [
      "traceability.mappings[9].graphRefs '/transitions/6' does not exist in the Graph",
      "traceability.mappings[9].graphRefs '/transitions/1/when' does not exist in the Graph",
    ]
    const feedback = formatGraphValidationFeedback(errors, CANONICAL_GRAPH_DISTILL_EXAMPLE)
    // 6 transitions → legal 0..5, and /transitions/6 must be called out as absent.
    expect(feedback).toContain('合法下标是 0..5')
    expect(feedback).toContain('不存在 /transitions/6')
    expect(feedback).toContain('下标从 0 开始不是从 1 开始')
    // continue_work (1), work_failed (2), completion_rejected (4), and
    // review_failed (5) carry no `when`.
    expect(feedback).toContain('/transitions/1、/transitions/2、/transitions/4、/transitions/5')
    expect(feedback).toContain('没有 when 字段')
    expect(feedback).toContain('goal_reached→/transitions/0')
    // The @id= selector rule is a different mistake and must not be mixed in.
    expect(feedback).not.toContain('graph_patch_validate 的补丁选择器语法')

    // Without a candidate graph there is nothing to enumerate, but the feedback
    // must not fabricate a range.
    expect(formatGraphValidationFeedback(errors)).not.toContain('合法下标是')
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
