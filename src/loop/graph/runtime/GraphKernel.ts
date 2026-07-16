import { hostname } from 'node:os'
import { WakeStore } from '../../wake/WakeStore.js'
import type { GraphAgentExecutor } from '../agent/GraphAgentExecutor.js'
import { createBuiltinContextProviderRegistry, type ContextProvider } from '../registry/ContextProvider.js'
import type {
  CapabilityRegistry,
  EffectProvider,
  FunctionProvider,
  ReducerProvider,
} from '../registry/CapabilityRegistry.js'
import type { ActivationRecord, ActivationUsage, FrozenCapabilityRef, FrozenLoopGraphSpec, GraphInstanceRecord } from '../spec/GraphTypes.js'
import { verifyFrozenGraphIntegrity } from '../spec/GraphValidate.js'
import { CommitCoordinator, ParkLimitExceededError } from './CommitCoordinator.js'
import { GraphStore } from './GraphStore.js'
import { LaneManager } from './LaneManager.js'
import { NodeExecutorRegistry, type NodeExecutionResult } from './NodeExecutors.js'
import { ContextAssembler } from './ContextAssembly.js'
import type { CapabilityPackRegistry } from '../registry/CapabilityPack.js'
import { WorkspacePlaneMaterializer } from './WorkspacePlane.js'
import {
  graphProgressIdentity,
  oneLine,
  type GraphProgressEvent,
  type GraphProgressListener,
} from './GraphProgress.js'

export interface GraphKernelOptions {
  store: GraphStore
  graph: FrozenLoopGraphSpec
  functions: CapabilityRegistry<FunctionProvider>
  reducers: CapabilityRegistry<ReducerProvider>
  effects?: CapabilityRegistry<EffectProvider>
  packs?: CapabilityPackRegistry
  contextProviders?: CapabilityRegistry<ContextProvider>
  graphAgent?: GraphAgentExecutor
  wakeStore?: WakeStore
  owner?: string
  now?: () => number
  executor?: Pick<NodeExecutorRegistry, 'execute'>
  hostCoordinatorRoot?: string
  maxConcurrentModelCalls?: number
  activationLeaseTtlMs?: number
  activationHeartbeatMs?: number
  /** Low-frequency phase lifecycle observer. Listener failures never affect execution. */
  onProgress?: GraphProgressListener
  signal?: AbortSignal
}

export interface GraphTickResult {
  instance: GraphInstanceRecord
  claimed: number
  committed: number
  parked: number
  retried: number
  recovered: number
  failed: number
  nextWakeAt?: number
}

export class GraphKernel {
  private readonly coordinator: CommitCoordinator
  private readonly lanes: LaneManager
  private readonly executor: Pick<NodeExecutorRegistry, 'execute'>
  private readonly workspacePlanes: WorkspacePlaneMaterializer
  private readonly wakeStore: WakeStore
  private readonly owner: string

  private constructor(private readonly options: GraphKernelOptions, instance: GraphInstanceRecord) {
    verifyFrozenGraphIntegrity(options.graph)
    verifyCapabilityLock(options.graph.capabilityLock.functions, options.functions, 'function')
    verifyCapabilityLock(options.graph.capabilityLock.reducers, options.reducers, 'reducer')
    if (options.graph.capabilityLock.effects.length) {
      if (!options.effects) throw new Error('graph requires Effect capabilities but no registry was supplied')
      verifyCapabilityLock(options.graph.capabilityLock.effects, options.effects, 'effect')
    }
    const contextProviders = options.contextProviders ?? createBuiltinContextProviderRegistry()
    verifyCapabilityLock(options.graph.capabilityLock.contextProviders ?? [], contextProviders, 'context provider')
    for (const pack of options.graph.capabilityLock.packs) {
      if (!options.packs?.has(pack)) throw new Error(`Capability Pack integrity mismatch or missing for '${pack.id}@${pack.version}'`)
    }
    this.coordinator = new CommitCoordinator(options.store, options.graph, options.functions, options.reducers)
    this.lanes = new LaneManager(options.store, options.graph, instance)
    this.workspacePlanes = new WorkspacePlaneMaterializer({ store: options.store, graph: options.graph, lanes: this.lanes })
    this.wakeStore = options.wakeStore ?? new WakeStore(options.store.projectDir)
    this.owner = options.owner ?? `${hostname()}#${process.pid}`
    this.executor = options.executor ?? new NodeExecutorRegistry({
      store: options.store,
      graph: options.graph,
      instance,
      functions: options.functions,
      effects: options.effects,
      graphAgent: options.graphAgent,
      contextAssembler: new ContextAssembler({
        store: options.store,
        graph: options.graph,
        instance,
        providers: contextProviders,
        now: options.now,
      }),
      lanes: this.lanes,
      now: options.now,
      hostCoordinatorRoot: options.hostCoordinatorRoot,
      maxConcurrentModelCalls: options.maxConcurrentModelCalls,
      signal: options.signal,
    })
  }

