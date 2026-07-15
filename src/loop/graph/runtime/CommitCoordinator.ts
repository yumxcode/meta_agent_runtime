import type { CapabilityRegistry, FunctionProvider, ReducerProvider } from '../registry/CapabilityRegistry.js'
import { randomUUID } from 'node:crypto'
import type {
  ActivationCommitIntent,
  ActivationRecord,
  FrozenLoopGraphSpec,
  GraphInstanceRecord,
  GraphJournalEvent,
  JsonValue,
  GraphArtifactRecord,
  ActivationUsage,
  GraphExternalEventRecord,
} from '../spec/GraphTypes.js'
import { GraphStore } from './GraphStore.js'
import { decideTransition } from './TransitionEngine.js'
import { evaluateValueExpression } from './GraphExpression.js'
import { validateShape } from './GraphJson.js'

export interface CommitResult {
  activation: ActivationRecord
  spawned: ActivationRecord[]
  instance: GraphInstanceRecord
  transitionId?: string
  duplicate: boolean
}

export class ParkLimitExceededError extends Error {
  constructor(readonly limit: number) {
    super(`maxPendingTimers ${limit} exceeded`)
    this.name = 'ParkLimitExceededError'
  }
}

export class CommitCoordinator {
  constructor(
    private readonly store: GraphStore,
    private readonly graph: FrozenLoopGraphSpec,
    private readonly functions: CapabilityRegistry<FunctionProvider>,
    private readonly reducers: CapabilityRegistry<ReducerProvider>,
  ) {}

