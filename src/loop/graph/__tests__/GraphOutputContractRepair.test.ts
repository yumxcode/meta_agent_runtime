import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDefaultGraphRuntimeCatalog,
  freezeLoopGraph,
  GraphKernel,
  GraphStore,
  type GraphAgentExecutionRequest,
  type LoopGraphSpec,
} from '../index.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('Graph Agent output-contract repair', () => {
  it('repairs only the structured result in a fresh readonly seat', async () => {
    const fixture = await createFixture('repair-success')
    const requests: GraphAgentExecutionRequest[] = []
    const kernel = await GraphKernel.open({
      store: fixture.store,
      graph: fixture.graph,
      ...fixture.catalog,
      graphAgent: {
        id: 'contract-repair-test',
        async execute(request) {
          requests.push(request)
          return requests.length === 1
            ? completed('subtask-original', { count: 1 }, 'Research completed; trend=improved.', 3)
            : completed('subtask-repair', { count: 1, trend: 'improved' }, 'Added the explicitly supported trend.', 1)
        },
      },
    })

    await kernel.tick()
    const activation = [...(await fixture.store.snapshot()).activations.values()].find(item => item.nodeId === 'work')!

    expect(requests).toHaveLength(2)
    expect(requests[0]?.outputSchema).toEqual(fixture.outputSchema)
    expect(requests[1]).toMatchObject({
      outputSchema: fixture.outputSchema,
      allowedTools: [],
      limits: { turns: 6, usd: 1, wallTimeMs: 120_000 },
      workspace: { mode: 'shared_readonly', writeAllowPaths: [] },
    })
    expect(requests[1]?.continuity).not.toHaveProperty('lineageSessionId')
    expect(requests[1]?.prompt.system).toContain('output-contract repair seat')
    expect(requests[1]?.prompt.user).toContain('$output.trend is required')
    expect(activation).toMatchObject({
      status: 'succeeded', outcome: 'success', output: { count: 1, trend: 'improved' },
      usage: { turns: 4, costUsd: 0.04, durationMs: 40 },
    })
    expect(activation.summary).toContain('contract repair subtask-repair for subtask-original')
  })

  it('preserves the original candidate and both subtask IDs when repair still violates the schema', async () => {
    const fixture = await createFixture('repair-failed')
    let calls = 0
    const kernel = await GraphKernel.open({
      store: fixture.store,
      graph: fixture.graph,
      ...fixture.catalog,
      graphAgent: {
        id: 'contract-repair-test',
        async execute() {
          calls++
          return calls === 1
            ? completed('subtask-original', { count: 2 }, 'Candidate without a trend.', 2)
            : completed('subtask-repair', { count: 2 }, 'Could not determine a trend.', 1)
        },
      },
    })

    await kernel.tick()
    const activation = [...(await fixture.store.snapshot()).activations.values()].find(item => item.nodeId === 'work')!

    expect(calls).toBe(2)
    expect(activation).toMatchObject({
      status: 'failed', outcome: 'failure',
      output: {
        error: 'output schema mismatch',
        details: ['$output.trend is required'],
        candidateOutput: { count: 2 },
        candidateSummary: 'Candidate without a trend.',
        subtaskId: 'subtask-original',
        contractRepair: {
          status: 'failed',
          subtaskId: 'subtask-repair',
          reason: 'contract repair output schema mismatch',
          details: ['$output.trend is required'],
          candidateOutput: { count: 2 },
        },
      },
    })
  })
})

async function createFixture(instanceId: string) {
  const projectDir = await mkdtemp(join(tmpdir(), 'graph-contract-repair-'))
  roots.push(projectDir)
  const catalog = createDefaultGraphRuntimeCatalog()
  const outputSchema = {
    type: 'object' as const,
    required: ['count', 'trend'],
    properties: {
      count: { type: 'integer' as const, minimum: 0 },
      trend: { type: 'string' as const, enum: ['improved', 'unchanged'] },
    },
    additionalProperties: false,
  }
  const source: LoopGraphSpec = {
    schemaVersion: 'graph-2.0', id: 'contract_repair', version: 1, goal: 'Repair output without repeating work.', state: {},
    lanes: {
      work: {
        context: 'persistent',
        workspace: { read: ['**'], write: [{ path: 'state', mode: 'owned' }] },
      },
    },
    nodes: {
      work: {
        type: 'agent', lane: 'work', prompt: 'Perform expensive external research once.',
        tools: ['write_file'], outputSchema, maxAttempts: 2,
      },
      done: { type: 'terminal', status: 'done' },
      failed: { type: 'terminal', status: 'failed' },
    },
    transitions: [
      { id: 'done', from: 'work', on: 'success', to: 'done' },
      { id: 'failed', from: 'work', on: 'failure', to: 'failed' },
    ],
    entrypoints: [{ id: 'start', node: 'work' }],
    limits: { maxActivations: 3 },
  }
  const graph = freezeLoopGraph(source, catalog, 1)
  const store = await GraphStore.create({ projectDir, instanceId, graph, functions: catalog.functions, now: 1 })
  return { projectDir, catalog, graph, store, outputSchema }
}

function completed(taskId: string, output: Record<string, unknown>, summary: string, turns: number) {
  return {
    kind: 'completed' as const,
    taskId,
    success: true,
    output,
    summary,
    usage: { turns, costUsd: turns * 0.01, durationMs: turns * 10 },
  }
}
