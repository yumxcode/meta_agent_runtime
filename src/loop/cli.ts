/** CLI for the durable-graph-v1 Loop runtime. */
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ISubAgentDispatcher } from '../subagent/ISubAgentDispatcher.js'
import {
  ArtifactPlane,
  createDefaultGraphRuntimeCatalog,
  distillLoopGraph,
  freezeLoopGraph,
  GraphKernel,
  GraphStore,
  graphPhaseLabel,
  LaneManager,
  listGraphInstanceRecords,
  MetaAgentGraphAgentExecutor,
  type GraphDistillExecutor,
  type GraphDistillProgressEvent,
  type GraphAgentExecutor,
  type GraphRuntimeCatalog,
  type GraphProgressListener,
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
  /** Foreground compiler/reviewer model boundary used only by loop distill. */
  distillExecutor?: GraphDistillExecutor
  onDistillProgress?: (event: GraphDistillProgressEvent) => void
  /** Replaceable graph_agent execution substrate. Defaults to the MetaAgent adapter. */
  graphAgent?: GraphAgentExecutor
  signal?: AbortSignal
  graphCatalog?: GraphRuntimeCatalog
  onGraphProgress?: GraphProgressListener
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
    case 'timeline': return timeline(args, deps)
    case 'files': return files(args, deps)
    case 'disk': return disk(args, deps)
    case 'archive': return archive(args, deps)
    case 'gc': return gc(args, deps)
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
  if (!deps.distillExecutor) throw new Error('loop distill needs a foreground Distill executor')
  const file = positional(args)
  if (!file) throw new Error('loop distill: requirement document path required')
  const out = flagValue(args, '--out') ?? 'loop.graph.draft.json'
  const result = await distillLoopGraph({ requirement: file, projectDir: deps.projectDir }, {
    executor: deps.distillExecutor,
    catalog: catalog(deps),
    signal: deps.signal,
    onProgress: deps.onDistillProgress,
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
  const graph = await store.loadSpec()
  const statuses = ['ready', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const
  const counts = Object.fromEntries(statuses.map(status => [status, [...snapshot.activations.values()].filter(item => item.status === status).length]))
  const now = Date.now()
  const active = [...snapshot.activations.values()]
    .filter(item => item.status === 'running' || item.status === 'waiting')
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
  const recent = [...snapshot.activations.values()]
    .filter(item => item.status === 'succeeded' || item.status === 'failed')
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
    .slice(0, 5)
  return [
    `instance: ${instanceId}  status: ${snapshot.instance.status}${snapshot.instance.statusReason ? ` (${snapshot.instance.statusReason})` : ''}  engine: ${snapshot.instance.engine}`,
    `graph: ${snapshot.instance.graphId}@v${snapshot.instance.graphVersion}  hash: ${snapshot.instance.graphHash.slice(0, 12)}`,
    `state: version=${snapshot.state.version} values=${JSON.stringify(snapshot.state.values)}`,
    `activations: ${JSON.stringify(counts)} total=${snapshot.instance.activationCount}`,
    `cost: $${snapshot.instance.totalCostUsd.toFixed(4)}`,
    `wakes: ${wakes.map(wake => `${wake.kind}:${wake.activationId ?? '-'}@${new Date(wake.fireAt).toISOString()}[${wake.status}]`).join(', ') || '(none)'}`,
    `active phases: ${active.length || '(none)'}`,
    ...active.map(item => {
      const node = graph.nodes[item.nodeId]!
      const phase = graphPhaseLabel(node, item.nodeId)
      const timing = item.status === 'running'
        ? `running for ${formatElapsed(now - (item.firstStartedAt ?? item.updatedAt))}`
        : item.wakeAt ? `waiting until ${new Date(item.wakeAt).toISOString()}` : 'waiting for event'
      const reason = item.summary ? ` — ${item.summary}` : ''
      return `  ${item.nodeId} [${item.status}] a${item.attempt}:s${item.segmentCount ?? 0} ${timing}: ${phase}${reason}`
    }),
    `recent phase results: ${recent.length || '(none)'}`,
    ...recent.map(item => `  ${item.nodeId} [${item.outcome ?? item.status}] ${item.summary ?? item.error ?? '(no summary recorded)'}`),
    `artifacts/evidence: ${artifacts.length}`,
    ...artifacts.map(item => `  ${item.id} ${item.kind}/${item.channel} [${item.status}] from ${item.provenance.nodeId}`),
  ].join('\n')
}

async function timeline(args: string[], deps: LoopCliDeps): Promise<string> {
  const instanceId = positional(args)
  if (!instanceId) throw new Error('loop timeline: instanceId required')
  const requested = Number(flagValue(args, '--limit') ?? 30)
  if (!Number.isInteger(requested) || requested < 1 || requested > 1_000) throw new Error('loop timeline: --limit must be an integer in 1..1000')
  const store = new GraphStore(deps.projectDir, instanceId)
  const graph = await store.loadSpec().catch(() => null)
  if (!graph) return `instance ${instanceId} not found`
  const journal = await store.readJournal()
  const selected = journal.slice(-requested)
  return [
    `timeline: ${instanceId}  showing=${selected.length}/${journal.length}`,
    ...selected.map(item => {
      const event = item.event
      const prefix = `#${item.sequence} ${new Date(event.at).toISOString()} ${event.type}`
      switch (event.type) {
        case 'graph_created': return `${prefix} status=${event.instance.status} entries=${event.activations.map(a => a.nodeId).join(',')}`
        case 'activation_claimed': return `${prefix} node=${event.activation.nodeId} attempt=${event.activation.attempt} segment=${event.activation.segmentCount ?? 0}`
        case 'activation_released': return `${prefix} node=${event.activation.nodeId} status=${event.activation.status} reason=${event.reason}${event.activation.summary ? ` — ${event.activation.summary}` : ''}`
        case 'activation_context_cached': return `${prefix} node=${event.activation.nodeId} section=${event.sectionName}`
        case 'activation_committed': return `${prefix} node=${event.activation.nodeId} outcome=${event.activation.outcome ?? event.activation.status} transition=${event.transitionId ?? '-'} spawned=${event.spawned.map(a => a.nodeId).join(',') || '-'}${event.activation.summary ? ` — ${event.activation.summary}` : ''}`
        case 'graph_status_changed': return `${prefix} status=${event.instance.status}${event.instance.statusReason ? ` — ${event.instance.statusReason}` : ''}`
        case 'paused_terminal_resumed': return `${prefix} node=${event.activation.nodeId} transition=${event.transitionId}`
        case 'external_event_recorded': return `${prefix} name=${event.externalEvent.name} status=${event.externalEvent.status}`
        case 'external_event_consumed': return `${prefix} name=${event.externalEvent.name} activations=${event.activations.length}`
      }
    }),
  ].join('\n')
}

async function files(args: string[], deps: LoopCliDeps): Promise<string> {
  const instanceId = positional(args)
  if (!instanceId) throw new Error('loop files: instanceId required')
  const store = new GraphStore(deps.projectDir, instanceId)
  const graph = await store.loadSpec().catch(() => null)
  if (!graph) return `instance ${instanceId} not found`
  const logicalByPhysical = new Map(Object.entries(graph.compiledDataPlanes ?? {})
    .flatMap(([logical, ref]) => ref.physicalId ? [[ref.physicalId, logical] as const] : []))
  const lines = [`files: ${instanceId}  canonical workspace projections and inputs`]
  for (const [bindingId, binding] of Object.entries(graph.workspaceBindings ?? {})) {
    const root = await bindingWorkspaceRoot(store, binding.lane, binding.lane ? graph.lanes[binding.lane]?.workspace : undefined)
    const path = root ? resolve(root, binding.path) : undefined
    const info = path ? await stat(path).catch(() => null) : null
    const owner = binding.direction === 'ingest' ? 'workspace/input' : 'Kernel projection'
    lines.push(
      `  ${logicalByPhysical.get(bindingId) ?? bindingId}  ${binding.plane}/${binding.direction}  ${binding.lane ? `lane=${binding.lane}` : 'project'}:${binding.path}  ${info ? `${formatBytes(info.size)} ${owner}` : `(missing) ${owner}`}`,
    )
  }
  const artifacts = await new ArtifactPlane(store).list({ maxItems: 10_000 })
  const counts = new Map<string, number>()
  for (const artifact of artifacts) counts.set(artifact.channel, (counts.get(artifact.channel) ?? 0) + 1)
  if (counts.size) {
    lines.push('records:')
    for (const [channel, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${logicalByPhysical.get(channel) ?? channel}  ${count} record(s)`)
    }
  }
  if (lines.length === 1) lines.push('  (graph declares no workspace files or records)')
  return lines.join('\n')
}

async function disk(args: string[], deps: LoopCliDeps): Promise<string> {
  const instanceId = positional(args)
  if (!instanceId) throw new Error('loop disk: instanceId required')
  const store = new GraphStore(deps.projectDir, instanceId)
  const rootInfo = await stat(store.paths.root).catch(() => null)
  if (!rootInfo) return `instance ${instanceId} not found`
  const entries = await readdir(store.paths.root, { withFileTypes: true })
  const sizes = await Promise.all(entries.map(async entry => ({
    name: entry.name,
    bytes: await filesystemSize(join(store.paths.root, entry.name)),
  })))
  const total = sizes.reduce((sum, item) => sum + item.bytes, 0)
  const laneWorktrees = await filesystemSize(join(store.paths.lanesDir, 'worktrees'))
  return [
    `disk: ${instanceId}  total=${formatBytes(total)}`,
    ...sizes.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)).map(item => `  ${item.name}: ${formatBytes(item.bytes)}`),
    `  lane worktrees: ${formatBytes(laneWorktrees)}${laneWorktrees ? ' (execution workspaces, not logs)' : ''}`,
  ].join('\n')
}

async function archive(args: string[], deps: LoopCliDeps): Promise<string> {
  const instanceId = positional(args)
  if (!instanceId) throw new Error('loop archive: instanceId required')
  const loopRoot = join(resolve(deps.projectDir), '.loop')
  const lockPath = join(loopRoot, 'daemon.lock')
  const token = await acquireDaemonLock(lockPath)
  if (!token) throw new Error('loop archive requires the scheduler to be stopped')
  try {
    const store = new GraphStore(deps.projectDir, instanceId)
    const snapshot = await store.snapshot().catch(() => null)
    if (!snapshot) return `instance ${instanceId} not found`
    if (!['done', 'failed'].includes(snapshot.instance.status)) {
      throw new Error(`loop archive refuses non-terminal instance '${instanceId}' (status: ${snapshot.instance.status})`)
    }
    const activeWakes = (await new WakeStore(deps.projectDir).list()).filter(wake =>
      wake.loopId === instanceId && (wake.status === 'pending' || wake.status === 'claimed'))
    if (activeWakes.length) throw new Error(`loop archive refuses '${instanceId}': ${activeWakes.length} active wake(s) remain`)
    const archivedAt = Date.now()
    const archiveRoot = join(loopRoot, 'archive')
    await mkdir(archiveRoot, { recursive: true })
    const destination = join(archiveRoot, `${instanceId}--${archivedAt}`)
    await rename(store.paths.root, destination)
    await writeFile(join(destination, 'archive.json'), `${JSON.stringify({
      schemaVersion: 'graph-archive-1.0', instanceId, archivedAt, status: snapshot.instance.status,
      graphId: snapshot.instance.graphId, graphVersion: snapshot.instance.graphVersion,
    }, null, 2)}\n`, 'utf8')
    return `${instanceId}: archived to ${destination}`
  } finally {
    await releaseDaemonLock(lockPath, token)
  }
}

async function gc(args: string[], deps: LoopCliDeps): Promise<string> {
  const days = Number(flagValue(args, '--older-than-days') ?? 7)
  if (!Number.isFinite(days) || days < 1) throw new Error('loop gc: --older-than-days must be >= 1')
  const apply = args.includes('--apply')
  const includeArchives = args.includes('--include-archives')
  const cutoff = Date.now() - days * 86_400_000
  const wakes = await new WakeStore(deps.projectDir).list()
  const staleWakes = wakes.filter(wake =>
    (wake.status === 'done' || wake.status === 'cancelled') && wake.updatedAt <= cutoff)
  const archiveRoot = join(resolve(deps.projectDir), '.loop', 'archive')
  const staleArchives: string[] = []
  if (includeArchives) for (const entry of await readdir(archiveRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const root = join(archiveRoot, entry.name)
    const manifest = await readJsonObject(join(root, 'archive.json'))
    const archivedAt = typeof manifest?.archivedAt === 'number' ? manifest.archivedAt : (await stat(root)).mtimeMs
    if (archivedAt <= cutoff) staleArchives.push(root)
  }
  if (apply) {
    await new WakeStore(deps.projectDir).prune(days * 86_400_000)
    for (const root of staleArchives) await rm(root, { recursive: true, force: true })
  }
  return [
    `loop gc ${apply ? 'applied' : 'dry-run'}  older-than=${days}d`,
    `terminal wakes: ${staleWakes.length}`,
    `archives: ${staleArchives.length}${includeArchives ? '' : ' (not scanned; pass --include-archives)'}`,
    ...(!apply && (staleWakes.length || staleArchives.length) ? ['run again with --apply to delete only the listed terminal/archived records'] : []),
  ].join('\n')
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

async function bindingWorkspaceRoot(
  store: GraphStore,
  laneId?: string,
  workspace?: 'readonly' | 'shared_controlled' | 'lane_overlay' | 'effect_only',
): Promise<string | undefined> {
  if (!laneId) return store.projectDir
  if (workspace === 'readonly' || workspace === 'shared_controlled') return store.projectDir
  const lane = await readJsonObject(join(store.paths.lanesDir, `${laneId}.json`))
  return typeof lane?.workspacePath === 'string' ? lane.workspacePath : undefined
}

async function filesystemSize(path: string): Promise<number> {
  const info = await lstat(path).catch(() => null)
  if (!info) return 0
  if (!info.isDirectory() || info.isSymbolicLink()) return info.size
  const entries = await readdir(path).catch(() => [])
  const sizes = await Promise.all(entries.map(entry => filesystemSize(join(path, entry))))
  return sizes.reduce((sum, size) => sum + size, 0)
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)}KiB`
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)}MiB`
  return `${(bytes / 1_073_741_824).toFixed(1)}GiB`
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
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
      onGraphProgress: deps.onGraphProgress,
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
    '  distill <requirements.md> [--out loop.graph.json] [--non-interactive]',
    '  create <loop.graph.json> [--id instanceId]',
    '  tick [--until-quiescent]',
    '  event <instanceId> <name> [--correlation JSON] [--payload JSON]',
    '  lane-repair <instanceId> <laneId>',
    '  list | inspect/timeline/files/disk <instanceId>',
    '  pause/resume/stop/archive <instanceId>',
    '  gc [--older-than-days N] [--include-archives] [--apply]',
    '  capabilities | workspace-info | workspace-fork | schedulers | host-capacity',
  ].join('\n')
}

function positional(args: string[]): string | undefined { return positionalValues(args)[0] }

function positionalValues(args: string[]): string[] {
  const values: string[] = []
  const booleanFlags = new Set(['--until-quiescent', '--non-interactive', '--apply', '--include-archives'])
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!
    if (value.startsWith('--')) {
      if (!booleanFlags.has(value)) index++
      continue
    }
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