  async commit(intent: ActivationCommitIntent, now = Date.now()): Promise<CommitResult> {
    return this.store.withTransaction(async () => {
      const snapshot = await this.store.authoritativeSnapshotLocked()
      const committedSequence = snapshot.commitKeys.get(intent.commitKey)
      if (committedSequence !== undefined) {
        const event = (await this.store.readJournalLockedView()).find(item => item.sequence === committedSequence)?.event
        if (event?.type !== 'activation_committed') throw new Error(`commit index '${intent.commitKey}' is corrupt`)
        return resultFromEvent(event, true)
      }
      const activation = snapshot.activations.get(intent.activationId)
      if (!activation) throw new Error(`commit references missing activation '${intent.activationId}'`)
      if (activation.continuationVersion !== intent.continuationVersion) throw new Error(`stale continuation for activation '${intent.activationId}'`)
      if (!['running', 'ready'].includes(activation.status)) throw new Error(`activation '${intent.activationId}' cannot commit from ${activation.status}`)
      const node = this.graph.nodes[activation.nodeId]
      if (!node) throw new Error(`activation '${activation.id}' references missing node '${activation.nodeId}'`)

      let state = snapshot.state
      let spawned: ActivationRecord[] = []
      let transitionId: string | undefined
      let cancelled: ActivationRecord[] = []
      let artifacts: GraphArtifactRecord[] = []
      const publicationRejections: Array<{ channel: string; reason: string }> = []
      let instance: GraphInstanceRecord = { ...snapshot.instance, updatedAt: now }
      const segmentUsage = intent.usage ?? emptyUsage()
      instance.totalCostUsd = (instance.totalCostUsd ?? 0) + segmentUsage.costUsd
      let committedActivation: ActivationRecord
      if (node.type === 'terminal') {
        committedActivation = {
          ...activation,
          usage: addUsage(activation.usage, segmentUsage),
          status: node.status === 'failed' ? 'failed' : 'succeeded',
          lease: undefined,
          output: intent.output,
          outcome: intent.outcome,
          terminalResult: intent.output,
          updatedAt: now,
        }
        instance = {
          ...instance,
          status: node.status,
          terminalResult: intent.output,
          statusReason: node.description,
        }
        cancelled = [...snapshot.activations.values()]
          .filter(peer => peer.id !== activation.id && ['ready', 'running', 'waiting'].includes(peer.status))
          .map(peer => ({ ...peer, status: 'cancelled' as const, lease: undefined, updatedAt: now, error: `cancelled by terminal activation ${activation.id}` }))
      } else {
        const decision = await decideTransition({
          graph: this.graph,
          activation,
          outcome: intent.outcome,
          output: intent.output,
          state,
          functions: this.functions,
          reducers: this.reducers,
          now,
        })
        state = decision.state
        spawned = decision.spawned.filter(child => {
          if (this.graph.nodes[child.nodeId]?.type !== 'join') return true
          return ![...snapshot.activations.values()].some(existing =>
            existing.nodeId === child.nodeId && existing.forkGroupId === child.forkGroupId && existing.status === 'succeeded')
        })
        transitionId = decision.transition.id
        committedActivation = {
          ...activation,
          usage: addUsage(activation.usage, segmentUsage),
          status: intent.outcome === 'failure' ? 'failed' : 'succeeded',
          lease: undefined,
          output: intent.output,
          outcome: intent.outcome,
          updatedAt: now,
        }
        if (instance.activationCount + spawned.length > this.graph.limits.maxActivations) {
          spawned = []
          committedActivation = { ...committedActivation, status: 'failed', error: 'maxActivations exceeded' }
          instance = { ...instance, status: 'failed', statusReason: 'maxActivations exceeded' }
        } else {
          instance = { ...instance, activationCount: instance.activationCount + spawned.length }
        }
        if (this.graph.limits.maxCostUsd !== undefined && instance.totalCostUsd > this.graph.limits.maxCostUsd) {
          spawned = []
          committedActivation = { ...committedActivation, status: 'failed', error: 'maxCostUsd exceeded' }
          instance = { ...instance, status: 'failed', statusReason: 'maxCostUsd exceeded' }
        }
        if (node.type === 'join') {
          cancelled = [...snapshot.activations.values()]
            .filter(peer => peer.id !== activation.id && peer.nodeId === activation.nodeId &&
              peer.forkGroupId === activation.forkGroupId && ['ready', 'running', 'waiting'].includes(peer.status))
            .map(peer => ({ ...peer, status: 'cancelled' as const, lease: undefined, updatedAt: now, error: `coalesced by join activation ${activation.id}` }))
        }
      }
      const activeArtifactIds = new Map<string, Set<string>>()
      for (const [id, artifact] of snapshot.artifacts) {
        if (artifact.status === 'superseded') continue
        const ids = activeArtifactIds.get(artifact.channel) ?? new Set<string>()
        ids.add(id)
        activeArtifactIds.set(artifact.channel, ids)
      }
      for (const publication of node.publishes ?? []) {
        if ((publication.on ?? 'success') !== intent.outcome && publication.on !== 'always') continue
        const channelId = publication.channel
        if (!channelId) throw new Error('logical publication reached Kernel without Freeze compilation')
        const channel = this.graph.artifacts?.[channelId]
        if (!channel) throw new Error(`publication references unknown channel '${channelId}'`)
        const context = { state: state.values, input: activation.input, output: intent.output, clock: { now } }
        const content = await evaluateValueExpression(publication.value, context, this.functions)
        const shapeErrors = channel.schema ? validateShape(content, channel.schema, `$artifact.${channelId}`) : []
        if (shapeErrors.length) throw new Error(`artifact schema mismatch: ${shapeErrors.join('; ')}`)
        const supersedesValue = publication.supersedes
          ? await evaluateValueExpression(publication.supersedes, context, this.functions)
          : undefined
        if (supersedesValue !== undefined && typeof supersedesValue !== 'string') throw new Error('artifact supersedes must resolve to an artifact id string')
        const status = publication.status ?? (channel.admission === 'judge' ? 'proposed' : 'admitted')
        if (channel.admission === 'judge' && status === 'admitted' && node.type !== 'agent') {
          throw new Error(`channel '${channelId}' requires Agent judgment for admission`)
        }
        const artifact: GraphArtifactRecord = {
          schemaVersion: 'graph-artifact-1.0',
          id: `artifact-${randomUUID()}`,
          channel: channelId,
          kind: channel.kind ?? 'artifact',
          status,
          content,
          tags: [...(publication.tags ?? [])],
          provenance: {
            activationId: activation.id,
            nodeId: activation.nodeId,
            laneId: activation.laneId,
            stateVersion: state.version,
            createdAt: now,
          },
          ...(supersedesValue ? { supersedes: supersedesValue } : {}),
        }
        const active = activeArtifactIds.get(channelId) ?? new Set<string>()
        const superseded = supersedesValue && active.has(supersedesValue) ? supersedesValue : undefined
        if (superseded) active.delete(superseded)
        if (channel.maxItems !== undefined && active.size + 1 > channel.maxItems) {
          if (superseded) active.add(superseded)
          publicationRejections.push({
            channel: channelId,
            reason: `maxItems ${channel.maxItems} reached`,
          })
          continue
        }
        active.add(artifact.id)
        activeArtifactIds.set(channelId, active)
        artifacts.push(artifact)
      }
      const event: Extract<GraphJournalEvent, { type: 'activation_committed' }> = {
        type: 'activation_committed',
        at: now,
        commitKey: intent.commitKey,
        activation: committedActivation,
        spawned,
        ...(cancelled.length ? { cancelled } : {}),
        ...(artifacts.length ? { artifacts } : {}),
        ...(publicationRejections.length ? { publicationRejections } : {}),
        state,
        instance,
        transitionId,
      }
      const journal = await this.store.appendEventLocked(event)
      await this.store.writeCommitProjectionLocked(event, journal.sequence)
      return resultFromEvent(event, false)
    })
  }

