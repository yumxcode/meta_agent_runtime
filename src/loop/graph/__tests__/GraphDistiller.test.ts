import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  buildGraphDistillerSystem,
  createDefaultGraphRuntimeCatalog,
  distillLoopGraph,
  freezeLoopGraph,
  parseGraphDistillOutput,
  validateLoopGraph,
  type LoopGraphSpec,
} from '../index.js'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../../subagent/types.js'

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
    const dispatcher: ISubAgentDispatcher = {
      async spawnSubAgent(options) {
        const output = outputs[calls++]
        return {
          schemaVersion: '1.0', taskId: `subtask-${calls}`, parentSessionId: 'parent', status: 'completed',
          config: options.config as SubAgentRecord['config'], createdAt: 1, completedAt: 2, pendingHumanApproval: false,
          result: { success: true, summary: 'done', output, turnsUsed: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 },
        }
      },
      async getStatus() { return null }, async cancelTask() { return true },
    }
    const result = await distillLoopGraph('Create any useful loop.', {
      dispatcher, catalog: createDefaultGraphRuntimeCatalog(), maxAttempts: 1,
    })
    expect(result.graph.nodes).toHaveProperty('calculate')
    expect(calls).toBe(2)
  })
})