  static async open(options: GraphKernelOptions): Promise<GraphKernel> {
    const snapshot = await options.store.snapshot()
    if (snapshot.instance.graphHash !== options.graph.graphHash) throw new Error('loaded GraphSpec does not match instance graphHash')
    const kernel = new GraphKernel(options, snapshot.instance)
    await kernel.lanes.reconcile()
    if (!isTerminal(snapshot.instance)) await kernel.workspacePlanes.reconcile()
    return kernel
  }

  async tick(): Promise<GraphTickResult> {
    const now = this.now()
    let snapshot = await this.options.store.snapshot()
    if (isTerminal(snapshot.instance)) return emptyResult(snapshot.instance)
    if (this.options.graph.limits.maxWallTimeMs !== undefined && now - snapshot.instance.createdAt > this.options.graph.limits.maxWallTimeMs) {
      const instance = await this.options.store.setStatus('failed', 'maxWallTimeMs exceeded', now)
      return { ...emptyResult(instance), failed: 1 }
    }

    const recoveredResults = await this.coordinator.recoverPrepared(now)
    for (const recovered of recoveredResults) {
      if (recovered.duplicate) continue
      this.emitProgress({
        type: 'phase_completed',
        ...graphProgressIdentity(this.options.graph, this.options.store.instanceId, recovered.activation, now),
        outcome: recovered.activation.status === 'failed'
          ? 'failure'
          : (recovered.activation.outcome ?? recovered.activation.status),
        summary: this.activationSummary(recovered.activation),
        usage: recovered.activation.usage,
      })
    }
    snapshot = await this.options.store.snapshot()
    if (isTerminal(snapshot.instance)) return { ...emptyResult(snapshot.instance), recovered: recoveredResults.length }
    await this.workspacePlanes.reconcile()

    await this.options.store.releaseExpiredClaims(now)
    // An event created before a wait deadline wins even when this tick runs
    // after both timestamps. Event matching enforces createdAt < wakeAt.
    await this.coordinator.resumePendingExternalEvents(now)
    await this.coordinator.resumeDue(now)
    await this.syncDerivedStatus(now)
    snapshot = await this.options.store.snapshot()
    if (isTerminal(snapshot.instance)) return { ...emptyResult(snapshot.instance), recovered: recoveredResults.length }

    const capacity = this.options.graph.concurrency?.maxActivations ?? 1
    const claims = await this.options.store.claimReady({
      owner: this.owner,
      now,
      limit: capacity,
      ttlMs: this.options.activationLeaseTtlMs ?? 10 * 60_000,
    })
    for (const activation of claims) {
      const resumed = activation.continuationVersion > 0
      this.emitProgress({
        type: 'phase_started',
        ...graphProgressIdentity(this.options.graph, this.options.store.instanceId, activation, now),
        resumed,
        ...(resumed && activation.summary ? { resumeReason: activation.summary } : {}),
      })
    }
    let committed = 0
    let parked = 0
    let retried = 0
    let failed = 0
    const results = await Promise.allSettled(claims.map(async activation => {
      const live = await this.options.store.snapshot()
      let result: NodeExecutionResult
      try {
        result = await this.executeWithHeartbeat(activation, () => this.executor.execute(activation, live))
      } catch (error) {
        const node = this.options.graph.nodes[activation.nodeId]
        if (this.options.signal?.aborted) {
          result = { kind: 'retry', reason: `Graph execution interrupted: ${message(error)}`, consumeAttempt: false }
        } else if (node?.type === 'agent' && activation.attempt < (node.maxAttempts ?? 3)) {
          result = {
            kind: 'retry',
            reason: `Agent executor error: ${message(error)}`,
            consumeAttempt: true,
            delayMs: retryDelayMs(activation.attempt),
          }
        } else {
          result = { kind: 'completed', outcome: 'failure', output: { error: message(error) }, summary: message(error) }
        }
      }
      return this.finishActivation(activation, await this.enforceExecutionLimits(activation, result))
    }))
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!
      if (result.status === 'fulfilled') {
        if (result.value === 'committed') committed++
        else if (result.value === 'parked') parked++
        else if (result.value === 'retried') retried++
        else failed++
      } else {
        const live = await this.options.store.snapshot()
        const activation = live.activations.get(claims[i]!.id)
        if (activation?.status === 'cancelled' || activation?.status === 'succeeded') continue
        throw result.reason
      }
    }
    await this.workspacePlanes.reconcile()
    // A Wait Activation can park in this wave after its matching event was
    // already persisted. Consume that inbox entry now instead of sleeping
    // until the timeout wake.
    await this.coordinator.resumePendingExternalEvents(this.now())
    const instance = await this.syncDerivedStatus(this.now())
    const finalSnapshot = await this.options.store.snapshot()
    const waiting = [...finalSnapshot.activations.values()].filter(a => a.status === 'waiting' && a.wakeAt !== undefined)
    const nextWakeAt = waiting.length ? Math.min(...waiting.map(a => a.wakeAt!)) : undefined
    if (instance.status === 'active') {
      const ready = [...finalSnapshot.activations.values()].some(a => a.status === 'ready')
      const runningExpiry = [...finalSnapshot.activations.values()]
        .filter(a => a.status === 'running' && a.lease)
        .map(a => a.lease!.expiresAt)
      const fireAt = ready ? this.now() : runningExpiry.length ? Math.min(...runningExpiry) : this.now()
      await this.wakeStore.schedule({
        loopId: this.options.store.instanceId,
        activationId: '__graph__',
        kind: 'timer',
        fireAt,
      })
    }
    return {
      instance,
      claimed: claims.length,
      committed,
      parked,
      retried,
      recovered: recoveredResults.length,
      failed,
      nextWakeAt,
    }
  }

  async signalEvent(event: { name: string; correlation?: import('../spec/GraphTypes.js').JsonValue; payload?: import('../spec/GraphTypes.js').JsonValue }): Promise<number> {
    const result = await this.coordinator.recordExternalEvent({ ...event, now: this.now() })
    if (result.resumed.length) await this.options.store.setStatus('active', `event ${event.name}`, this.now())
    return result.resumed.length
  }

  async resumePausedTerminal(): Promise<{ spawned: ActivationRecord[]; instance: GraphInstanceRecord }> {
    return this.coordinator.resumePausedTerminal(this.now())
  }

  private async finishActivation(activation: ActivationRecord, result: NodeExecutionResult): Promise<'committed' | 'parked' | 'retried' | 'fatal'> {
    if (!activation.lease) throw new Error(`activation '${activation.id}' has no lease`)
    if (result.kind === 'completed' && this.options.graph.concurrency?.stateConsistency === 'serializable') {
      const latest = await this.options.store.snapshot()
      if ((activation.executionStateVersion ?? activation.inputStateVersion) !== latest.state.version) {
        const replay = await this.coordinator.retry({
          activationId: activation.id,
          leaseToken: activation.lease.token,
          reason: `State advanced from v${activation.executionStateVersion ?? activation.inputStateVersion} to v${latest.state.version}; replaying under serializable policy`,
          usage: result.usage,
          consumeAttempt: false,
          now: this.now(),
        })
        if (replay.wakeAt !== undefined) await this.wakeStore.schedule({
          loopId: this.options.store.instanceId,
          activationId: replay.id,
          kind: 'timer',
          fireAt: replay.wakeAt,
        })
        this.emitProgress({
          type: 'phase_retrying',
          ...graphProgressIdentity(this.options.graph, this.options.store.instanceId, replay, this.now()),
          reason: replay.error ?? 'State changed; replaying under serializable policy',
          replay: true,
          ...(replay.wakeAt !== undefined ? { wakeAt: replay.wakeAt } : {}),
        })
        return 'retried'
      }
    }
    if (result.kind === 'retry') {
      const retry = await this.coordinator.retry({
        activationId: activation.id,
        leaseToken: activation.lease.token,
        reason: result.reason,
        usage: result.usage,
        consumeAttempt: result.consumeAttempt,
        delayMs: result.delayMs,
        now: this.now(),
      })
      if (retry.wakeAt !== undefined) await this.wakeStore.schedule({
        loopId: this.options.store.instanceId,
        activationId: retry.id,
        kind: 'timer',
        fireAt: retry.wakeAt,
      })
      this.emitProgress({
        type: 'phase_retrying',
        ...graphProgressIdentity(this.options.graph, this.options.store.instanceId, retry, this.now()),
        reason: result.reason,
        replay: !result.consumeAttempt,
        ...(retry.wakeAt !== undefined ? { wakeAt: retry.wakeAt } : {}),
      })
      return 'retried'
    }
    if (result.kind === 'fatal') {
      await this.coordinator.failStop({
        activationId: activation.id,
        leaseToken: activation.lease.token,
        reason: result.reason,
        usage: result.usage,
        now: this.now(),
      })
      this.emitProgress({
        type: 'phase_failed',
        ...graphProgressIdentity(this.options.graph, this.options.store.instanceId, activation, this.now()),
        reason: result.reason,
        usage: result.usage,
      })
      return 'fatal'
    }
    if (result.kind === 'parked') {
      let parked: ActivationRecord
      try {
        parked = await this.coordinator.park({
          activationId: activation.id,
          leaseToken: activation.lease.token,
          wakeAt: result.wakeAt,
          event: result.event,
          inputPatch: result.inputPatch,
          reason: result.reason,
          usage: result.usage,
          now: this.now(),
        })
      } catch (error) {
        if (!(error instanceof ParkLimitExceededError)) throw error
        return this.finishActivation(activation, {
          kind: 'completed',
          outcome: 'failure',
          output: { error: error.message },
          summary: error.message,
          usage: result.usage,
        })
      }
      if (parked.wakeAt !== undefined) {
        await this.wakeStore.schedule({
          loopId: this.options.store.instanceId,
          activationId: parked.id,
          kind: 'timer',
          fireAt: parked.wakeAt,
        })
      }
      this.emitProgress({
        type: 'phase_parked',
        ...graphProgressIdentity(this.options.graph, this.options.store.instanceId, parked, this.now()),
        reason: result.reason,
        ...(parked.wakeAt !== undefined ? { wakeAt: parked.wakeAt } : {}),
        ...(result.event ? { eventName: result.event.name } : {}),
      })
      return 'parked'
    }

    const node = this.options.graph.nodes[activation.nodeId]
    if (node?.type === 'terminal' && node.status !== 'paused') {
      await this.workspacePlanes.reconcile()
      const lanes = await this.lanes.mergeAll()
      const conflict = lanes.find(lane => lane.status === 'conflicted')
      if (conflict) {
        const retry = await this.coordinator.retry({
          activationId: activation.id,
          leaseToken: activation.lease.token,
          reason: `Lane '${conflict.laneId}' merge conflict: ${conflict.error ?? 'unknown'}`,
          consumeAttempt: false,
          now: this.now(),
        })
        await this.options.store.setStatus('paused', `Lane '${conflict.laneId}' requires repair`, this.now())
        this.emitProgress({
          type: 'phase_retrying',
          ...graphProgressIdentity(this.options.graph, this.options.store.instanceId, retry, this.now()),
          reason: retry.error ?? `Lane '${conflict.laneId}' requires repair`,
          replay: true,
        })
        return 'retried'
      }
    }
    const intent = await this.options.store.prepareCommit({
      activationId: activation.id,
      leaseToken: activation.lease.token,
      outcome: result.outcome,
      output: result.output,
      usage: result.usage,
      summary: this.completionSummary(activation, result),
      now: this.now(),
    })
    const committed = await this.coordinator.commit(intent, this.now())
    for (const child of committed.spawned) {
      if (this.options.graph.nodes[child.nodeId]?.type === 'join') {
        await this.coordinator.resumeDue(this.now(), { name: `join:${child.nodeId}` })
      }
    }
    this.emitProgress({
      type: 'phase_completed',
      ...graphProgressIdentity(this.options.graph, this.options.store.instanceId, committed.activation, this.now()),
      outcome: committed.activation.status === 'failed' ? 'failure' : (committed.activation.outcome ?? result.outcome),
      summary: this.activationSummary(committed.activation),
      usage: result.usage,
    })
    return 'committed'
  }

  private async enforceExecutionLimits(
    activation: ActivationRecord,
    result: NodeExecutionResult,
  ): Promise<NodeExecutionResult> {
    const node = this.options.graph.nodes[activation.nodeId]
    if (node?.type !== 'agent') return result
    const usage = addUsage(activation.usage, result.usage)
    const errors: string[] = []
    if (result.kind === 'parked') {
      if (!node.timerPolicy?.allowHardPark) errors.push('Agent node is not allowed to hard-park')
      if (node.timerPolicy?.maxParks !== undefined && (activation.parkCount ?? 0) + 1 > node.timerPolicy.maxParks) {
        errors.push(`Agent Activation maxParks ${node.timerPolicy.maxParks} exceeded`)
      }
    }
    if (node.lifetimeBudget?.turns !== undefined && usage.turns > node.lifetimeBudget.turns) {
      errors.push(`Agent Activation lifetime turns ${node.lifetimeBudget.turns} exceeded`)
    }
    if (node.lifetimeBudget?.usd !== undefined && usage.costUsd > node.lifetimeBudget.usd) {
      errors.push(`Agent Activation lifetime USD ${node.lifetimeBudget.usd} exceeded`)
    }
    if (node.lifetimeBudget?.elapsedMs !== undefined && activation.firstStartedAt !== undefined &&
        this.now() - activation.firstStartedAt > node.lifetimeBudget.elapsedMs) {
      errors.push(`Agent Activation lifetime elapsedMs ${node.lifetimeBudget.elapsedMs} exceeded`)
    }
    const snapshot = await this.options.store.snapshot()
    if (this.options.graph.limits.maxCostUsd !== undefined &&
        snapshot.instance.totalCostUsd + (result.usage?.costUsd ?? 0) > this.options.graph.limits.maxCostUsd) {
      errors.push(`Graph maxCostUsd ${this.options.graph.limits.maxCostUsd} exceeded`)
    }
    if (!errors.length) return result
    return {
      kind: 'completed',
      outcome: 'failure',
      output: { error: errors.join('; ') },
      summary: errors.join('; '),
      usage: result.usage,
    }
  }

  private async executeWithHeartbeat<T>(activation: ActivationRecord, execute: () => Promise<T>): Promise<T> {
    if (!activation.lease) throw new Error(`activation '${activation.id}' has no lease`)
    let lost = false
    let refreshing = false
    const timer = setInterval(() => {
      if (refreshing || lost) return
      refreshing = true
      void this.options.store.heartbeat(
        activation.id,
        activation.lease!.token,
        this.now(),
        this.options.activationLeaseTtlMs ?? 10 * 60_000,
      )
        .then(owned => { if (!owned) lost = true })
        .catch(() => { lost = true })
        .finally(() => { refreshing = false })
    }, this.options.activationHeartbeatMs ?? 60_000)
    timer.unref?.()
    try {
      const result = await execute()
      if (lost) throw new Error(`activation lease lost for '${activation.id}' during execution`)
      return result
    } finally {
      clearInterval(timer)
    }
  }

  private async syncDerivedStatus(now: number): Promise<GraphInstanceRecord> {
    const snapshot = await this.options.store.snapshot()
    if (isTerminal(snapshot.instance) || snapshot.instance.status === 'paused') return snapshot.instance
    const active = [...snapshot.activations.values()].some(a => a.status === 'ready' || a.status === 'running')
    const waiting = [...snapshot.activations.values()].some(a => a.status === 'waiting')
    if (active) return this.options.store.setStatus('active', undefined, now)
    if (waiting) return this.options.store.setStatus('waiting', 'awaiting timer or event', now)
    return this.options.store.setStatus('failed', 'graph quiesced without reaching a terminal node', now)
  }

  private completionSummary(
    activation: ActivationRecord,
    result: Extract<NodeExecutionResult, { kind: 'completed' }>,
  ): string {
    const authored = oneLine(result.summary)
    if (authored) return authored
    if (result.output && typeof result.output === 'object' && !Array.isArray(result.output)) {
      const error = result.output.error
      if (typeof error === 'string' && oneLine(error)) return oneLine(error)
    }
    const node = this.options.graph.nodes[activation.nodeId]
    if (!node) return `Phase ended with outcome ${result.outcome}`
    switch (node.type) {
      case 'agent': return `Agent phase ended with outcome ${result.outcome}`
      case 'function': return `Function ${node.function} ended with outcome ${result.outcome}`
      case 'effect': return `Effect ${node.effect} ended with outcome ${result.outcome}`
      case 'wait': return `Wait ended with outcome ${result.outcome}`
      case 'join': return `Join barrier ended with outcome ${result.outcome}`
      case 'terminal': return `${node.status} terminal reached`
    }
  }

  private activationSummary(activation: ActivationRecord): string {
    return oneLine(activation.summary) || oneLine(activation.error) || `Phase ended with outcome ${activation.outcome ?? activation.status}`
  }

  private emitProgress(event: GraphProgressEvent): void {
    try {
      this.options.onProgress?.(event)
    } catch {
      // Observability is fail-open and must never perturb durable execution.
    }
  }

  private now(): number { return this.options.now?.() ?? Date.now() }
}

function addUsage(current: ActivationUsage | undefined, increment: ActivationUsage | undefined): ActivationUsage {
  return {
    turns: (current?.turns ?? 0) + (increment?.turns ?? 0),
    costUsd: (current?.costUsd ?? 0) + (increment?.costUsd ?? 0),
    durationMs: (current?.durationMs ?? 0) + (increment?.durationMs ?? 0),
  }
}

function verifyCapabilityLock<T extends { manifest: { id: string; version: string; integrity: string } }>(
  refs: FrozenCapabilityRef[],
  registry: { get(reference: string): T },
  kind: string,
): void {
  for (const ref of refs) {
    const provider = registry.get(`${ref.id}@${ref.version}`)
    if (provider.manifest.integrity !== ref.integrity) throw new Error(`${kind} capability integrity mismatch for '${ref.id}@${ref.version}'`)
  }
}

function isTerminal(instance: GraphInstanceRecord): boolean {
  return instance.status === 'done' || instance.status === 'failed'
}

function emptyResult(instance: GraphInstanceRecord): GraphTickResult {
  return { instance, claimed: 0, committed: 0, parked: 0, retried: 0, recovered: 0, failed: 0 }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1))
}