  async recoverPrepared(now = Date.now()): Promise<CommitResult[]> {
    const results: CommitResult[] = []
    for (const intent of await this.store.listPreparedIntents()) results.push(await this.commit(intent, now))
    return results
  }

  /** Resume a graph-authored paused Terminal exactly once through its resume edge. */
  async resumePausedTerminal(now = Date.now()): Promise<{ spawned: ActivationRecord[]; instance: GraphInstanceRecord }> {
    return this.store.withTransaction(async () => {
      const snapshot = await this.store.authoritativeSnapshotLocked()
      if (snapshot.instance.status !== 'paused') throw new Error('graph is not paused')
      const activation = [...snapshot.activations.values()]
        .filter(item => {
          const node = this.graph.nodes[item.nodeId]
          return item.status === 'succeeded' && !item.resumedAt && node?.type === 'terminal' && node.status === 'paused'
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))[0]
      if (!activation) throw new Error('paused graph has no resumable paused Terminal')
      const decision = await decideTransition({
        graph: this.graph,
        activation,
        outcome: 'resume',
        output: activation.output ?? activation.terminalResult ?? activation.input,
        state: snapshot.state,
        functions: this.functions,
        reducers: this.reducers,
        now,
      })
      if (snapshot.instance.activationCount + decision.spawned.length > this.graph.limits.maxActivations) {
        throw new Error('maxActivations exceeded while resuming paused Terminal')
      }
      const resumedActivation: ActivationRecord = { ...activation, resumedAt: now, updatedAt: now }
      const instance: GraphInstanceRecord = {
        ...snapshot.instance,
        status: 'active',
        statusReason: `resumed from paused Terminal '${activation.nodeId}'`,
        terminalResult: undefined,
        activationCount: snapshot.instance.activationCount + decision.spawned.length,
        updatedAt: now,
      }
      const event: Extract<GraphJournalEvent, { type: 'paused_terminal_resumed' }> = {
        type: 'paused_terminal_resumed',
        at: now,
        activation: resumedActivation,
        spawned: decision.spawned,
        state: decision.state,
        instance,
        transitionId: decision.transition.id,
      }
      await this.store.appendEventLocked(event)
      await this.store.writePausedResumeProjectionLocked(event)
      return { spawned: decision.spawned, instance }
    })
  }

