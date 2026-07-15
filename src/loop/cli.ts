/** CLI for the durable-graph-v1 Loop runtime. */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ISubAgentDispatcher } from '../subagent/ISubAgentDispatcher.js'
import {
  ArtifactPlane,
  createDefaultGraphRuntimeCatalog,
  distillLoopGraph,
  freezeLoopGraph,
  GraphKernel,
  GraphStore,
  LaneManager,
  listGraphInstanceRecords,
  MetaAgentGraphAgentExecutor,
  type GraphAgentExecutor,
  type GraphRuntimeCatalog,
  type JsonValue,
  type LoopGraphSpec,
} from './graph/index.js'
import { acquireDaemonLock, releaseDaemonLock } from './daemon.js'
import { HostSchedulerCoordinator } from './host/HostSchedulerCoordinator.js'
import { runUntilQuiescent, tickOnce } from './runner.js'
import { WakeStore } from './wake/WakeStore.js'
import { canonicalWorkspaceRoot, ensureWorkspaceIdentity, forkWorkspaceIdentity } from './workspace/WorkspaceIdentity.js'

export interface LoopCliDeps {
  projectDir: string
  dispatcher?: ISubAgentDispatcher
  /** Replaceable graph_agent execution substrate. Defaults to the MetaAgent adapter. */
  graphAgent?: GraphAgentExecutor
  signal?: AbortSignal
  graphCatalog?: GraphRuntimeCatalog
}

export async function runLoopCli(argv: string[], deps: LoopCliDeps): Promise<string> {
  const [command, ...args] = argv
  switch (command) {
    case 'distill':
    case 'distill-graph': return distill(args, deps)
    case 'create':
    case 'create-graph': return create(args, deps)
    case 'list': return list(deps)
    case 'inspect': return inspect(args, deps)
    case 'event': return event(args, deps)
    case 'lane-repair': return laneRepair(args, deps)
    case 'tick': return tick(args, deps)
    case 'pause': return lifecycle('pause', args, deps)
    case 'resume': return lifecycle('resume', args, deps)
    case 'stop': return lifecycle('stop', args, deps)
    case 'workspace-info': return workspaceInfo(deps)
    case 'workspace-fork': return workspaceFork(deps)
    case 'schedulers': return schedulers()
    case 'host-capacity': return hostCapacity()
    case 'capabilities': return capabilities(deps)
    default: return usage()
  }
}

function catalog(deps: LoopCliDeps): GraphRuntimeCatalog {
  return deps.graphCatalog ?? createDefaultGraphRuntimeCatalog()
}

async function distill(args: string[], deps: LoopCliDeps): Promise<string> {
  if (!deps.dispatcher) throw new Error('loop distill needs a backend dispatcher')
  const file = positional(args)
  if (!file) throw new Error('loop distill: requirement document path required')
  const out = flagValue(args, '--out') ?? 'loop.graph.draft.json'
  const result = await distillLoopGraph(await readFile(resolve(deps.projectDir, file), 'utf8'), {
    dispatcher: deps.dispatcher,
    catalog: catalog(deps),
    signal: deps.signal,
    projectDir: deps.projectDir,
  })
  await writeFile(resolve(deps.projectDir, out), JSON.stringify(result.graph, null, 2), 'utf8')
  if (result.taskSpec) await writeFile(resolve(deps.projectDir, 'loop.graph.review.md'), result.taskSpec, 'utf8')
  return `LoopGraphSpec written to ${out} (validated, ${result.attempts} attempt(s)); review then run: meta-agent loop create ${out}`
}

