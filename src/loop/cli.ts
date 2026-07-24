/** CLI for the durable-graph-v2 Loop runtime. */
import { access, constants as fsConstants, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import type { ISubAgentDispatcher } from '../subagent/ISubAgentDispatcher.js'
import type { ProviderId } from '../providers/registry.js'
import {
  createFileDistillCheckpointStore,
  createDefaultGraphRuntimeCatalog,
  buildLoopReliabilityProfile,
  diagnoseLoop,
  DISTILL_ARTIFACT_FILES,
  distillLoopGraph,
  formatGraphLintFindings,
  freezeLoopGraph,
  lintLoopGraph,
  GraphKernel,
  GraphStore,
  graphPhaseLabel,
  listGraphInstanceRecords,
  MetaAgentGraphAgentExecutor,
  validateLoopPreconditions,
  writeDistillArtifacts,
  type GraphDistillExecutor,
  type GraphDistillProgressEvent,
  type GraphAgentExecutor,
  type GraphRuntimeCatalog,
  type GraphProgressListener,
  type JsonValue,
  type LoopGraphSpec,
  type LoopPreconditions,
} from './graph/index.js'
import { acquireDaemonLock, releaseDaemonLock } from './daemon.js'
import { HostSchedulerCoordinator } from './host/HostSchedulerCoordinator.js'
import { ProviderCircuitBreaker } from './host/ProviderCircuitBreaker.js'
import { deliverGraphEvent } from './ingress/GraphEventDelivery.js'
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
  /** Provider used by this CLI backend; lets operator resume reset its host-wide circuit. */
  providerId?: ProviderId
}

