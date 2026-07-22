import type { WakeRecord } from '../../wake/WakeStore.js'
import { lintLoopGraph, type GraphLintFinding } from '../spec/GraphLint.js'
import type {
  ActivationRecord,
  FrozenLoopGraphSpec,
  GraphExternalEventRecord,
  GraphInstanceRecord,
  GraphStateSnapshot,
  JsonValue,
} from '../spec/GraphTypes.js'

export type ReliabilityEvidenceStatus = 'verified' | 'declared' | 'degraded' | 'unknown'

export interface EffectConformanceEvidence {
  provider: string
  status: 'passed' | 'failed' | 'unknown'
  suiteVersion?: string
  verifiedAt?: number
}

export interface IngressEvidence {
  adapter: string
  status: 'verified' | 'declared' | 'unknown'
  authentication?: string
  deliveryId?: boolean
}

export interface LoopReliabilityProfileOptions {
  generatedAt?: number
  effects?: Record<string, EffectConformanceEvidence>
  ingress?: IngressEvidence
  workspaceEnforcement?: 'path-enforced-mode-cooperative' | 'os-enforced'
  durability?: 'process-crash-local-posix' | 'fsync-local-posix' | 'unknown'
  audit?: {
    retention: 'local-full-history' | 'hot-cold-local' | 'external-archive' | 'unknown'
    policy?: string
  }
  evidence?: Array<{ id: string; status: 'passed' | 'failed'; version?: string; verifiedAt?: number }>
}

export interface LoopReliabilityProfile {
  schemaVersion: 'loop-reliability-profile-1.0'
  generatedAt: number
  graph: { id: string; version: number; hash: string; class: 'bounded' | 'continuous' }
  liveness: {
    status: ReliabilityEvidenceStatus
    waits: Array<{
      nodeId: string
      kind: 'timer' | 'event' | 'join'
      bound: 'node-timeout' | 'graph-wall-time' | 'evaluated-timer' | 'intentional-unbounded'
    }>
  }
  concurrency: {
    maxActivations: number
    stateConsistency: 'commit_latest' | 'serializable'
    status: ReliabilityEvidenceStatus
  }
  effects: { status: ReliabilityEvidenceStatus; providers: EffectConformanceEvidence[] }
  ingress: { required: boolean; status: ReliabilityEvidenceStatus; evidence?: IngressEvidence }
  workspace: {
    status: ReliabilityEvidenceStatus
    enforcement: 'path-enforced-mode-cooperative' | 'os-enforced'
    semanticModes: string[]
  }
  durability: { status: ReliabilityEvidenceStatus; level: 'process-crash-local-posix' | 'fsync-local-posix' | 'unknown' }
  audit: {
    status: ReliabilityEvidenceStatus
    retention: 'local-full-history' | 'hot-cold-local' | 'external-archive' | 'unknown'
    policy?: string
  }
  lint: GraphLintFinding[]
  evidence: Array<{ id: string; status: 'passed' | 'failed'; version?: string; verifiedAt?: number }>
}

/** Pure, read-only reliability analysis over a frozen graph and declared deployment evidence. */
export function buildLoopReliabilityProfile(
  graph: FrozenLoopGraphSpec,
  options: LoopReliabilityProfileOptions = {},
): LoopReliabilityProfile {
  const graphClass = graph.limits.maxTotalActivations !== undefined || graph.limits.maxActivations !== undefined
    ? 'bounded'
    : 'continuous'
  const waits: LoopReliabilityProfile['liveness']['waits'] = []
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (node.type === 'wait') {
      if (node.wait.kind === 'timer') waits.push({ nodeId, kind: 'timer', bound: 'evaluated-timer' })
      else waits.push({
        nodeId, kind: 'event',
        bound: node.wait.timeoutMs !== undefined
          ? 'node-timeout'
          : graph.limits.maxWallTimeMs !== undefined ? 'graph-wall-time' : 'intentional-unbounded',
      })
    } else if (node.type === 'join') {
      waits.push({
        nodeId, kind: 'join',
        bound: node.timeoutMs !== undefined
          ? 'node-timeout'
          : graph.limits.maxWallTimeMs !== undefined ? 'graph-wall-time' : 'intentional-unbounded',
      })
    }
  }
  const riskyWait = waits.some(wait => wait.bound === 'intentional-unbounded' && graphClass === 'bounded')
  const effectRefs = [...new Set(Object.values(graph.nodes).flatMap(node => node.type === 'effect' ? [node.effect] : []))].sort()
  const effectEvidence = effectRefs.map(provider => options.effects?.[provider] ?? { provider, status: 'unknown' as const })
  const effectStatus: ReliabilityEvidenceStatus = effectEvidence.some(item => item.status === 'failed')
    ? 'degraded'
    : effectEvidence.some(item => item.status === 'unknown') ? 'unknown' : 'verified'
  const eventRequired = Object.values(graph.nodes).some(node => node.type === 'wait' && node.wait.kind === 'event')
  const ingressStatus: ReliabilityEvidenceStatus = !eventRequired
    ? 'verified'
    : options.ingress?.status === 'verified' ? 'verified' : options.ingress?.status === 'declared' ? 'declared' : 'unknown'
  const semanticModes = [...new Set(Object.values(graph.lanes)
    .flatMap(lane => lane.workspace.write ?? [])
    .map(rule => rule.mode))].sort()
  const workspaceEnforcement = options.workspaceEnforcement ?? 'path-enforced-mode-cooperative'
  const lint = lintLoopGraph(graph)
  const concurrent = (graph.concurrency?.maxActivations ?? 1) > 1

  return {
    schemaVersion: 'loop-reliability-profile-1.0',
    generatedAt: options.generatedAt ?? Date.now(),
    graph: { id: graph.id, version: graph.version, hash: graph.graphHash, class: graphClass },
    liveness: { status: riskyWait ? 'degraded' : 'verified', waits },
    concurrency: {
      maxActivations: graph.concurrency?.maxActivations ?? 1,
      stateConsistency: graph.concurrency?.stateConsistency ?? 'commit_latest',
      status: concurrent && graph.concurrency?.stateConsistency === undefined ? 'degraded' : 'verified',
    },
    effects: { status: effectStatus, providers: effectEvidence },
    ingress: { required: eventRequired, status: ingressStatus, ...(options.ingress ? { evidence: options.ingress } : {}) },
    workspace: {
      status: workspaceEnforcement === 'os-enforced' || !semanticModes.some(mode => mode !== 'owned') ? 'verified' : 'declared',
      enforcement: workspaceEnforcement,
      semanticModes,
    },
    durability: {
      status: options.durability === 'fsync-local-posix' ? 'verified' : options.durability === 'unknown' ? 'unknown' : 'declared',
      level: options.durability ?? 'process-crash-local-posix',
    },
    audit: {
      status: options.audit === undefined || options.audit.retention === 'unknown' ? 'unknown' : 'declared',
      retention: options.audit?.retention ?? 'unknown',
      ...(options.audit?.policy ? { policy: options.audit.policy } : {}),
    },
    lint,
    evidence: [...(options.evidence ?? [])],
  }
}