async function create(args: string[], deps: LoopCliDeps): Promise<string> {
  const file = positional(args)
  if (!file) throw new Error('loop create: graph JSON path required')
  const graph = JSON.parse(await readFile(resolve(deps.projectDir, file), 'utf8')) as LoopGraphSpec
  if (graph.schemaVersion !== 'graph-1.0') throw new Error("loop create only accepts schemaVersion 'graph-1.0'")
  const runtime = catalog(deps)
  const frozen = freezeLoopGraph(graph, runtime)
  const instanceId = flagValue(args, '--id') ?? `${frozen.id}-v${frozen.version}`
  const store = await GraphStore.create({ projectDir: deps.projectDir, instanceId, graph: frozen, functions: runtime.functions })
  await new WakeStore(deps.projectDir).schedule({ loopId: instanceId, activationId: '__graph__', kind: 'timer', fireAt: Date.now() })
  const snapshot = await store.snapshot()
  return [
    `durable-graph-v1 ${frozen.id}@v${frozen.version} frozen (${frozen.graphHash.slice(0, 12)})`,
    `instance ${snapshot.instance.instanceId} created (status: ${snapshot.instance.status})`,
    'first activation wake scheduled — run: meta-agent loop tick',
  ].join('\n')
}

async function list(deps: LoopCliDeps): Promise<string> {
  const records = await listGraphInstanceRecords(deps.projectDir)
  return records.length
    ? records.map(record => `${record.instanceId}  ${record.status}${record.statusReason ? `  (${record.statusReason})` : ''}  engine=${record.engine}  graph=${record.graphId}@v${record.graphVersion}`).join('\n')
    : '(no loop instances)'
}