export async function runLoopCli(argv: string[], deps: LoopCliDeps): Promise<string> {
  const [command, ...args] = argv
  switch (command) {
    case 'distill':
    case 'distill-graph': return distill(args, deps)
    case 'create':
    case 'create-graph': return create(args, deps)
    case 'list': return list(args, deps)
    case 'inspect': return inspect(args, deps)
    case 'timeline': return timeline(args, deps)
    case 'files': return files(args, deps)
    case 'disk': return disk(args, deps)
    case 'events': return events(args, deps)
    case 'archive': return archive(args, deps)
    case 'gc': return gc(args, deps)
    case 'event': return event(args, deps)
    case 'tick': return tick(args, deps)
    case 'pause': return lifecycle('pause', args, deps)
    case 'resume': return lifecycle('resume', args, deps)
    case 'recover': return recover(args, deps)
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
  const out = flagValue(args, '--out') ?? 'loop.graph.json'
  const result = await distillLoopGraph({ requirement: file, projectDir: deps.projectDir }, {
    executor: deps.distillExecutor,
    catalog: catalog(deps),
    signal: deps.signal,
    onProgress: deps.onDistillProgress,
    checkpoint: createFileDistillCheckpointStore(deps.projectDir),
  })
  await writeDistillArtifacts(deps.projectDir, out, result)
  const attempts = result.phaseAttempts
    ? `architect=${result.phaseAttempts.architect}, compiler=${result.phaseAttempts.compiler}, reviewer=${result.phaseAttempts.reviewer}`
    : `compiler=${result.attempts}`
  return `Loop Blueprint and LoopGraphSpec written (${out}, loop.design.md, loop.semantic-review.md; validated; ${attempts}); review then run: meta-agent loop create ${out}`
}

async function create(args: string[], deps: LoopCliDeps): Promise<string> {
  const file = positional(args)
  if (!file) throw new Error('loop create: graph JSON path required')
  const graph = JSON.parse(await readFile(resolve(deps.projectDir, file), 'utf8')) as LoopGraphSpec
  if (graph.schemaVersion !== 'graph-2.0') throw new Error("loop create only accepts schemaVersion 'graph-2.0'")
  const runtime = catalog(deps)
  const frozen = freezeLoopGraph(graph, runtime)
  // Lint findings never block create — a human hand-authoring a graph may
  // overrule a heuristic — but they are printed so nothing fails silently at
  // the first activation instead.
  const lintReport = formatGraphLintFindings(lintLoopGraph(graph)).map(finding => `warning: ${finding}`)
  const preconditionReport = await checkLaunchPreconditions(deps.projectDir, graph, args.includes('--force'))
  const instanceId = flagValue(args, '--id') ?? `${frozen.id}-v${frozen.version}`
  const store = await GraphStore.create({ projectDir: deps.projectDir, instanceId, graph: frozen, functions: runtime.functions })
  await new WakeStore(deps.projectDir).schedule({ loopId: instanceId, activationId: '__graph__', kind: 'timer', fireAt: Date.now() })
  const snapshot = await store.snapshot()
  const scmLanes = Object.entries(frozen.lanes).filter(([, lane]) => lane.scm === 'git').map(([laneId]) => laneId)
  return [
    `durable-graph-v2 ${frozen.id}@v${frozen.version} frozen (${frozen.graphHash.slice(0, 12)})`,
    ...scmLanes.map(laneId => `notice: lane '${laneId}' has git commit access (.git writable; hooks/config remain protected)`),
    ...lintReport,
    ...preconditionReport,
    `instance ${snapshot.instance.instanceId} created (status: ${snapshot.instance.status})`,
    'first activation wake scheduled — run: meta-agent loop tick',
  ].join('\n')
}

/**
 * Machine-checkable launch gate. Distill writes loop.preconditions.json next
 * to the graph; here file/directory items are verified against the real
 * project and blocking decision/command/credential items require explicit
 * `--force` acknowledgement. Lane read paths that do not exist yet are
 * surfaced as warnings only — loops legitimately bootstrap their own state.
 */
async function checkLaunchPreconditions(projectDir: string, graph: LoopGraphSpec, force: boolean): Promise<string[]> {
  const lines: string[] = []
  const blockers: string[] = []
  const preconditions = await readJsonIfPresent<LoopPreconditions>(resolve(projectDir, DISTILL_ARTIFACT_FILES.preconditions))
  if (preconditions) {
    const shapeErrors = validateLoopPreconditions(preconditions)
    if (shapeErrors.length) throw new Error(`loop create: invalid ${DISTILL_ARTIFACT_FILES.preconditions}:\n- ${shapeErrors.join('\n- ')}`)
    for (const item of preconditions.items) {
      const blocking = item.blocking !== false
      if (item.kind === 'file' || item.kind === 'directory') {
        const exists = await pathExists(resolve(projectDir, item.target), item.kind)
        if (exists) continue
        const message = `${item.kind} '${item.target}' is missing — ${item.reason}`
        if (blocking) blockers.push(message)
        else lines.push(`warning: ${message}`)
      } else if (item.kind === 'command') {
        // Commands are mechanically verifiable: resolve on PATH like `command -v`.
        const found = await commandOnPath(item.target)
        if (found) { lines.push(`precondition ok: command '${item.target}' → ${found}`); continue }
        const message = `command '${item.target}' is not on PATH — ${item.reason}`
        if (blocking) blockers.push(message)
        else lines.push(`warning: ${message}`)
      } else if (item.kind === 'credential') {
        // A credential named like an environment variable and present with a
        // non-empty value is verified; otherwise it may live in a config file
        // and needs a human to vouch for it.
        if (/^[A-Z][A-Z0-9_]*$/.test(item.target) && (process.env[item.target] ?? '').trim().length > 0) {
          lines.push(`precondition ok: credential '${item.target}' present in environment`)
          continue
        }
        const message = `credential '${item.target}' requires manual confirmation (not set in this environment; it may live in a config file) — ${item.reason}`
        if (blocking) blockers.push(message)
        else lines.push(`note: ${message}`)
      } else {
        const message = `${item.kind} '${item.target}' requires manual confirmation — ${item.reason}`
        if (blocking) blockers.push(message)
        else lines.push(`note: ${message}`)
      }
    }
  }
  for (const [laneId, lane] of Object.entries(graph.lanes ?? {})) {
    for (const path of lane.workspace?.read ?? []) {
      if (path === '**') continue
      if (!(await pathExists(resolve(projectDir, path), 'any'))) {
        lines.push(`warning: lane '${laneId}' reads '${path}' which does not exist yet — confirm the loop bootstraps it or create it before ticking`)
      }
    }
  }
  if (blockers.length && !force) {
    throw new Error([
      'loop create: launch preconditions are not satisfied:',
      ...blockers.map(item => `- ${item}`),
      'Fix missing files/commands first; for the confirmation items (credentials, decisions), verify them yourself and re-run with --force to acknowledge.',
    ].join('\n'))
  }
  if (blockers.length) lines.push(...blockers.map(item => `forced past precondition: ${item}`))
  return lines
}

async function readJsonIfPresent<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch { return null }
}

