import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  CANONICAL_GRAPH_DISTILL_EXAMPLE,
  buildGraphSemanticReviewerSystem,
  buildGraphDistillerSystem,
  createDefaultGraphRuntimeCatalog,
  distillLoopGraph,
  freezeLoopGraph,
  formatGraphValidationFeedback,
  parseGraphDistillOutput,
  reviseLoopGraph,
  validateLoopGraph,
  type GraphDistillExecutor,
  type LoopGraphSpec,
} from '../index.js'

const graph: LoopGraphSpec = {
  schemaVersion: 'graph-1.0', id: 'distilled', version: 1, goal: 'test', state: {}, lanes: {},
  nodes: {
    calculate: { type: 'function', function: 'builtin/identity@1' },
    done: { type: 'terminal', status: 'done' },
  },
  transitions: [
    { id: 'done', from: 'calculate', to: 'done' },
    { id: 'failed', from: 'calculate', on: 'failure', to: 'done' },
  ],
  entrypoints: [{ id: 'start', node: 'calculate' }],
  limits: { maxActivations: 3 },
}

const source = { requirement: 'requirements.md', projectDir: '/workspace/project' }

describe('Graph Distill compiler contract', () => {
  it('describes the complete current Graph runtime and explicitly rejects legacy Loop IR', () => {
    const prompt = buildGraphDistillerSystem(createDefaultGraphRuntimeCatalog())
    expect(prompt).toContain('唯一现行 Loop 架构 durable-graph-v1')
    expect(prompt).toContain('不得输出或假设 Charter')
    expect(prompt).toContain('六种 NodeSpec')
    expect(prompt).toContain('Agent/Function/Effect 为 success|failure')
    expect(prompt).toContain('persistent Lane')
    expect(prompt).toContain('graph_agent SPI')
    expect(prompt).toContain('不得输出 mode 字段')
    expect(prompt).toContain('ContextSectionSpec')
    expect(prompt).toContain('builtin/data-plane-view@1')
    expect(prompt).toContain('activation_start')
    expect(prompt).toContain('agentProfile.systemInstructions')
    expect(prompt).toContain('dataPlanes')
    expect(prompt).toContain('dataViews')
    expect(prompt).toContain('Lane dataAccess 是权限上限')
    expect(prompt).toContain('Distill 不得输出物理 artifacts/artifactViews/evidenceViews/workspaceBindings')
    expect(prompt).toContain('只有部署端已加载、版本锁定的 Capability Pack/Runtime 能扩展能力目录')
    expect(prompt).toContain('Runtime 不给每个节点注入全局最多 100 条 Evidence/Artifact')
    expect(prompt).toContain('长生命周期 Agent Activation')
    expect(prompt).toContain('$state')
    expect(prompt).toContain('Event 与 timeout 按发生时间 first-wins')
    expect(prompt).toContain('CommitCoordinator')
    expect(prompt).toContain('commitKey')
    expect(prompt).toContain('Artifact/Evidence')
    expect(prompt).toContain('不得伪造锁和 provider')
    expect(prompt).toContain('threshold 使用更新前 State 正确换算')
    expect(prompt).toContain('builtin/increment@1')
    expect(prompt).toContain('Scenario guidance 是可组合的领域知识，不是固定模板')
    expect(prompt).toContain('可调用 ask_user 当场询问')
    expect(prompt).toContain('不会注入需求文件正文')
    expect(prompt).toContain('【ShapeSpec 嵌套规则')
    expect(prompt).toContain('"iteration":{"type":{"type":"integer","minimum":0}')
    expect(prompt).toContain('"outputSchema":{"type":"object"')
    expect(prompt).toContain('经当前 Validator 与 Freeze 真实校验的最小完整 source Graph')
    expect(prompt).toContain(JSON.stringify(CANONICAL_GRAPH_DISTILL_EXAMPLE, null, 2))
    expect(prompt).toContain('graph_created、activation_claimed')
    expect(prompt).not.toContain('action=answer')
    expect(prompt).not.toContain('action=revise')
  })

  it('keeps the embedded canonical source graph executable as the ABI evolves', () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    expect(validateLoopGraph(CANONICAL_GRAPH_DISTILL_EXAMPLE, catalog)).toEqual([])
    expect(() => freezeLoopGraph(CANONICAL_GRAPH_DISTILL_EXAMPLE, catalog, 1)).not.toThrow()
  })

  it('turns the two observed ShapeSpec mistakes into explicit repair instructions', () => {
    const feedback = formatGraphValidationFeedback([
      'state.iteration.minimum is not part of the executable Graph ABI; put non-executable domain metadata under annotations',
      'state.iteration.type must be a ShapeSpec object',
      'nodes.work.outputSchema.type must be one of object|array|string|number|integer|boolean|null; received object {"type":"object"}',
      "transitions[0].to.inputs.result references '$output.is_stale', but 'is_stale' is below non-object schema type object {\"type\":\"object\"}",
    ])
    expect(feedback).toContain('state.x={"type":{"type":"integer","minimum":0},"initial":0}')
    expect(feedback).toContain('outputSchema 本身直接就是 ShapeSpec')
    expect(feedback).toContain('禁止写成 outputSchema.type=')
  })

  it('gives the independent reviewer enough runtime semantics without prescribing topology', () => {
    const prompt = buildGraphSemanticReviewerSystem()
    expect(prompt).toContain('长生命周期 Activation')
    expect(prompt).toContain('persistent Lane')
    expect(prompt).toContain('materialize workspace 文件的 canonical owner 是 Kernel')
    expect(prompt).toContain('producer→consumer 可见性')
    expect(prompt).toContain('publication→Data View→consumer context')
    expect(prompt).toContain('不要规定节点数量')
    expect(prompt).toContain('不要重做 ABI lint')
  })

  it('reports a double-wrapped output schema with the received shape instead of object coercion', () => {
    const malformed = structuredClone(CANONICAL_GRAPH_DISTILL_EXAMPLE) as unknown as Record<string, unknown>
    const nodes = malformed.nodes as Record<string, Record<string, unknown>>
    nodes.work!.outputSchema = { type: { type: 'object', properties: { complete: { type: 'boolean' } } } }
    const errors = validateLoopGraph(malformed as unknown as LoopGraphSpec, createDefaultGraphRuntimeCatalog())
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('ShapeSpec directly owns this string discriminator'),
    ]))
    expect(errors.join('\n')).toContain('received object {"type":"object"')
    expect(errors.join('\n')).not.toContain("schema type '[object Object]'")
  })

  it('parses the structured channel and yields a statically valid arbitrary graph', () => {
    const parsed = parseGraphDistillOutput({ graph, taskSpec: 'review assumptions' })
    expect(parsed?.taskSpec).toBe('review assumptions')
    expect(validateLoopGraph(parsed!.graph, createDefaultGraphRuntimeCatalog())).toEqual([])
  })

  it('validates the simulated x1_loop.md distill output against the default catalog', async () => {
    const source = await readFile('docs/examples/x1-loop.distill-output.json', 'utf8')
    const parsed = parseGraphDistillOutput(JSON.parse(source))
    expect(parsed).not.toBeNull()
    const catalog = createDefaultGraphRuntimeCatalog()
    expect(validateLoopGraph(parsed!.graph, catalog)).toEqual([])
    const frozen = freezeLoopGraph(parsed!.graph, catalog, 1)
    expect(parsed!.graph.nodes.research_cycle?.type).toBe('agent')
    expect(parsed!.graph.nodes.research_cycle).toMatchObject({
      lane: 'research',
      timerPolicy: { allowHardPark: true, maxDelayMs: 3_600_000, maxParks: 144 },
    })
    expect(Object.values(parsed!.graph.nodes).some(node => node.type === 'effect')).toBe(false)
    expect(parsed!.graph.dataPlanes?.progress_file).toMatchObject({
      backend: 'workspace',
      binding: { plane: 'state_projection', direction: 'materialize', lane: 'research' },
    })
    expect(parsed!.graph.dataPlanes?.findings_file).toMatchObject({
      backend: 'workspace',
      binding: { plane: 'evidence', direction: 'materialize', appendOnly: true },
    })
    expect(parsed!.graph.lanes.research?.dataAccess).toMatchObject({
      publish: ['research_history', 'accepted_findings', 'directions', 'reports'],
      write: ['work_log'],
    })
    expect(frozen.workspaceBindings?.dp_progress_file).toMatchObject({
      plane: 'state_projection', direction: 'materialize', lane: 'research',
      projection: { kind: 'state' },
    })
    expect(frozen.compiledLaneDataAccess?.research?.writeBindings).toEqual(['dp_work_log'])
    const cycle = frozen.nodes.research_cycle
    expect(cycle.type).toBe('agent')
    if (cycle.type === 'agent') {
      expect(cycle.context?.sections.some(section => section.provider === 'builtin/data-plane-view@1')).toBe(false)
      expect(cycle.context?.sections.some(section => section.provider === 'builtin/workspace-binding@1')).toBe(true)
      expect(cycle.publishes?.every(publication => Boolean(publication.channel) && !publication.plane)).toBe(true)
    }
    expect(parsed!.taskSpec).toContain('逻辑 Data Plane')
    expect(parsed!.taskSpec).toContain('Freeze')
    expect(parsed!.taskSpec).toContain('Agent 不再双写')
  })

  it('uses an independent semantic reviewer without imposing a scenario topology', async () => {
    const outputs: unknown[] = [
      { graph, taskSpec: 'A deliberately small but valid topology.' },
      { accepted: true, issues: [] },
    ]
    let calls = 0
    const requests: string[] = []
    const executor: GraphDistillExecutor = {
      async execute(request) {
        requests.push(request.taskDescription)
        return { status: 'completed', output: outputs[calls++] }
      },
    }
    const result = await distillLoopGraph(source, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 1,
    })
    expect(result.graph.nodes).toHaveProperty('calculate')
    expect(calls).toBe(2)
    expect(requests[1]).toContain('机械提取的 producer→consumer 可见性清单')
  })

  it('injects ABI-aware repair guidance into the next compiler attempt', async () => {
    const malformed = structuredClone(CANONICAL_GRAPH_DISTILL_EXAMPLE) as unknown as Record<string, unknown>
    const state = malformed.state as Record<string, Record<string, unknown>>
    state.iteration = { type: 'integer', minimum: 0, initial: 0 }
    const requests: string[] = []
    const outputs: unknown[] = [
      { graph: malformed, taskSpec: 'first draft' },
      { graph: CANONICAL_GRAPH_DISTILL_EXAMPLE, taskSpec: 'fixed nesting' },
      { accepted: true, issues: [] },
    ]
    const executor: GraphDistillExecutor = {
      async execute(request) {
        requests.push(request.taskDescription)
        return { status: 'completed', output: outputs.shift() }
      },
    }
    const result = await distillLoopGraph(source, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 2,
    })
    expect(result.attempts).toBe(2)
    expect(requests[1]).toContain('【定向修复提示】')
    expect(requests[1]).toContain('StateVariableSpec 与 ShapeSpec 是两层')
  })

  it('passes only the requirement entrypoint and project address, then lets agents read them', async () => {
    const requests: Array<{ phase: string; taskDescription: string; allowedTools: readonly string[] }> = []
    const executor: GraphDistillExecutor = {
      async execute(request) {
        requests.push(request)
        return request.phase === 'compiler'
          ? { status: 'completed', output: { graph, taskSpec: 'Read from the workspace.' } }
          : { status: 'completed', output: { accepted: true, issues: [] } }
      },
    }

    await distillLoopGraph({ requirement: 'x1_loop.md', projectDir: '/workspace/agibot_x1_train_oma' }, {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 1,
    })

    expect(requests[0]?.taskDescription).toContain('用户的 Loop 需求是：x1_loop.md')
    expect(requests[0]?.taskDescription).toContain('项目地址是：/workspace/agibot_x1_train_oma')
    expect(requests[0]?.taskDescription).toContain('先使用 read_file 自行读取需求文件')
    expect(requests[0]?.allowedTools).toEqual(expect.arrayContaining(['read_file', 'grep', 'glob']))
    expect(requests[1]?.taskDescription).toContain('用户的 Loop 需求是：x1_loop.md')
    expect(requests[1]?.allowedTools).toEqual(expect.arrayContaining(['read_file', 'grep', 'glob']))
  })

  it('revises the current draft from human feedback in the persistent compiler conversation', async () => {
    const revisedGraph = { ...graph, goal: 'test with an explicit human review constraint' }
    const requests: Array<{ phase: string; sessionKey?: string; taskDescription: string; allowedTools: readonly string[] }> = []
    const outputs: unknown[] = [
      { graph: revisedGraph, taskSpec: 'Applied the requested constraint.' },
      { accepted: true, issues: [] },
    ]
    const executor: GraphDistillExecutor = {
      async execute(request) {
        requests.push(request)
        return { status: 'completed', output: outputs.shift() }
      },
    }

    const result = await reviseLoopGraph(source, { graph, taskSpec: 'initial' }, 'Keep the route deterministic.', {
      executor, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 1,
    })

    expect(result.graph.goal).toContain('human review constraint')
    expect(requests[0]).toMatchObject({ phase: 'compiler', sessionKey: 'distill-compiler' })
    expect(requests[0]?.taskDescription).toContain('Keep the route deterministic.')
    expect(requests[0]?.allowedTools).toContain('ask_user')
    expect(requests[1]?.phase).toBe('semantic_review')
    expect(requests[1]?.sessionKey).toBeUndefined()
    expect(requests[1]?.taskDescription).toContain('用户在后续 Distill turn 中新增的约束与意见')
  })
})
