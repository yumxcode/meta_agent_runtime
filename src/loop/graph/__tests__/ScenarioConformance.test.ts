import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArtifactPlane,
  createDefaultGraphRuntimeCatalog,
  freezeLoopGraph,
  GraphKernel,
  GraphStore,
  type GraphAgentExecutor,
  type LoopGraphSpec,
} from '../index.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const usage = { turns: 1, costUsd: 0.01, durationMs: 1 }

describe('cross-scenario Graph conformance', () => {
  it('executes an open-ended research loop on a persistent Lane with a custom evidence plane', async () => {
    const root = await temporary('scenario-research-')
    let calls = 0
    const agent: GraphAgentExecutor = {
      id: 'test/research-agent@1',
      async execute() {
        calls++
        return {
          kind: 'completed', taskId: `research-${calls}`, success: true,
          output: { finding: `observation-${calls}`, goal_complete: calls >= 2 }, summary: 'ok', usage,
        }
      },
    }
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-1.0', id: 'research-conformance', version: 1, goal: 'Explore until sufficient evidence exists',
      annotations: { scenario: 'research', domain: 'arbitrary' },
      state: { iteration: { type: { type: 'integer', minimum: 0 }, initial: 0 } },
      lanes: {
        explorer: { context: 'persistent', workspace: 'readonly', dataAccess: { publish: ['observations'] } },
      },
      dataPlanes: {
        observations: {
          backend: 'record', semanticRole: 'user-defined observations', trust: 'untrusted_data', recordKind: 'evidence',
          schema: { type: 'object', required: ['finding', 'goal_complete'], properties: { finding: { type: 'string' }, goal_complete: { type: 'boolean' } }, additionalProperties: false },
          mutability: 'append_only', admission: 'automatic', retention: { maxItems: 20 },
        },
      },
      dataViews: { observations: { plane: 'observations', statuses: ['admitted'], maxItems: 10 } },
      nodes: {
        explore: {
          type: 'agent', lane: 'explorer', prompt: 'Explore one useful direction.', maxAttempts: 2,
          outputSchema: { type: 'object', required: ['finding', 'goal_complete'], properties: { finding: { type: 'string' }, goal_complete: { type: 'boolean' } }, additionalProperties: false },
          publishes: [{ plane: 'observations', value: { ref: '$output' } }],
        },
        done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'complete', from: 'explore', when: '$output.goal_complete == true', priority: 10, to: 'done' },
        { id: 'continue', from: 'explore', default: true, updates: [{ target: 'iteration', reducer: 'builtin/increment@1' }], to: 'explore' },
        { id: 'failed', from: 'explore', on: 'failure', to: 'failed' },
      ],
      entrypoints: [{ id: 'start', node: 'explore' }], limits: { maxActivations: 8 },
    }
    const { store, kernel } = await open(root, spec, agent)
    await untilTerminal(kernel)
    expect((await store.snapshot()).instance.status).toBe('done')
    expect((await new ArtifactPlane(store).list({ kind: 'evidence' }))).toHaveLength(2)
  })

  it('executes a release workflow with an idempotent Effect outbox and durable approval event', async () => {
    const root = await temporary('scenario-release-')
    const catalog = createDefaultGraphRuntimeCatalog()
    let submits = 0
    catalog.effects.register({
      manifest: { id: 'test/deploy', version: '1', integrity: 'test:deploy-v1', pure: false },
      async submit(input, key) { submits++; return { release: input.release, key } },
    })
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-1.0', id: 'release-conformance', version: 1, goal: 'Deploy then await promotion approval',
      state: {}, lanes: {}, nodes: {
        deploy: { type: 'effect', effect: 'test/deploy@1', inputs: { release: { literal: 'v1' } }, idempotencyKey: { literal: 'release-v1' }, timeoutMs: 10_000 },
        approval: { type: 'wait', wait: { kind: 'event', event: 'release-approved', correlation: { literal: 'v1' }, timeoutMs: 10_000 } },
        done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
      }, transitions: [
        { id: 'deployed', from: 'deploy', to: 'approval' }, { id: 'deploy-failed', from: 'deploy', on: 'failure', to: 'failed' },
        { id: 'approved', from: 'approval', on: 'event', to: 'done' }, { id: 'approval-timeout', from: 'approval', on: 'timeout', to: 'failed' },
        { id: 'approval-failed', from: 'approval', on: 'failure', to: 'failed' },
      ], entrypoints: [{ id: 'start', node: 'deploy' }], limits: { maxActivations: 6, maxPendingTimers: 2 },
    }
    const graph = freezeLoopGraph(spec, catalog, 1)
    const store = await GraphStore.create({ projectDir: root, graph, functions: catalog.functions })
    const kernel = await GraphKernel.open({ store, graph, ...catalog, owner: 'test' })
    await kernel.tick()
    await kernel.tick()
    await kernel.signalEvent({ name: 'release-approved', correlation: 'v1', payload: { approved: true } })
    await untilTerminal(kernel)
    expect((await store.snapshot()).instance.status).toBe('done')
    expect(submits).toBe(1)
  })

  it('executes parallel compliance reviews on independent Lanes and joins their publications', async () => {
    const root = await temporary('scenario-compliance-')
    const agent: GraphAgentExecutor = {
      id: 'test/compliance-agent@1',
      async execute(request) {
        const reviewer = request.prompt.user.includes('review_a') ? 'a' : 'b'
        return { kind: 'completed', taskId: reviewer, success: true, output: { reviewer, compliant: true }, summary: 'ok', usage }
      },
    }
    const assessmentSchema = { type: 'object', required: ['reviewer', 'compliant'], properties: { reviewer: { type: 'string' }, compliant: { type: 'boolean' } }, additionalProperties: false } as const
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-1.0', id: 'compliance-conformance', version: 1, goal: 'Collect independent reviews',
      state: {}, lanes: {
        review_a: { context: 'fresh_per_activation', workspace: 'readonly', dataAccess: { publish: ['assessments'] } },
        review_b: { context: 'fresh_per_activation', workspace: 'readonly', dataAccess: { publish: ['assessments'] } },
      }, dataPlanes: {
        assessments: { backend: 'record', semanticRole: 'independent policy assessments', trust: 'untrusted_data', recordKind: 'artifact', schema: assessmentSchema, mutability: 'append_only', admission: 'automatic' },
      }, dataViews: { assessments: { plane: 'assessments', statuses: ['admitted'], maxItems: 10 } },
      nodes: {
        fork: { type: 'function', function: 'builtin/identity@1' },
        review_a: { type: 'agent', lane: 'review_a', prompt: 'Perform review_a.', outputSchema: assessmentSchema, publishes: [{ plane: 'assessments', value: { ref: '$output' } }] },
        review_b: { type: 'agent', lane: 'review_b', prompt: 'Perform review_b.', outputSchema: assessmentSchema, publishes: [{ plane: 'assessments', value: { ref: '$output' } }] },
        join: { type: 'join', mode: 'all', expects: ['a-joined', 'b-joined'] },
        done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
      }, transitions: [
        { id: 'forked', from: 'fork', to: ['review_a', 'review_b'] }, { id: 'fork-failed', from: 'fork', on: 'failure', to: 'failed' },
        { id: 'a-joined', from: 'review_a', to: 'join' }, { id: 'a-failed', from: 'review_a', on: 'failure', to: 'failed' },
        { id: 'b-joined', from: 'review_b', to: 'join' }, { id: 'b-failed', from: 'review_b', on: 'failure', to: 'failed' },
        { id: 'joined', from: 'join', to: 'done' },
      ], entrypoints: [{ id: 'start', node: 'fork' }], limits: { maxActivations: 10 }, concurrency: { maxActivations: 2, maxPerNode: 2 },
    }
    const { store, kernel } = await open(root, spec, agent)
    await untilTerminal(kernel)
    expect((await store.snapshot()).instance.status).toBe('done')
    expect((await new ArtifactPlane(store).list({ kind: 'artifact' }))).toHaveLength(2)
  })
})

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function open(root: string, spec: LoopGraphSpec, graphAgent: GraphAgentExecutor) {
  const catalog = createDefaultGraphRuntimeCatalog()
  const graph = freezeLoopGraph(spec, catalog, 1)
  const store = await GraphStore.create({ projectDir: root, graph, functions: catalog.functions })
  const kernel = await GraphKernel.open({ store, graph, ...catalog, graphAgent, owner: 'test' })
  return { store, kernel }
}

async function untilTerminal(kernel: GraphKernel): Promise<void> {
  for (let index = 0; index < 20; index++) {
    const result = await kernel.tick()
    if (result.instance.status === 'done' || result.instance.status === 'failed') return
  }
  throw new Error('scenario did not terminate')
}