async function inspect(args: string[], deps: LoopCliDeps): Promise<string> {
  const instanceId = positional(args)
  if (!instanceId) throw new Error('loop inspect: instanceId required')
  const store = new GraphStore(deps.projectDir, instanceId)
  const snapshot = await store.snapshot().catch(() => null)
  if (!snapshot) return `instance ${instanceId} not found`
  const wakes = (await new WakeStore(deps.projectDir).list()).filter(wake =>
    wake.loopId === instanceId && (wake.status === 'pending' || wake.status === 'claimed'),
  )
  const artifacts = await new ArtifactPlane(store).list({ maxItems: 10 })
  const statuses = ['ready', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const
  const counts = Object.fromEntries(statuses.map(status => [status, [...snapshot.activations.values()].filter(item => item.status === status).length]))
  return [
    `instance: ${instanceId}  status: ${snapshot.instance.status}${snapshot.instance.statusReason ? ` (${snapshot.instance.statusReason})` : ''}  engine: ${snapshot.instance.engine}`,
    `graph: ${snapshot.instance.graphId}@v${snapshot.instance.graphVersion}  hash: ${snapshot.instance.graphHash.slice(0, 12)}`,
    `state: version=${snapshot.state.version} values=${JSON.stringify(snapshot.state.values)}`,
    `activations: ${JSON.stringify(counts)} total=${snapshot.instance.activationCount}`,
    `cost: $${snapshot.instance.totalCostUsd.toFixed(4)}`,
    `wakes: ${wakes.map(wake => `${wake.kind}:${wake.activationId ?? '-'}@${new Date(wake.fireAt).toISOString()}[${wake.status}]`).join(', ') || '(none)'}`,
    `artifacts/evidence: ${artifacts.length}`,
    ...artifacts.map(item => `  ${item.id} ${item.kind}/${item.channel} [${item.status}] from ${item.provenance.nodeId}`),
  ].join('\n')
}

async function event(args: string[], deps: LoopCliDeps): Promise<string> {
  const positionals = positionalValues(args)
  const [instanceId, name] = positionals
  if (!instanceId || !name) throw new Error('loop event: instanceId and event name required')
  const store = new GraphStore(deps.projectDir, instanceId)
  const graph = await store.loadSpec()
  const runtime = catalog(deps)
  const kernel = await GraphKernel.open({ store, graph, ...runtime })
  const correlation = jsonFlag(args, '--correlation')
  const payload = jsonFlag(args, '--payload')
  const resumed = await kernel.signalEvent({ name, ...(correlation !== undefined ? { correlation } : {}), ...(payload !== undefined ? { payload } : {}) })
  if (resumed) await new WakeStore(deps.projectDir).schedule({ loopId: instanceId, activationId: '__graph__', kind: 'manual', fireAt: Date.now() })
  return `${instanceId}: event '${name}' resumed ${resumed} activation(s)`
}

async function laneRepair(args: string[], deps: LoopCliDeps): Promise<string> {
  const [instanceId, laneId] = positionalValues(args)
  if (!instanceId || !laneId) throw new Error('loop lane-repair: instanceId and laneId required')
  const store = new GraphStore(deps.projectDir, instanceId)
  const snapshot = await store.snapshot()
  const graph = await store.loadSpec()
  const lane = await new LaneManager(store, graph, snapshot.instance).repair(laneId)
  if (lane.status === 'conflicted') return `${instanceId}/${laneId}: still conflicted (${lane.error ?? 'unknown'})`
  const pausedForThisLane = snapshot.instance.status === 'paused' &&
    snapshot.instance.statusReason?.includes(`Lane '${laneId}' requires repair`)
  if (pausedForThisLane) {
    await store.setStatus('active', `Lane ${laneId} repaired`)
    await new WakeStore(deps.projectDir).schedule({ loopId: instanceId, activationId: '__graph__', kind: 'manual', fireAt: Date.now() })
  }
  return `${instanceId}/${laneId}: ${lane.status}`
}

async function lifecycle(action: 'pause' | 'resume' | 'stop', args: string[], deps: LoopCliDeps): Promise<string> {
  const instanceId = positional(args)
  if (!instanceId) throw new Error(`loop ${action}: instanceId required`)
  const store = new GraphStore(deps.projectDir, instanceId)
  const snapshot = await store.snapshot().catch(() => null)
  if (!snapshot) return `instance ${instanceId} not found`
  const reason = flagValue(args, '--reason')
  const wakes = new WakeStore(deps.projectDir)
  if (action === 'pause') {
    const record = await store.setStatus('paused', reason ?? 'paused by operator')
    await wakes.cancelForLoop(instanceId)
    return `${instanceId}: paused  (status: ${record.status})`
  }
  if (action === 'resume') {
    if (snapshot.instance.status !== 'paused') return `${instanceId}: not paused  (status: ${snapshot.instance.status})`
    const graph = await store.loadSpec()
    const runtime = catalog(deps)
    const resumableTerminal = [...snapshot.activations.values()].some(activation => {
      const node = graph.nodes[activation.nodeId]
      return activation.status === 'succeeded' && !activation.resumedAt && node?.type === 'terminal' && node.status === 'paused'
    })
    const record = resumableTerminal
      ? (await (await GraphKernel.open({ store, graph, ...runtime })).resumePausedTerminal()).instance
      : await store.setStatus('active', reason ?? 'resumed by operator')
    await wakes.schedule({ loopId: instanceId, activationId: '__graph__', kind: 'manual', fireAt: Date.now() })
    return `${instanceId}: resumed  (status: ${record.status})`
  }
  await store.setStatus('failed', reason ?? 'stopped by operator')
  await wakes.cancelForLoop(instanceId)
  return `${instanceId}: stopped  (status: failed)`
}

async function tick(args: string[], deps: LoopCliDeps): Promise<string> {
  const graphAgent = deps.graphAgent ?? (deps.dispatcher ? new MetaAgentGraphAgentExecutor(deps.dispatcher) : undefined)
  if (!graphAgent) throw new Error('loop tick needs a graph_agent executor')
  const lockPath = join(resolve(deps.projectDir), '.loop', 'daemon.lock')
  const token = await acquireDaemonLock(lockPath)
  if (!token) throw new Error('loop tick refused: another scheduler owns this workspace')
  const host = new HostSchedulerCoordinator()
  let workspaceLease: Awaited<ReturnType<HostSchedulerCoordinator['acquireWorkspaceLease']>> | undefined
  try {
    const identity = await ensureWorkspaceIdentity(deps.projectDir)
    workspaceLease = await host.acquireWorkspaceLease(identity, deps.projectDir)
    const tickDeps = {
      graphAgent,
      projectDir: deps.projectDir,
      signal: deps.signal,
      graphCatalog: deps.graphCatalog,
      hostCoordinator: host,
      workspaceIdentity: identity,
    }
    if (args.includes('--until-quiescent')) {
      const results = await runUntilQuiescent(tickDeps)
      return `ran ${results.reduce((sum, result) => sum + result.claimed, 0)} graph tick(s); now quiescent`
    }
    const result = await tickOnce(tickDeps)
    if (!result.claimed) return 'no wakes due'
    return result.outcomes.map(outcome => outcome.graphOutcome
      ? `${outcome.loopId}: claimed=${outcome.graphOutcome.claimed} committed=${outcome.graphOutcome.committed} parked=${outcome.graphOutcome.parked} status=${outcome.graphOutcome.instance.status}`
      : `${outcome.loopId}: ERROR ${outcome.error}`).join('\n')
  } finally {
    await workspaceLease?.release().catch(() => undefined)
    await releaseDaemonLock(lockPath, token)
  }
}

async function workspaceInfo(deps: LoopCliDeps): Promise<string> {
  const identity = await ensureWorkspaceIdentity(deps.projectDir)
  return `workspaceId: ${identity.workspaceId}\nroot: ${await canonicalWorkspaceRoot(deps.projectDir)}\ncreatedAt: ${new Date(identity.createdAt).toISOString()}`
}

async function workspaceFork(deps: LoopCliDeps): Promise<string> {
  const lockPath = join(resolve(deps.projectDir), '.loop', 'daemon.lock')
  const token = await acquireDaemonLock(lockPath)
  if (!token) throw new Error('workspace-fork requires the scheduler to be stopped')
  try {
    const before = await ensureWorkspaceIdentity(deps.projectDir)
    const after = await forkWorkspaceIdentity(deps.projectDir)
    return `workspace forked: ${before.workspaceId} -> ${after.workspaceId}`
  } finally { await releaseDaemonLock(lockPath, token) }
}

async function schedulers(): Promise<string> {
  const snapshot = await new HostSchedulerCoordinator().snapshot()
  return snapshot.workspaces.length
    ? snapshot.workspaces.map(item => `${item.workspaceId} pid=${item.pid} heartbeat=${new Date(item.heartbeatAt).toISOString()} root=${item.workspaceRoot}`).join('\n')
    : '(no live loop schedulers)'
}

async function hostCapacity(): Promise<string> {
  const snapshot = await new HostSchedulerCoordinator().snapshot()
  return `graph ticks: ${snapshot.leases.filter(item => item.kind === 'graph_tick').length}/${snapshot.maxConcurrentGraphTicks}\nmodel calls: ${snapshot.leases.filter(item => item.kind === 'model_call').length}/${snapshot.maxConcurrentModelCalls}`
}

function capabilities(deps: LoopCliDeps): string {
  const runtime = catalog(deps)
  return [
    'Functions:', ...runtime.functions.manifests().map(item => `  ${item.id}@${item.version} ${item.integrity}`),
    'Reducers:', ...runtime.reducers.manifests().map(item => `  ${item.id}@${item.version} ${item.integrity}`),
    'Effects:', ...runtime.effects.manifests().map(item => `  ${item.id}@${item.version} ${item.integrity}`),
    'Context Providers:', ...runtime.contextProviders.manifests().map(item => `  ${item.id}@${item.version} trust=${item.trust} ${item.integrity}`),
    'Capability Packs:', ...runtime.packs.list().map(item => `  ${item.id}@${item.version} ${item.integrity}`),
    'Scenario Guidance:', ...runtime.packs.scenarios().map(item => `  ${item.id} from ${item.pack.id}@${item.pack.version} — ${item.description}`),
  ].join('\n')
}

function usage(): string {
  return [
    'Usage: meta-agent loop <command>',
    '  distill <requirements.md> [--out loop.graph.json]',
    '  create <loop.graph.json> [--id instanceId]',
    '  tick [--until-quiescent]',
    '  event <instanceId> <name> [--correlation JSON] [--payload JSON]',
    '  lane-repair <instanceId> <laneId>',
    '  list | inspect <instanceId> | pause/resume/stop <instanceId>',
    '  capabilities | workspace-info | workspace-fork | schedulers | host-capacity',
  ].join('\n')
}

function positional(args: string[]): string | undefined { return positionalValues(args)[0] }

function positionalValues(args: string[]): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!
    if (value.startsWith('--')) { index++; continue }
    values.push(value)
  }
  return values
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function jsonFlag(args: string[], flag: string): JsonValue | undefined {
  const value = flagValue(args, flag)
  return value === undefined ? undefined : JSON.parse(value) as JsonValue
}
