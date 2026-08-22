import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBuiltinFunctionRegistry,
  createBuiltinReducerRegistry,
  freezeLoopGraph,
  GraphStore,
  CapabilityRegistry,
  type EffectProvider,
  type LoopGraphSpec,
} from '../index.js'
import { closeTrajectory } from '../../../trajectory/hub.js'
import { listTrajectoryIndex } from '../../../trajectory/indexStore.js'
import { trajectoryFile } from '../../../trajectory/paths.js'
import { readTrajectory } from '../../../trajectory/reader.js'

const roots: string[] = []
const previous = process.env['META_AGENT_TRAJECTORY']

afterEach(async () => {
  if (previous === undefined) delete process.env['META_AGENT_TRAJECTORY']
  else process.env['META_AGENT_TRAJECTORY'] = previous
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('GraphStore A3 audit projection', () => {
  it('keeps the graph journal authoritative and emits root phase/checkpoint items', async () => {
    process.env['META_AGENT_TRAJECTORY'] = '1'
    const projectDir = await mkdtemp(join(tmpdir(), 'graph-trajectory-'))
    roots.push(projectDir)
    const functions = createBuiltinFunctionRegistry()
    const reducers = createBuiltinReducerRegistry()
    const effects = new CapabilityRegistry<EffectProvider>('effect')
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0',
      id: `trajectory_${Date.now()}`,
      version: 1,
      goal: 'Project graph audit facts.',
      state: {},
      lanes: {},
      nodes: {
        work: { type: 'function', function: 'builtin/identity@1' },
        done: { type: 'terminal', status: 'done' },
        failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'finish', from: 'work', default: true, to: 'done' },
        { id: 'fail', from: 'work', on: 'failure', to: 'failed' },
      ],
      entrypoints: [{ id: 'start', node: 'work' }],
      limits: { maxActivations: 2 },
    }
    const graph = freezeLoopGraph(spec, {
      functions,
      reducers,
      effects,
      agentTools: new Set(),
    }, 1)
    const instanceId = `audit-${Date.now()}`
    const store = await GraphStore.create({ projectDir, instanceId, graph, functions, now: 1 })
    await store.flushTrajectoryProjection()

    const workspaceId = (await store.snapshot()).instance.workspaceId
    const entry = (await listTrajectoryIndex()).find(candidate =>
      candidate.subject.kind === 'graph_instance' &&
      candidate.subject.workspaceId === workspaceId &&
      candidate.subject.instanceId === instanceId)
    expect(entry).toBeDefined()
    const lines = await readTrajectory(trajectoryFile(entry!.trajectoryId))
    expect(lines.map(line => line.item.type)).toEqual([
      'trajectory_meta', 'phase', 'state_checkpoint',
    ])
    expect(lines.find(line => line.item.type === 'phase')?.item).toMatchObject({
      action: 'graph_created',
      journalSequence: 1,
    })
    expect(store.isTrajectoryPersistenceDegraded()).toBe(false)
    // The audit chain is durable per event, so a flushed store has drained it.
    // Execution never waits on this number; it exists so an unbounded backlog is
    // visible before shutdown has to drain it.
    expect(store.trajectoryAuditLag()).toBe(0)
    expect(store.isTrajectoryAuditLagExceeded()).toBe(false)
    await closeTrajectory({ kind: 'graph_instance', workspaceId, instanceId })
  })

  it('reports a non-zero audit lag while projections are still in flight', async () => {
    process.env['META_AGENT_TRAJECTORY'] = '1'
    const projectDir = await mkdtemp(join(tmpdir(), 'graph-trajectory-lag-'))
    roots.push(projectDir)
    const functions = createBuiltinFunctionRegistry()
    const spec: LoopGraphSpec = {
      schemaVersion: 'graph-2.0',
      id: `lag_${Date.now()}`,
      version: 1,
      goal: 'Observe audit lag.',
      state: {},
      lanes: {},
      nodes: {
        work: { type: 'function', function: 'builtin/identity@1' },
        done: { type: 'terminal', status: 'done' },
        failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'finish', from: 'work', default: true, to: 'done' },
        { id: 'fail', from: 'work', on: 'failure', to: 'failed' },
      ],
      entrypoints: [{ id: 'start', node: 'work' }],
      limits: { maxActivations: 2 },
    }
    const graph = freezeLoopGraph(spec, {
      functions,
      reducers: createBuiltinReducerRegistry(),
      effects: new CapabilityRegistry<EffectProvider>('effect'),
      agentTools: new Set(),
    }, 1)
    const instanceId = `lag-${Date.now()}`
    const store = await GraphStore.create({ projectDir, instanceId, graph, functions, now: 1 })
    // graph_created is journalled synchronously; its projection is background.
    // Before any flush the lag must be observable rather than silently zero.
    const lagBeforeFlush = store.trajectoryAuditLag()
    await store.flushTrajectoryProjection()
    expect(lagBeforeFlush).toBeGreaterThan(0)
    expect(store.trajectoryAuditLag()).toBe(0)
    const workspaceId = (await store.snapshot()).instance.workspaceId
    await closeTrajectory({ kind: 'graph_instance', workspaceId, instanceId })
  })
})