  async recordExternalEvent(input: {
    name: string
    correlation?: JsonValue
    payload?: JsonValue
    now?: number
  }): Promise<{ event: GraphExternalEventRecord; resumed: ActivationRecord[] }> {
    const now = input.now ?? Date.now()
    return this.store.withTransaction(async () => {
      const snapshot = await this.store.authoritativeSnapshotLocked()
      const event: GraphExternalEventRecord = {
        schemaVersion: 'graph-external-event-1.0',
        id: `event-${randomUUID()}`,
        name: input.name,
        correlation: input.correlation,
        payload: input.payload,
        status: 'pending',
        createdAt: now,
      }
      await this.store.appendEventLocked({ type: 'external_event_recorded', at: now, externalEvent: event })
      await this.store.writeExternalEventProjectionLocked(event)
      const resumed = matchingEventActivations(snapshot.activations.values(), event).map(activation =>
        resumeForExternalEvent(activation, event, now))
      if (!resumed.length) return { event, resumed }
      const consumed: GraphExternalEventRecord = {
        ...event,
        status: 'consumed',
        consumedAt: now,
        consumedBy: resumed.map(activation => activation.id),
      }
      await this.store.appendEventLocked({ type: 'external_event_consumed', at: now, externalEvent: consumed, activations: resumed })
      for (const activation of resumed) await this.store.writeActivationProjectionLocked(activation)
      await this.store.writeExternalEventProjectionLocked(consumed)
      return { event: consumed, resumed }
    })
  }