async function pathExists(path: string, kind: 'file' | 'directory' | 'any'): Promise<boolean> {
  try {
    const info = await stat(path)
    if (kind === 'file') return info.isFile()
    if (kind === 'directory') return info.isDirectory()
    return true
  } catch { return false }
}

/** Resolve a bare command name on PATH (the mechanical half of `command -v`). */
async function commandOnPath(command: string): Promise<string | null> {
  if (!command.trim() || command.includes('/') || command.includes('\\')) return null
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, command)
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch { /* keep scanning */ }
  }
  return null
}

async function list(args: string[], deps: LoopCliDeps): Promise<string> {
  const records = await listGraphInstanceRecords(deps.projectDir)
  if (args.includes('--json')) return prettyJson({
    schemaVersion: 'loop-list-1.0',
    instances: records,
  })
  return records.length
    ? records.map(record => `${record.instanceId}  ${record.status}${record.statusReason ? `  (${record.statusReason})` : ''}  engine=${record.engine}  graph=${record.graphId}@v${record.graphVersion}`).join('\n')
    : '(no loop instances)'
}

async function inspect(args: string[], deps: LoopCliDeps): Promise<string> {
  const instanceId = positional(args)
  if (!instanceId) throw new Error('loop inspect: instanceId required')
  const store = new GraphStore(deps.projectDir, instanceId)
  const snapshot = await store.snapshot().catch(() => null)
  if (!snapshot) return notFound(args, instanceId)
  const wakes = (await new WakeStore(deps.projectDir).list()).filter(wake =>
    wake.loopId === instanceId && (wake.status === 'pending' || wake.status === 'claimed'),
  )
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
  const reliability = buildLoopReliabilityProfile(graph, { generatedAt: now })
  const diagnostics = diagnoseLoop(graph, {
    instance: snapshot.instance,
    state: snapshot.state,
    activations: [...snapshot.activations.values()],
    externalEvents: [...snapshot.externalEvents.values()],
    wakes,
  }, now)
  if (args.includes('--json')) return prettyJson({
    schemaVersion: 'loop-inspect-1.0',
    generatedAt: now,
    instance: snapshot.instance,
    graph: { id: graph.id, version: graph.version, hash: graph.graphHash },
    state: snapshot.state,
    activationCounts: counts,
    totalActivationCount: snapshot.instance.activationCount,
    cost: { usedUsd: snapshot.instance.totalCostUsd, maxUsd: graph.limits.maxCostUsd ?? null },
    wakes,
    activePhases: active.map(item => ({
      activation: item,
      phase: graphPhaseLabel(graph.nodes[item.nodeId]!, item.nodeId),
    })),
    recentPhaseResults: recent,
    reliability,
    diagnostics,
  })
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
  ].join('\n')
}