export interface LoopOperatorSnapshot {
  instance: GraphInstanceRecord
  state: GraphStateSnapshot
  activations: ActivationRecord[]
  externalEvents: GraphExternalEventRecord[]
  wakes: WakeRecord[]
}

export interface LoopDiagnosticCard {
  code: string
  severity: 'info' | 'warning' | 'error'
  summary: string
  evidence?: Record<string, JsonValue>
  suggestedActions: string[]
}

/** Derive operator guidance without mutating the instance or consuming events. */
export function diagnoseLoop(
  graph: FrozenLoopGraphSpec,
  snapshot: LoopOperatorSnapshot,
  now = Date.now(),
): LoopDiagnosticCard[] {
  const cards: LoopDiagnosticCard[] = []
  const instanceId = snapshot.instance.instanceId
  if (snapshot.instance.status === 'paused') cards.push({
    code: 'instance-paused', severity: 'warning',
    summary: snapshot.instance.statusReason ?? 'Instance is paused.',
    suggestedActions: [`meta-agent loop inspect ${instanceId} --json`, `meta-agent loop resume ${instanceId}`],
  })
  if (snapshot.instance.status === 'failed') cards.push({
    code: 'instance-failed', severity: 'error',
    summary: snapshot.instance.statusReason ?? 'Instance failed with a deterministic or operator stop reason.',
    suggestedActions: [`meta-agent loop timeline ${instanceId} --json`, 'repair the graph/capability contract and create a new instance'],
  })
  if (snapshot.instance.status === 'exhausted') cards.push({
    code: 'instance-exhausted', severity: 'warning',
    summary: snapshot.instance.statusReason ?? 'A hard graph or Activation limit was exhausted.',
    suggestedActions: [`meta-agent loop timeline ${instanceId} --json`, 'review limits and start a governed successor instance'],
  })
  const pendingEvents = snapshot.externalEvents.filter(event => event.status === 'pending')
  if (pendingEvents.length) cards.push({
    code: 'pending-events', severity: 'info', summary: `${pendingEvents.length} external event(s) are pending a matching Wait.`,
    evidence: { eventIds: pendingEvents.slice(0, 20).map(event => event.id) },
    suggestedActions: [`meta-agent loop events ${instanceId} --status pending --json`],
  })
  const live = snapshot.activations.filter(activation => ['ready', 'running', 'waiting'].includes(activation.status))
  const activeWakes = snapshot.wakes.filter(wake => wake.status === 'pending' || wake.status === 'claimed')
  if (snapshot.instance.status === 'active' && live.length > 0 && activeWakes.length === 0) cards.push({
    code: 'active-without-wake', severity: 'warning', summary: 'Instance is active with live work but has no pending/claimed wake.',
    suggestedActions: ['run one scheduler reconciliation/tick', `meta-agent loop inspect ${instanceId} --json`],
  })
  const overdue = snapshot.activations.filter(activation => activation.status === 'waiting' && activation.wakeAt !== undefined && activation.wakeAt <= now)
  if (overdue.length) cards.push({
    code: 'overdue-waits', severity: 'warning', summary: `${overdue.length} waiting Activation(s) are past their durable deadline.`,
    evidence: { activationIds: overdue.map(item => item.id) },
    suggestedActions: ['verify the scheduler is running', `meta-agent loop inspect ${instanceId} --json`],
  })
  if (graph.limits.maxCostUsd !== undefined) {
    const ratio = snapshot.instance.totalCostUsd / graph.limits.maxCostUsd
    if (ratio >= 0.8) cards.push({
      code: 'cost-budget-warning', severity: ratio >= 1 ? 'error' : 'warning',
      summary: `Graph cost is ${(ratio * 100).toFixed(1)}% of maxCostUsd.`,
      evidence: { usedUsd: snapshot.instance.totalCostUsd, maxCostUsd: graph.limits.maxCostUsd },
      suggestedActions: ['review remaining work and budget authority before continuing'],
    })
  }
  if (!cards.length) cards.push({
    code: 'no-diagnostic-findings', severity: 'info', summary: 'No operator-level diagnostic finding was derived.', suggestedActions: [],
  })
  return cards
}