  async resumePendingExternalEvents(now = Date.now()): Promise<ActivationRecord[]> {
    return this.store.withTransaction(async () => {
      const snapshot = await this.store.authoritativeSnapshotLocked()
      const resumed: ActivationRecord[] = []
      const reserved = new Set<string>()
      const pending = [...snapshot.externalEvents.values()]
        .filter(event => event.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      for (const event of pending) {
        const matches = matchingEventActivations(snapshot.activations.values(), event)
          .filter(activation => !reserved.has(activation.id))
        if (!matches.length) continue
        const activations = matches.map(activation => resumeForExternalEvent(activation, event, now))
        for (const activation of activations) reserved.add(activation.id)
        const consumed: GraphExternalEventRecord = {
          ...event,
          status: 'consumed',
          consumedAt: now,
          consumedBy: activations.map(activation => activation.id),
        }
        await this.store.appendEventLocked({ type: 'external_event_consumed', at: now, externalEvent: consumed, activations })
        for (const activation of activations) await this.store.writeActivationProjectionLocked(activation)
        await this.store.writeExternalEventProjectionLocked(consumed)
        resumed.push(...activations)
      }
      return resumed
    })
  }

  async park(input: {
    activationId: string
    leaseToken: string
    wakeAt?: number
    event?: { name: string; correlation?: JsonValue }
    inputPatch?: Record<string, JsonValue>
    usage?: ActivationUsage
    now?: number
  }): Promise<ActivationRecord> {
    const now = input.now ?? Date.now()
    return this.store.withTransaction(async () => {
      const snapshot = await this.store.authoritativeSnapshotLocked()
      const activation = snapshot.activations.get(input.activationId)
      if (activation?.status !== 'running' || activation.lease?.token !== input.leaseToken) throw new Error(`activation lease lost for '${input.activationId}'`)
      if (input.wakeAt !== undefined && this.graph.limits.maxPendingTimers !== undefined) {
        const pendingTimers = [...snapshot.activations.values()].filter(item =>
          item.status === 'waiting' && item.wakeAt !== undefined,
        ).length
        if (pendingTimers >= this.graph.limits.maxPendingTimers) {
          throw new ParkLimitExceededError(this.graph.limits.maxPendingTimers)
        }
      }
      const next: ActivationRecord = {
        ...activation,
        status: 'waiting',
        lease: undefined,
        parkCount: (activation.parkCount ?? 0) + 1,
        usage: addUsage(activation.usage, input.usage),
        wakeAt: input.wakeAt,
        waitingReason: 'continuation',
        event: input.event,
        input: { ...activation.input, ...(input.inputPatch ?? {}) },
        updatedAt: now,
      }
      const instance: GraphInstanceRecord = {
        ...snapshot.instance,
        totalCostUsd: snapshot.instance.totalCostUsd + (input.usage?.costUsd ?? 0),
        updatedAt: now,
      }
      await this.store.appendEventLocked({ type: 'activation_released', at: now, activation: next, instance, reason: 'parked' })
      await this.store.writeActivationProjectionLocked(next)
      await this.store.writeInstanceProjectionLocked(instance)
      return next
    })
  }

  async retry(input: {
    activationId: string
    leaseToken: string
    reason: string
    usage?: ActivationUsage
    consumeAttempt: boolean
    delayMs?: number
    now?: number
  }): Promise<ActivationRecord> {
    const now = input.now ?? Date.now()
    return this.store.withTransaction(async () => {
      const snapshot = await this.store.authoritativeSnapshotLocked()
      const activation = snapshot.activations.get(input.activationId)
      if (activation?.status !== 'running' || activation.lease?.token !== input.leaseToken) {
        throw new Error(`activation lease lost for '${input.activationId}'`)
      }
      let delayed = (input.delayMs ?? 0) > 0
      if (delayed && this.graph.limits.maxPendingTimers !== undefined) {
        const pendingTimers = [...snapshot.activations.values()].filter(item =>
          item.status === 'waiting' && item.wakeAt !== undefined,
        ).length
        // Retry backoff is an internal scheduling aid, not a reason to make
        // an otherwise recoverable Activation (or the whole graph) fail. If
        // the durable timer budget is full, keep the retry immediately ready.
        delayed = pendingTimers < this.graph.limits.maxPendingTimers
      }
      const reason = input.consumeAttempt ? 'retry' : 'replay'
      const next: ActivationRecord = {
        ...activation,
        status: delayed ? 'waiting' : 'ready',
        lease: undefined,
        usage: addUsage(activation.usage, input.usage),
        readyReason: delayed ? undefined : reason,
        wakeAt: delayed ? now + input.delayMs! : undefined,
        waitingReason: delayed ? reason : undefined,
        error: input.reason,
        updatedAt: now,
      }
      const instance: GraphInstanceRecord = {
        ...snapshot.instance,
        totalCostUsd: snapshot.instance.totalCostUsd + (input.usage?.costUsd ?? 0),
        updatedAt: now,
      }
      await this.store.appendEventLocked({ type: 'activation_released', at: now, activation: next, instance, reason })
      await this.store.writeActivationProjectionLocked(next)
      await this.store.writeInstanceProjectionLocked(instance)
      return next
    })
  }

  async failStop(input: {
    activationId: string
    leaseToken: string
    reason: string
    usage?: ActivationUsage
    now?: number
  }): Promise<GraphInstanceRecord> {
    const now = input.now ?? Date.now()
    return this.store.withTransaction(async () => {
      const snapshot = await this.store.authoritativeSnapshotLocked()
      const activation = snapshot.activations.get(input.activationId)
      if (activation?.status !== 'running' || activation.lease?.token !== input.leaseToken) {
        throw new Error(`activation lease lost for '${input.activationId}'`)
      }
      const instance: GraphInstanceRecord = {
        ...snapshot.instance,
        status: 'failed',
        statusReason: input.reason,
        totalCostUsd: snapshot.instance.totalCostUsd + (input.usage?.costUsd ?? 0),
        updatedAt: now,
      }
      const failed: ActivationRecord = {
        ...activation,
        status: 'failed',
        lease: undefined,
        usage: addUsage(activation.usage, input.usage),
        error: input.reason,
        updatedAt: now,
      }
      await this.store.appendEventLocked({ type: 'activation_released', at: now, activation: failed, instance, reason: 'fatal' })
      await this.store.writeActivationProjectionLocked(failed)
      await this.store.writeInstanceProjectionLocked(instance)
      return instance
    })
  }

  async resumeDue(now = Date.now(), event?: { name: string; correlation?: JsonValue; payload?: JsonValue }): Promise<ActivationRecord[]> {
    return this.store.withTransaction(async () => {
      const snapshot = await this.store.authoritativeSnapshotLocked()
      const resumed: ActivationRecord[] = []
      for (const activation of snapshot.activations.values()) {
        if (activation.status !== 'waiting') continue
        const timerDue = activation.wakeAt !== undefined && activation.wakeAt <= now
        const eventMatches = event && activation.event?.name === event.name && structurallyEqual(activation.event.correlation, event.correlation)
        if (!timerDue && !eventMatches) continue
        const next: ActivationRecord = {
          ...activation,
          status: 'ready',
          wakeAt: undefined,
          event: undefined,
          continuationVersion: activation.waitingReason === 'continuation' || activation.waitingReason === undefined
            ? activation.continuationVersion + 1
            : activation.continuationVersion,
          readyReason: activation.waitingReason ?? 'continuation',
          waitingReason: undefined,
          input: {
            ...activation.input,
            ...((activation.waitingReason === 'continuation' || activation.waitingReason === undefined)
              ? { __resume: eventMatches
                  ? { kind: 'event', name: event!.name, payload: event!.payload ?? null, at: now }
                  : { kind: 'timer', at: now } }
              : {}),
          },
          updatedAt: now,
        }
        await this.store.appendEventLocked({ type: 'activation_released', at: now, activation: next, reason: 'resumed' })
        await this.store.writeActivationProjectionLocked(next)
        resumed.push(next)
      }
      return resumed
    })
  }
}

function emptyUsage(): ActivationUsage {
  return { turns: 0, costUsd: 0, durationMs: 0 }
}

function addUsage(current: ActivationUsage | undefined, increment: ActivationUsage | undefined): ActivationUsage {
  const left = current ?? emptyUsage()
  const right = increment ?? emptyUsage()
  return {
    turns: left.turns + right.turns,
    costUsd: left.costUsd + right.costUsd,
    durationMs: left.durationMs + right.durationMs,
  }
}

function resultFromEvent(event: Extract<GraphJournalEvent, { type: 'activation_committed' }>, duplicate: boolean): CommitResult {
  return {
    activation: event.activation,
    spawned: event.spawned,
    instance: event.instance,
    transitionId: event.transitionId,
    duplicate,
  }
}

function structurallyEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function matchingEventActivations(
  activations: Iterable<ActivationRecord>,
  event: GraphExternalEventRecord,
): ActivationRecord[] {
  return [...activations].filter(activation =>
    activation.status === 'waiting' &&
    activation.event?.name === event.name &&
    structurallyEqual(activation.event.correlation, event.correlation) &&
    (activation.wakeAt === undefined || event.createdAt < activation.wakeAt))
}

function resumeForExternalEvent(
  activation: ActivationRecord,
  event: GraphExternalEventRecord,
  now: number,
): ActivationRecord {
  return {
    ...activation,
    status: 'ready',
    wakeAt: undefined,
    event: undefined,
    waitingReason: undefined,
    continuationVersion: activation.continuationVersion + 1,
    readyReason: 'continuation',
    input: {
      ...activation.input,
      __resume: { kind: 'event', name: event.name, payload: event.payload ?? null, eventId: event.id, at: now },
    },
    updatedAt: now,
  }
}