async function timeline(args: string[], deps: LoopCliDeps): Promise<string> {
  const instanceId = positional(args)
  if (!instanceId) throw new Error('loop timeline: instanceId required')
  const requested = Number(flagValue(args, '--limit') ?? 30)
  if (!Number.isInteger(requested) || requested < 1 || requested > 1_000) throw new Error('loop timeline: --limit must be an integer in 1..1000')
  const store = new GraphStore(deps.projectDir, instanceId)
  const graph = await store.loadSpec().catch(() => null)
  if (!graph) return notFound(args, instanceId)
  const journal = await store.readJournal()
  const selected = journal.slice(-requested)
  if (args.includes('--json')) return prettyJson({
    schemaVersion: 'loop-timeline-1.0',
    instanceId,
    showing: selected.length,
    total: journal.length,
    events: selected,
  })
  return [
    `timeline: ${instanceId}  showing=${selected.length}/${journal.length}`,
    ...selected.map(item => {
      const event = item.event
      const prefix = `#${item.sequence} ${new Date(event.at).toISOString()} ${event.type}`
      switch (event.type) {
        case 'graph_created': return `${prefix} status=${event.instance.status} entries=${event.activations.map(a => a.nodeId).join(',')}`
        case 'activation_claimed': return `${prefix} node=${event.activation.nodeId} attempt=${event.activation.attempt} segment=${event.activation.segmentCount ?? 0}`
        case 'activation_released': return `${prefix} node=${event.activation.nodeId} status=${event.activation.status} reason=${event.reason}${event.activation.summary ? ` — ${event.activation.summary}` : ''}`
        case 'activation_blocked': return `${prefix} node=${event.activation.nodeId} category=${event.failure.category} — ${event.failure.message}`
        case 'activation_committed': return `${prefix} node=${event.activation.nodeId} outcome=${event.activation.outcome ?? event.activation.status} transition=${event.transitionId ?? '-'} spawned=${event.spawned.map(a => a.nodeId).join(',') || '-'}${event.activation.summary ? ` — ${event.activation.summary}` : ''}`
        case 'graph_status_changed': return `${prefix} status=${event.instance.status}${event.instance.statusReason ? ` — ${event.instance.statusReason}` : ''}`
        case 'paused_terminal_resumed': return `${prefix} node=${event.activation.nodeId} transition=${event.transitionId}`
        case 'external_event_recorded': return `${prefix} name=${event.externalEvent.name} status=${event.externalEvent.status}${externalDeliveryLabel(event.externalEvent)}`
        case 'external_event_consumed': return `${prefix} name=${event.externalEvent.name} activations=${event.activations.length}${externalDeliveryLabel(event.externalEvent)}`
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
  const lines = [`files: ${instanceId}  direct Lane workspace contracts`]
  for (const [laneId, lane] of Object.entries(graph.lanes)) {
    lines.push(`  lane ${laneId}`)
    for (const path of lane.workspace.read ?? []) {
      const info = await stat(resolve(store.projectDir, path)).catch(() => null)
      lines.push(`    read   ${path}  ${info ? formatBytes(info.size) : '(missing)'}`)
    }
    for (const rule of lane.workspace.write ?? []) {
      const info = await stat(resolve(store.projectDir, rule.path)).catch(() => null)
      lines.push(`    write  ${rule.path}  mode=${rule.mode}  ${info ? formatBytes(info.size) : '(not created)'}`)
    }
    for (const path of lane.workspace.deny ?? []) lines.push(`    deny   ${path}`)
  }
  if (lines.length === 1) lines.push('  (graph declares no Lane workspace contract)')
  return lines.join('\n')
}

async function disk(args: string[], deps: LoopCliDeps): Promise<string> {
  const instanceId = positional(args)
  if (!instanceId) throw new Error('loop disk: instanceId required')
  const store = new GraphStore(deps.projectDir, instanceId)
  const rootInfo = await stat(store.paths.root).catch(() => null)
  if (!rootInfo) return notFound(args, instanceId)
  const entries = await readdir(store.paths.root, { withFileTypes: true })
  const sizes = await Promise.all(entries.map(async entry => ({
    name: entry.name,
    bytes: await filesystemSize(join(store.paths.root, entry.name)),
  })))
  const total = sizes.reduce((sum, item) => sum + item.bytes, 0)
  const laneWorktrees = await filesystemSize(join(store.paths.lanesDir, 'worktrees'))
  const [journalFiles, activationFiles, commitIntentFiles, effectIntentFiles, eventFiles, checkpointInfo] = await Promise.all([
    countJsonFiles(store.paths.journalDir),
    countJsonFiles(store.paths.activationsDir),
    countJsonFiles(store.paths.intentsDir),
    countJsonFiles(store.paths.effectIntentsDir),
    countJsonFiles(store.paths.eventsDir),
    stat(store.paths.checkpointJson).catch(() => null),
  ])
  const journalBytes = await filesystemSize(store.paths.journalDir)
  const metrics = {
    checkpointBytes: checkpointInfo?.size ?? 0,
    activationFiles,
    looseJournalFiles: journalFiles,
    looseJournalBytes: journalBytes,
    averageLooseJournalBytes: journalFiles ? Math.round(journalBytes / journalFiles) : 0,
    commitIntentFiles,
    effectIntentFiles,
    eventFiles,
  }
  if (args.includes('--json')) return prettyJson({
    schemaVersion: 'loop-disk-1.0', instanceId, totalBytes: total,
    partitions: sizes.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)),
    laneWorktreeBytes: laneWorktrees,
    metrics,
  })
  return [
    `disk: ${instanceId}  total=${formatBytes(total)}`,
    ...sizes.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)).map(item => `  ${item.name}: ${formatBytes(item.bytes)}`),
    `  lane worktrees: ${formatBytes(laneWorktrees)}${laneWorktrees ? ' (execution workspaces, not logs)' : ''}`,
  ].join('\n')
}

