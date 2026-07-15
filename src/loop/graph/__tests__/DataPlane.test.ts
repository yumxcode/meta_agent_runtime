import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArtifactPlane,
  createDefaultGraphRuntimeCatalog,
  freezeLoopGraph,
  GraphKernel,
  GraphStore,
  validateLoopGraph,
  type AgentNodeSpec,
  type GraphAgentExecutionRequest,
  type LoopGraphSpec,
} from '../index.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function logicalGraph(): LoopGraphSpec {
  return {
    schemaVersion: 'graph-1.0', id: 'logical-planes', version: 1, goal: 'Compile arbitrary logical planes',
    state: { iteration: { type: { type: 'integer' }, initial: 0 } },
    lanes: {
      analyst: {
        context: 'persistent', workspace: 'readonly', maxConcurrency: 1,
        dataAccess: {
          read: [
            { plane: 'control', views: ['current_control'] },
            { plane: 'task_definition', views: ['task'] },
            { plane: 'observations', views: ['accepted_observations'] },
            { plane: 'decision_audit', views: ['recent_commits'] },
          ],
          publish: ['observations'],
        },
      },
    },
    dataPlanes: {
      control: {
        backend: 'state', semanticRole: 'deterministic control facts', trust: 'trusted_runtime', stateKeys: ['iteration'],
      },
      task_definition: {
        backend: 'workspace', semanticRole: 'user objective', trust: 'untrusted_data',
        binding: { plane: 'input', path: 'objective.md', format: 'markdown', direction: 'ingest', required: true },
      },
      observations: {
        backend: 'record', semanticRole: 'domain observations', trust: 'untrusted_data', recordKind: 'evidence',
        schema: { type: 'object', required: ['claim'], properties: { claim: { type: 'string', minLength: 1 } }, additionalProperties: false },
        mutability: 'append_only', admission: 'automatic', retention: { maxItems: 20 },
      },
      decision_audit: {
        backend: 'journal', semanticRole: 'decision history', trust: 'untrusted_data', eventTypes: ['activation_committed'],
      },
      observation_file: {
        backend: 'workspace', semanticRole: 'human-readable evidence projection', trust: 'untrusted_data',
        binding: {
          plane: 'evidence', path: 'results/observations.jsonl', format: 'jsonl', direction: 'materialize', appendOnly: true,
          projection: { kind: 'data_view', view: 'accepted_observations', record: 'content' }, required: true,
        },
      },
    },
    dataViews: {
      current_control: { plane: 'control', stateKeys: ['iteration'] },
      task: { plane: 'task_definition' },
      accepted_observations: { plane: 'observations', statuses: ['admitted'], maxItems: 10 },
      recent_commits: { plane: 'decision_audit', eventTypes: ['activation_committed'], maxItems: 5 },
    },
    nodes: {
      analyze: {
        type: 'agent', lane: 'analyst', prompt: 'Analyze one observation.',
        context: { sections: [
          { name: 'control', provider: 'builtin/data-plane-view@1', refresh: 'every_segment', config: { view: 'current_control' } },
          { name: 'task', provider: 'builtin/data-plane-view@1', refresh: 'activation_start', config: { view: 'task' } },
          { name: 'evidence', provider: 'builtin/data-plane-view@1', refresh: 'activation_start', config: { view: 'accepted_observations' } },
          { name: 'audit', provider: 'builtin/data-plane-view@1', refresh: 'activation_start', config: { view: 'recent_commits' } },
        ] },
        outputSchema: { type: 'object', required: ['claim'], properties: { claim: { type: 'string', minLength: 1 } }, additionalProperties: false },
        publishes: [{ plane: 'observations', value: { ref: '$output' } }],
      },
      done: { type: 'terminal', status: 'done' },
      failed: { type: 'terminal', status: 'failed' },
    },
    transitions: [
      { id: 'done', from: 'analyze', updates: [{ target: 'iteration', reducer: 'builtin/increment@1' }], to: 'done' },
      { id: 'failed', from: 'analyze', on: 'failure', to: 'failed' },
    ],
    entrypoints: [{ id: 'start', node: 'analyze' }], limits: { maxActivations: 3 },
  }
}