async function events(args: string[], deps: LoopCliDeps): Promise<string> {
  const instanceId = positional(args)
  if (!instanceId) throw new Error('loop events: instanceId required')
  const requestedStatus = flagValue(args, '--status')
  if (requestedStatus !== undefined && requestedStatus !== 'pending' && requestedStatus !== 'consumed') {
    throw new Error('loop events: --status must be pending or consumed')
  }
  const store = new GraphStore(deps.projectDir, instanceId)
  const snapshot = await store.snapshot().catch(() => null)
  if (!snapshot) return notFound(args, instanceId)
  const selected = [...snapshot.externalEvents.values()]
    .filter(item => requestedStatus === undefined || item.status === requestedStatus)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  if (args.includes('--json')) return prettyJson({
    schemaVersion: 'loop-events-1.0', instanceId, status: requestedStatus ?? 'all', events: selected,
  })
  return [
    `events: ${instanceId}  status=${requestedStatus ?? 'all'}  count=${selected.length}`,
    ...selected.map(item => `${item.id}  ${item.status}  ${item.name}${externalDeliveryLabel(item)}  created=${new Date(item.createdAt).toISOString()}${item.consumedAt ? `  consumed=${new Date(item.consumedAt).toISOString()}` : ''}`),
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
    if (!['done', 'exhausted', 'failed'].includes(snapshot.instance.status)) {
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

async function filesystemSize(path: string): Promise<number> {
  const info = await lstat(path).catch(() => null)
  if (!info) return 0
  if (!info.isDirectory() || info.isSymbolicLink()) return info.size
  const entries = await readdir(path).catch(() => [])
  const sizes = await Promise.all(entries.map(entry => filesystemSize(join(path, entry))))
  return sizes.reduce((sum, size) => sum + size, 0)
}

async function countJsonFiles(path: string): Promise<number> {
  return (await readdir(path).catch(() => [])).filter(name => name.endsWith('.json')).length
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)}KiB`
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)}MiB`
  return `${(bytes / 1_073_741_824).toFixed(1)}GiB`
}

function externalDeliveryLabel(event: { source?: string; deliveryId?: string }): string {
  return event.source === undefined ? '' : ` delivery=${event.source}:${event.deliveryId}`
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
  const runtime = catalog(deps)
  const correlation = jsonFlag(args, '--correlation')
  const payload = jsonFlag(args, '--payload')
  const source = flagValue(args, '--source')
  const deliveryId = flagValue(args, '--delivery-id')
  const result = await deliverGraphEvent({
    name,
    ...(source !== undefined ? { source } : {}),
    ...(deliveryId !== undefined ? { deliveryId } : {}),
    ...(correlation !== undefined ? { correlation } : {}),
    ...(payload !== undefined ? { payload } : {}),
  }, {
    projectDir: deps.projectDir,
    instanceId,
    catalog: runtime,
  })
  const delivery = result.event.source === undefined
    ? ''
    : ` delivery=${result.event.source}:${result.event.deliveryId}`
  return result.duplicate
    ? `${instanceId}: duplicate event '${name}' deduplicated; resumed ${result.resumed} activation(s)${delivery}`
    : `${instanceId}: event '${name}' resumed ${result.resumed} activation(s)${delivery}`
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
    if (deps.providerId) {
      const host = new HostSchedulerCoordinator()
      await new ProviderCircuitBreaker({ rootDir: host.rootDir }).reset(deps.providerId)
    }
    const resumed = `${instanceId}: resumed  (status: ${record.status})`
    return args.includes('--run')
      ? `${resumed}\n${await tick(['--until-quiescent'], deps)}`
      : resumed
  }
  await store.setStatus('failed', reason ?? 'stopped by operator')
  await wakes.cancelForLoop(instanceId)
  return `${instanceId}: stopped  (status: failed)`
}

async function recover(args: string[], deps: LoopCliDeps): Promise<string> {
  const sourceInstanceId = positional(args)
  if (!sourceInstanceId) throw new Error('loop recover: source instanceId required')
  const runtime = catalog(deps)
  const records = await listGraphInstanceRecords(deps.projectDir)
  let targetInstanceId = flagValue(args, '--id')
  if (!targetInstanceId) {
    const existing = new Set(records.map(record => record.instanceId))
    for (let index = 1; index <= 10_000; index++) {
      const suffix = `-r${index}`
      const candidate = `${sourceInstanceId.slice(0, 128 - suffix.length)}${suffix}`
      if (!existing.has(candidate)) { targetInstanceId = candidate; break }
    }
  }
  if (!targetInstanceId) throw new Error(`loop recover: could not allocate a recovery id for '${sourceInstanceId}'`)
  const reason = flagValue(args, '--reason') ?? 'operator recovery fork'
  const store = await GraphStore.createRecoveryFork({
    projectDir: deps.projectDir,
    sourceInstanceId,
    targetInstanceId,
    functions: runtime.functions,
    activationId: flagValue(args, '--from'),
    reason,
    allowUnsafe: args.includes('--force'),
  })
  await new WakeStore(deps.projectDir).schedule({
    loopId: targetInstanceId,
    activationId: '__graph__',
    kind: 'manual',
    fireAt: Date.now(),
  })
  const snapshot = await store.snapshot()
  const source = snapshot.instance.recovery!
  const created = `${targetInstanceId}: recovery fork created from ${source.sourceInstanceId}/${source.sourceActivationId}  (status: ${snapshot.instance.status})`
  return args.includes('--run')
    ? `${created}\n${await tick(['--until-quiescent'], deps)}`
    : created
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
      ? `${outcome.loopId}: claimed=${outcome.graphOutcome.claimed} committed=${outcome.graphOutcome.committed} parked=${outcome.graphOutcome.parked} blocked=${outcome.graphOutcome.blocked} status=${outcome.graphOutcome.instance.status}`
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
  const host = new HostSchedulerCoordinator()
  const [snapshot, circuits] = await Promise.all([
    host.snapshot(),
    new ProviderCircuitBreaker({ rootDir: host.rootDir }).snapshot(),
  ])
  return [
    `graph ticks: ${snapshot.leases.filter(item => item.kind === 'graph_tick').length}/${snapshot.maxConcurrentGraphTicks}`,
    `model calls: ${snapshot.leases.filter(item => item.kind === 'model_call').length}/${snapshot.maxConcurrentModelCalls}`,
    `provider circuits: ${circuits.length
      ? circuits.map(item => `${item.providerId}:${item.state}@${new Date(item.retryAt).toISOString()}`).join(', ')
      : '(closed)'}`,
  ].join('\n')
}

function capabilities(deps: LoopCliDeps): string {
  const runtime = catalog(deps)
  return [
    'Functions:', ...runtime.functions.manifests().map(item => `  ${item.id}@${item.version} ${item.integrity}`),
    'Reducers:', ...runtime.reducers.manifests().map(item => `  ${item.id}@${item.version} ${item.integrity}`),
    'Effects:', ...runtime.effects.manifests().map(item => `  ${item.id}@${item.version} ${item.integrity}`),
    'Agent Tools:', ...[...runtime.agentTools].sort().map(item => `  ${item}`),
    'Capability Packs:', ...runtime.packs.list().map(item => `  ${item.id}@${item.version} ${item.integrity}`),
    'Scenario Guidance:', ...runtime.packs.scenarios().map(item => `  ${item.id} from ${item.pack.id}@${item.pack.version} — ${item.description}`),
  ].join('\n')
}

function usage(): string {
  return [
    'Usage: meta-agent loop <command>',
    '  distill <requirements.md> [--out loop.graph.json] [--non-interactive]',
    '  create <loop.graph.json> [--id instanceId] [--force]  (verifies loop.preconditions.json)',
    '  tick [--until-quiescent]',
    '  event <instanceId> <name> [--source NAME --delivery-id ID] [--correlation JSON] [--payload JSON]',
    '  list [--json] | inspect/timeline/disk <instanceId> [--json] | files <instanceId>',
    '  events <instanceId> [--status pending|consumed] [--json]',
    '  pause/resume [--run]/stop/archive <instanceId>',
    '  recover <terminalInstanceId> [--from activationId] [--id newId] [--run] [--force]',
    '  gc [--older-than-days N] [--include-archives] [--apply]',
    '  capabilities | workspace-info | workspace-fork | schedulers | host-capacity',
  ].join('\n')
}

function positional(args: string[]): string | undefined { return positionalValues(args)[0] }

function positionalValues(args: string[]): string[] {
  const values: string[] = []
  const booleanFlags = new Set(['--until-quiescent', '--non-interactive', '--apply', '--include-archives', '--force', '--json', '--run'])
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

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function notFound(args: string[], instanceId: string): string {
  return args.includes('--json')
    ? prettyJson({ schemaVersion: 'loop-error-1.0', error: 'instance_not_found', instanceId })
    : `instance ${instanceId} not found`
}