describe('logical Data Plane compilation and Lane ACL', () => {
  it('compiles arbitrary Plane/View names to fixed backends and executes only the physical graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-data-plane-'))
    roots.push(root)
    await writeFile(join(root, 'objective.md'), 'Inspect walking stability.', 'utf8')
    const catalog = createDefaultGraphRuntimeCatalog()
    const spec = logicalGraph()
    expect(validateLoopGraph(spec, catalog)).toEqual([])
    const frozen = freezeLoopGraph(spec, catalog, 1)
    expect(frozen.compiledDataPlanes).toMatchObject({
      control: { backend: 'state', trust: 'trusted_runtime' },
      observations: { backend: 'record', physicalId: 'dp_observations' },
      task_definition: { backend: 'workspace', physicalId: 'dp_task_definition' },
    })
    expect(frozen.compiledLaneDataAccess?.analyst).toMatchObject({
      publishChannels: ['dp_observations'],
      writeBindings: [],
    })
    expect(frozen.compiledLaneDataAccess?.analyst?.readViews.map(view => view.view)).toEqual([
      'dv_current_control', 'dv_task', 'dv_accepted_observations', 'dv_recent_commits',
    ])
    expect(frozen.artifacts?.dp_observations).toMatchObject({ kind: 'evidence', maxItems: 20 })
    expect(frozen.evidenceViews?.dv_accepted_observations).toMatchObject({ channels: ['dp_observations'], maxItems: 10 })
    expect(frozen.workspaceBindings?.dp_observation_file.projection).toMatchObject({
      kind: 'evidence_view', view: 'dv_accepted_observations', record: 'content',
    })
    const node = frozen.nodes.analyze as AgentNodeSpec
    expect(node.context?.sections.map(section => section.provider)).toEqual([
      'builtin/state@1', 'builtin/workspace-binding@1', 'builtin/evidence-view@1', 'builtin/journal-view@1',
    ])
    expect(node.publishes?.[0]).toMatchObject({ channel: 'dp_observations' })
    expect(node.publishes?.[0]?.plane).toBeUndefined()
    const lockedProviders = frozen.capabilityLock.contextProviders.map(provider => `${provider.id}@${provider.version}`)
    expect(lockedProviders).toEqual(expect.arrayContaining([
      'builtin/activation@1', 'builtin/state@1', 'builtin/workspace-binding@1',
      'builtin/evidence-view@1', 'builtin/journal-view@1',
    ]))
    expect(lockedProviders).not.toContain('builtin/data-plane-view@1')

    const store = await GraphStore.create({ projectDir: root, graph: frozen, functions: catalog.functions, now: 1 })
    let request: GraphAgentExecutionRequest | undefined
    const kernel = await GraphKernel.open({
      store, graph: frozen, ...catalog, now: () => 2,
      graphAgent: {
        id: 'test/data-plane-agent@1',
        async execute(input) {
          request = input
          return { kind: 'completed', taskId: 'task', success: true, output: { claim: 'stable' }, summary: 'ok' }
        },
      },
    })
    expect((await kernel.tick()).committed).toBe(1)
    expect(request?.prompt.user).toContain('Inspect walking stability.')
    expect(request?.prompt.user).toContain('"name": "audit"')
    expect((await new ArtifactPlane(store).list({ channels: ['dp_observations'] }))).toHaveLength(1)
    expect((await readFile(join(root, 'results/observations.jsonl'), 'utf8')).trim()).toBe('{"claim":"stable"}')
  })

  it('rejects trust elevation and Node reads/publications outside the Lane authorization ceiling', () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    const spec = logicalGraph()
    spec.dataPlanes!.observations!.trust = 'trusted_runtime'
    spec.lanes.analyst!.dataAccess!.read = [{ plane: 'control', views: ['current_control'] }]
    spec.lanes.analyst!.dataAccess!.publish = []
    const errors = validateLoopGraph(spec, catalog).join('\n')
    expect(errors).toContain("trust must be 'untrusted_data'")
    expect(errors).toContain("exceeds Lane 'analyst' read access for View 'task'")
    expect(errors).toContain("exceeds Lane 'analyst' publish access for Plane 'observations'")
  })

  it('rejects malformed logical record schemas and retention before Freeze', () => {
    const spec = logicalGraph()
    const observations = spec.dataPlanes!.observations!
    if (observations.backend !== 'record') throw new Error('fixture must be a record Plane')
    observations.schema = {
      type: 'object',
      required: ['missing'],
      properties: { claim: { type: 'string', minLength: -1 } },
      additionalProperties: false,
    } as typeof observations.schema
    observations.retention = { maxItems: 0 }
    const errors = validateLoopGraph(spec, createDefaultGraphRuntimeCatalog()).join('\n')
    expect(errors).toContain('retention.maxItems must be an integer in 1..100000')
    expect(errors).toContain("required 'missing' is missing from properties")
    expect(errors).toContain('minLength must be a non-negative integer')
  })

  it('rejects mixed logical/physical dataflow and Freeze-owned source fields', () => {
    const spec = logicalGraph()
    const analyze = spec.nodes.analyze
    if (analyze.type !== 'agent') throw new Error('fixture must be an Agent')
    analyze.context!.sections[0] = {
      name: 'control', provider: 'builtin/state@1', refresh: 'every_segment', config: { keys: ['iteration'] },
    }
    analyze.publishes![0] = { channel: 'manual', value: { ref: '$output' } }
    spec.artifacts = { manual: { kind: 'evidence' } }
    const errors = validateLoopGraph(spec, createDefaultGraphRuntimeCatalog()).join('\n')
    expect(errors).toContain('artifacts is a physical Freeze output')
    expect(errors).toContain("uses physical Provider 'builtin/state@1'")
    expect(errors).toContain('channel is a physical Freeze output')

    const owned = logicalGraph() as LoopGraphSpec & { graphHash: string }
    owned.graphHash = 'not-a-source-field'
    expect(() => freezeLoopGraph(owned, createDefaultGraphRuntimeCatalog(), 1)).toThrow(/graphHash is Freeze-owned/)
  })

  it('reports malformed LLM-authored Plane fields instead of crashing validation', () => {
    const spec = logicalGraph() as unknown as Record<string, unknown>
    spec.dataPlanes = { broken: null }
    spec.dataViews = { broken: [] }
    ;(spec.lanes as Record<string, Record<string, unknown>>).analyst!.dataAccess = { read: 'all' }
    const errors = validateLoopGraph(spec as unknown as LoopGraphSpec, createDefaultGraphRuntimeCatalog()).join('\n')
    expect(errors).toContain('dataPlanes.broken must be an object')
    expect(errors).toContain('dataViews.broken must be an object')
    expect(errors).toContain('lanes.analyst.dataAccess.read must be an array')
  })
})
