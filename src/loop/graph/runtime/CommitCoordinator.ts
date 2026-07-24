import type { CapabilityRegistry, FunctionProvider, ReducerProvider } from '../registry/CapabilityRegistry.js'
import { createHash, randomUUID } from 'node:crypto'
import type {
  ActivationCommitIntent,
  ActivationRecord,
  FrozenLoopGraphSpec,
  GraphInstanceRecord,
  GraphJournalEvent,
  JsonValue,
  ActivationUsage,
  GraphExternalEventRecord,
  GraphExternalEventInput,
} from '../spec/GraphTypes.js'
import { GraphStore } from './GraphStore.js'
import { addUsage, emptyUsage } from './UsageMath.js'
import { decideTransition } from './TransitionEngine.js'
import { isJsonValue } from './GraphJson.js'
import type { ExecutionFailure } from '../../../infra/failures/ExecutionFailure.js'

export interface CommitResult {
  activation: ActivationRecord
  spawned: ActivationRecord[]
  instance: GraphInstanceRecord
  transitionId?: string
  duplicate: boolean
  replayed?: boolean
}

export class ParkLimitExceededError extends Error {
  constructor(readonly limit: number) {
    super(`maxPendingTimers ${limit} exhausted`)
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
        const event = (await this.store.readJournalEventLocked(committedSequence))?.event
        if (event?.type !== 'activation_committed') throw new Error(`commit index '${intent.commitKey}' is corrupt`)
        return resultFromEvent(event, true)
      }
      const activation = snapshot.activations.get(intent.activationId)
      if (!activation) throw new Error(`commit references missing activation '${intent.activationId}'`)
      if (activation.continuationVersion !== intent.continuationVersion) throw new Error(`stale continuation for activation '${intent.activationId}'`)
      if (!['running', 'ready'].includes(activation.status)) throw new Error(`activation '${intent.activationId}' cannot commit from ${activation.status}`)
      const node = this.graph.nodes[activation.nodeId]
      if (!node) throw new Error(`activation '${activation.id}' references missing node '${activation.nodeId}'`)
      if (snapshot.instance.status === 'done' || snapshot.instance.status === 'exhausted' || snapshot.instance.status === 'failed' || snapshot.instance.status === 'paused') {
        throw new Error(`graph '${snapshot.instance.instanceId}' is ${snapshot.instance.status}; stale activation '${activation.id}' cannot commit`)
      }

      let effectiveIntent = intent
      const executionStateVersion = activation.executionStateVersion ?? activation.inputStateVersion
      if (this.graph.concurrency?.stateConsistency === 'serializable' &&
          intent.expectedStateVersion !== undefined && intent.expectedStateVersion !== executionStateVersion) {
        throw new Error(`commit intent expected State v${intent.expectedStateVersion}, activation executed at v${executionStateVersion}`)
      }
      const expectedStateVersion = this.graph.concurrency?.stateConsistency === 'serializable'
        ? executionStateVersion
        : undefined
      if (expectedStateVersion !== undefined && snapshot.state.version !== expectedStateVersion) {
        const replayCount = activation.replayCount ?? 0
        const replayLimit = node.type === 'agent' ? MAX_AGENT_SERIALIZABLE_REPLAYS : MAX_SERIALIZABLE_REPLAYS
        if (replayCount < replayLimit) {
          const reason = `State advanced from v${expectedStateVersion} to v${snapshot.state.version}; replaying under serializable policy`
          const segmentUsage = intent.usage ?? emptyUsage()
          const projectedCost = snapshot.instance.totalCostUsd + segmentUsage.costUsd
          if (this.graph.limits.maxCostUsd !== undefined && projectedCost > this.graph.limits.maxCostUsd) {
            const costReason = `maxCostUsd ${this.graph.limits.maxCostUsd} exhausted during serializable replay`
            effectiveIntent = {
              ...intent,
              expectedStateVersion: undefined,
              outcome: 'exhausted',
              output: { error: costReason, limit: 'maxCostUsd' },
              summary: costReason,
            }
          } else {
          const requestedDelayMs = replayCount === 0 ? 0 : Math.min(5_000, 50 * 2 ** Math.min(replayCount, 6))
          const pendingTimers = [...snapshot.activations.values()].filter(item => item.status === 'waiting' && item.wakeAt !== undefined).length
          const delayed = requestedDelayMs > 0 && (this.graph.limits.maxPendingTimers === undefined || pendingTimers < this.graph.limits.maxPendingTimers)
          const replay: ActivationRecord = {
            ...activation,
            status: delayed ? 'waiting' : 'ready',
            lease: undefined,
            replayCount: replayCount + 1,
            usage: addUsage(activation.usage, segmentUsage),
            readyReason: delayed ? undefined : 'replay',
            waitingReason: delayed ? 'replay' : undefined,
            wakeAt: delayed ? now + requestedDelayMs : undefined,
            error: reason,
            summary: reason,
            updatedAt: now,
          }
          const instance: GraphInstanceRecord = {
            ...snapshot.instance,
            totalCostUsd: snapshot.instance.totalCostUsd + segmentUsage.costUsd,
            updatedAt: now,
          }
          await this.store.appendEventLocked({ type: 'activation_released', at: now, activation: replay, instance, reason: 'replay' })
          await this.store.writeActivationProjectionLocked(replay)
          await this.store.writeInstanceProjectionLocked(instance)
          await this.store.discardCommitIntentLocked(intent, reason)
          return { activation: replay, spawned: [], instance, duplicate: false, replayed: true }
          }
        }
        if (effectiveIntent === intent) {
          const reason = `serializable replay limit ${replayLimit} exhausted`
          effectiveIntent = {
            ...intent,
            expectedStateVersion: undefined,
            outcome: 'exhausted',
            output: { error: reason, limit: 'serializable_replays', replayLimit },
            summary: reason,
          }
        }
      }

      let state = snapshot.state
      let spawned: ActivationRecord[] = []
      let transitionId: string | undefined
      let cancelled: ActivationRecord[] = []
      let instance: GraphInstanceRecord = { ...snapshot.instance, updatedAt: now }
      const segmentUsage = effectiveIntent.usage ?? emptyUsage()
      instance.totalCostUsd = (instance.totalCostUsd ?? 0) + segmentUsage.costUsd
      let committedActivation: ActivationRecord
      if (node.type === 'terminal') {
        // A Terminal that could not evaluate its result (outcome 'failure')
        // must not report graph success -- respect the outcome over node.status.
        const terminalFailed = node.status === 'failed' || effectiveIntent.outcome === 'failure'
        committedActivation = {
          ...activation,
          usage: addUsage(activation.usage, segmentUsage),
          status: terminalFailed ? 'failed' : 'succeeded',
          lease: undefined,
          output: effectiveIntent.output,
          outcome: effectiveIntent.outcome,
          summary: effectiveIntent.summary,
          error: effectiveIntent.outcome === 'failure' ? (effectiveIntent.summary ?? 'terminal execution failed') : undefined,
          terminalResult: effectiveIntent.output,
          updatedAt: now,
        }
        instance = {
          ...instance,
          status: effectiveIntent.outcome === 'failure' ? 'failed' : node.status,
          terminalResult: effectiveIntent.output,
          statusReason: effectiveIntent.outcome === 'failure'
            ? (effectiveIntent.summary ?? 'terminal execution failed')
            : node.description,
        }
        cancelled = [...snapshot.activations.values()]
          .filter(peer => peer.id !== activation.id && ['ready', 'running', 'waiting'].includes(peer.status))
          .map(peer => ({ ...peer, status: 'cancelled' as const, lease: undefined, updatedAt: now, error: `cancelled by terminal activation ${activation.id}` }))
      } else {
        // Transition evaluation runs reducer/function plugin code. A thrown
        // error here must become a durable failed commit -- letting it escape
        // leaves the prepared intent poisoned and recoverPrepared replays the
        // same throw on every tick, wedging the instance forever.
        let decision: Awaited<ReturnType<typeof decideTransition>> | undefined
        let decisionError: string | undefined
        try {
          decision = await withTimeout(decideTransition({
            graph: this.graph,
            activation,
            outcome: effectiveIntent.outcome,
            output: effectiveIntent.output,
            state,
            functions: this.functions,
            reducers: this.reducers,
            now,
          }), TRANSITION_EVALUATION_TIMEOUT_MS, 'transition evaluation')
        } catch (error) {
          decisionError = message(error)
        }
        if (!decision) {
          if (effectiveIntent.outcome === 'exhausted') {
            const reason = effectiveIntent.summary ?? decisionError ?? `node '${activation.nodeId}' exhausted its execution budget`
            committedActivation = {
              ...activation,
              usage: addUsage(activation.usage, segmentUsage),
              status: 'succeeded',
              lease: undefined,
              output: effectiveIntent.output,
              outcome: 'exhausted',
              summary: reason,
              error: undefined,
              updatedAt: now,
            }
            instance = { ...instance, status: 'exhausted', statusReason: reason }
            cancelled = cancelLivePeers(snapshot.activations.values(), activation.id, reason, now)
            const event: Extract<GraphJournalEvent, { type: 'activation_committed' }> = {
              type: 'activation_committed', at: now, commitKey: intent.commitKey,
              activation: committedActivation, spawned: [],
              ...(cancelled.length ? { cancelled } : {}),
              state, instance,
            }
            const journal = await this.store.appendEventLocked(event)
            await this.store.writeCommitProjectionLocked(event, journal.sequence)
            return resultFromEvent(event, false)
          }
          const reason = `transition evaluation failed for node '${activation.nodeId}' outcome '${effectiveIntent.outcome}': ${decisionError}`
          committedActivation = {
            ...activation,
            usage: addUsage(activation.usage, segmentUsage),
            status: 'failed',
            lease: undefined,
            output: effectiveIntent.output,
            outcome: effectiveIntent.outcome,
            summary: reason,
            error: reason,
            updatedAt: now,
          }
          instance = { ...instance, status: 'failed', statusReason: reason }
          const event: Extract<GraphJournalEvent, { type: 'activation_committed' }> = {
            type: 'activation_committed',
            at: now,
            commitKey: intent.commitKey,
            activation: committedActivation,
            spawned: [],
            state,
            instance,
          }
          const journal = await this.store.appendEventLocked(event)
          await this.store.writeCommitProjectionLocked(event, journal.sequence)
          return resultFromEvent(event, false)
        }
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
          status: effectiveIntent.outcome === 'failure' ? 'failed' : 'succeeded',
          lease: undefined,
          output: effectiveIntent.output,
          outcome: effectiveIntent.outcome,
          summary: effectiveIntent.summary,
          error: undefined,
          updatedAt: now,
        }
        if (node.type === 'join') {
          cancelled = [...snapshot.activations.values()]
            .filter(peer => peer.id !== activation.id && peer.nodeId === activation.nodeId &&
              peer.forkGroupId === activation.forkGroupId && ['ready', 'running', 'waiting'].includes(peer.status))
            .map(peer => ({ ...peer, status: 'cancelled' as const, lease: undefined, updatedAt: now, error: `coalesced by join activation ${activation.id}` }))
        }
        const totalLimit = this.graph.limits.maxTotalActivations ?? this.graph.limits.maxActivations
        const projectedTotal = instance.activationCount + spawned.length
        const projectedLive = countLiveActivations(snapshot.activations.values()) - 1 - cancelled.length + spawned.length
        const exhaustionReason = totalLimit !== undefined && projectedTotal > totalLimit
          ? `maxTotalActivations ${totalLimit} exhausted`
          : this.graph.limits.maxLiveActivations !== undefined && projectedLive > this.graph.limits.maxLiveActivations
            ? `maxLiveActivations ${this.graph.limits.maxLiveActivations} exhausted`
            : this.graph.limits.maxCostUsd !== undefined && instance.totalCostUsd > this.graph.limits.maxCostUsd
              ? `maxCostUsd ${this.graph.limits.maxCostUsd} exhausted`
              : undefined
        if (exhaustionReason) {
          spawned = []
          committedActivation = {
            ...committedActivation,
            status: 'succeeded', outcome: 'exhausted', error: undefined,
            output: { error: exhaustionReason }, summary: exhaustionReason,
          }
          instance = { ...instance, status: 'exhausted', statusReason: exhaustionReason }
          cancelled = cancelLivePeers(snapshot.activations.values(), activation.id, exhaustionReason, now)
        } else {
          instance = { ...instance, activationCount: projectedTotal }
        }
      }
      const event: Extract<GraphJournalEvent, { type: 'activation_committed' }> = {
        type: 'activation_committed',
        at: now,
        commitKey: intent.commitKey,
        activation: committedActivation,
        spawned,
        ...(cancelled.length ? { cancelled } : {}),
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
      const decision = await withTimeout(decideTransition({
        graph: this.graph,
        activation,
        outcome: 'resume',
        output: activation.output ?? activation.terminalResult ?? activation.input,
        state: snapshot.state,
        functions: this.functions,
        reducers: this.reducers,
        now,
      }), TRANSITION_EVALUATION_TIMEOUT_MS, 'paused-terminal transition evaluation')
      const resumedActivation: ActivationRecord = { ...activation, resumedAt: now, updatedAt: now }
      const totalLimit = this.graph.limits.maxTotalActivations ?? this.graph.limits.maxActivations
      const projectedTotal = snapshot.instance.activationCount + decision.spawned.length
      const projectedLive = countLiveActivations(snapshot.activations.values()) + decision.spawned.length
      const exhaustionReason = totalLimit !== undefined && projectedTotal > totalLimit
        ? `maxTotalActivations ${totalLimit} exhausted while resuming paused Terminal`
        : this.graph.limits.maxLiveActivations !== undefined && projectedLive > this.graph.limits.maxLiveActivations
          ? `maxLiveActivations ${this.graph.limits.maxLiveActivations} exhausted while resuming paused Terminal`
          : undefined
      const cancelled = exhaustionReason
        ? cancelLivePeers(snapshot.activations.values(), activation.id, exhaustionReason, now)
        : []
      const instance: GraphInstanceRecord = {
        ...snapshot.instance,
        status: exhaustionReason ? 'exhausted' : 'active',
        statusReason: exhaustionReason ?? `resumed from paused Terminal '${activation.nodeId}'`,
        terminalResult: undefined,
        activationCount: exhaustionReason ? snapshot.instance.activationCount : projectedTotal,
        updatedAt: now,
      }
      const event: Extract<GraphJournalEvent, { type: 'paused_terminal_resumed' }> = {
        type: 'paused_terminal_resumed',
        at: now,
        activation: resumedActivation,
        spawned: exhaustionReason ? [] : decision.spawned,
        ...(cancelled.length ? { cancelled } : {}),
        state: exhaustionReason ? snapshot.state : decision.state,
        instance,
        transitionId: decision.transition.id,
      }
      await this.store.appendEventLocked(event)
      await this.store.writePausedResumeProjectionLocked(event)
      return { spawned: exhaustionReason ? [] : decision.spawned, instance }
    })
  }

  async recordExternalEvent(input: GraphExternalEventInput & {
    now?: number
  }): Promise<{ event: GraphExternalEventRecord; resumed: ActivationRecord[]; duplicate: boolean }> {
    const now = input.now ?? Date.now()
    validateExternalEventInput(input)
    return this.store.withTransaction(async () => {
      const snapshot = await this.store.authoritativeSnapshotLocked()
      const id = input.source && input.deliveryId
        ? externalDeliveryEventId(input.source, input.deliveryId)
        : `event-${randomUUID()}`
      const existing = snapshot.externalEvents.get(id)
      let event: GraphExternalEventRecord
      let duplicate = false
      if (existing) {
        if (!sameExternalDelivery(existing, input)) {
          throw new Error(`external event delivery conflict for '${input.source}:${input.deliveryId}'`)
        }
        event = existing
        duplicate = true
      } else {
        event = {
          schemaVersion: 'graph-external-event-1.0',
          id,
          ...(input.source ? { source: input.source, deliveryId: input.deliveryId } : {}),
          name: input.name,
          correlation: input.correlation,
          payload: input.payload,
          status: 'pending',
          createdAt: now,
        }
        await this.store.appendEventLocked({ type: 'external_event_recorded', at: now, externalEvent: event })
        await this.store.writeExternalEventProjectionLocked(event)
      }
      if (event.status === 'consumed') return { event, resumed: [], duplicate }
      // A redelivery may be the call that repairs a crash between accepting a
      // pending event and consuming it. Re-run matching without creating a
      // second inbox record.
      const resumed = matchingEventActivations(snapshot.activations.values(), event).map(activation =>
        resumeForExternalEvent(activation, event, now))
      if (!resumed.length) return { event, resumed, duplicate }
      const consumed: GraphExternalEventRecord = {
        ...event,
        status: 'consumed',
        consumedAt: now,
        consumedBy: resumed.map(activation => activation.id),
      }
      await this.store.appendEventLocked({ type: 'external_event_consumed', at: now, externalEvent: consumed, activations: resumed })
      for (const activation of resumed) await this.store.writeActivationProjectionLocked(activation)
      await this.store.writeExternalEventProjectionLocked(consumed)
      return { event: consumed, resumed, duplicate }
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
    reason: string
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
        summary: input.reason,
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
        replayCount: input.consumeAttempt ? activation.replayCount : (activation.replayCount ?? 0) + 1,
        usage: addUsage(activation.usage, input.usage),
        readyReason: delayed ? undefined : reason,
        wakeAt: delayed ? now + input.delayMs! : undefined,
        waitingReason: delayed ? reason : undefined,
        error: input.reason,
        summary: input.reason,
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

  async block(input: {
    activationId: string
    leaseToken: string
    reason: string
    failure: ExecutionFailure
    usage?: ActivationUsage
    now?: number
  }): Promise<{ activation: ActivationRecord; instance: GraphInstanceRecord }> {
    const now = input.now ?? Date.now()
    return this.store.withTransaction(async () => {
      const snapshot = await this.store.authoritativeSnapshotLocked()
      const activation = snapshot.activations.get(input.activationId)
      if (activation?.status !== 'running' || activation.lease?.token !== input.leaseToken) {
        throw new Error(`activation lease lost for '${input.activationId}'`)
      }
      const next: ActivationRecord = {
        ...activation,
        status: 'ready',
        lease: undefined,
        replayCount: (activation.replayCount ?? 0) + 1,
        usage: addUsage(activation.usage, input.usage),
        readyReason: 'replay',
        wakeAt: undefined,
        waitingReason: undefined,
        error: input.reason,
        summary: input.reason,
        blockedFailure: input.failure,
        updatedAt: now,
      }
      const instance: GraphInstanceRecord = {
        ...snapshot.instance,
        status: 'paused',
        statusReason: input.reason,
        blockedFailure: input.failure,
        totalCostUsd: snapshot.instance.totalCostUsd + (input.usage?.costUsd ?? 0),
        updatedAt: now,
      }
      const event: Extract<GraphJournalEvent, { type: 'activation_blocked' }> = {
        type: 'activation_blocked',
        at: now,
        activation: next,
        instance,
        failure: input.failure,
      }
      await this.store.appendEventLocked(event)
      await this.store.writeBlockedProjectionLocked(event)
      return { activation: next, instance }
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
        summary: input.reason,
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

  /**
   * Repair the post-commit Join notification window. Join arrivals are durable
   * Activation records, while their immediate resume signal is only an
   * optimization in a later transaction. Recompute complete barriers on every
   * tick so a lost signal or lock timeout cannot leave every member parked.
   */
  async reconcileWaitingJoins(now = Date.now()): Promise<ActivationRecord[]> {
    return this.store.withTransaction(async () => {
      const snapshot = await this.store.authoritativeSnapshotLocked()
      const resumed: ActivationRecord[] = []
      const waiting = [...snapshot.activations.values()]
        .filter(activation => activation.status === 'waiting' && this.graph.nodes[activation.nodeId]?.type === 'join')
        .sort((a, b) => a.nodeId.localeCompare(b.nodeId) ||
          (a.forkGroupId ?? '').localeCompare(b.forkGroupId ?? '') || a.id.localeCompare(b.id))
      for (const activation of waiting) {
        const node = this.graph.nodes[activation.nodeId]
        if (node?.type !== 'join') continue
        const candidates = [...snapshot.activations.values()].filter(candidate =>
          candidate.nodeId === activation.nodeId &&
          candidate.forkGroupId === activation.forkGroupId &&
          candidate.sourceTransitionId !== undefined &&
          node.expects.includes(candidate.sourceTransitionId) &&
          ['ready', 'running', 'waiting'].includes(candidate.status))
        const arrived = new Set(candidates.map(candidate => candidate.sourceTransitionId!))
        const complete = node.mode === 'any' ? arrived.size > 0 : node.expects.every(id => arrived.has(id))
        if (!complete) continue
        const leader = [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0]
        if (leader?.id !== activation.id) continue
        const eventName = `join:${activation.nodeId}`
        if (activation.event?.name !== eventName ||
          !structurallyEqual(activation.event.correlation, activation.forkGroupId ?? null)) continue
        const next: ActivationRecord = {
          ...activation,
          status: 'ready',
          wakeAt: undefined,
          event: undefined,
          continuationVersion: activation.continuationVersion + 1,
          readyReason: 'continuation',
          waitingReason: undefined,
          input: {
            ...activation.input,
            __resume: { kind: 'event', name: eventName, payload: null, at: now },
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  return canonicalJson(a) === canonicalJson(b)
}

function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function externalDeliveryEventId(source: string, deliveryId: string): string {
  const digest = createHash('sha256').update(source).update('\0').update(deliveryId).digest('hex')
  return `event-delivery-${digest}`
}

function validateExternalEventInput(input: GraphExternalEventInput): void {
  if (!input.name.trim()) throw new Error('external event name must not be empty')
  if (input.name.length > 256) throw new Error('external event name exceeds 256 characters')
  if ((input.source === undefined) !== (input.deliveryId === undefined)) {
    throw new Error('external event source and deliveryId must be provided together')
  }
  if (input.source !== undefined && (!input.source.trim() || input.source.length > 128)) {
    throw new Error('external event source must be 1..128 characters')
  }
  if (input.deliveryId !== undefined && (!input.deliveryId.trim() || input.deliveryId.length > 512)) {
    throw new Error('external event deliveryId must be 1..512 characters')
  }
  if (input.correlation !== undefined && !isJsonValue(input.correlation)) throw new Error('external event correlation must be JSON')
  if (input.payload !== undefined && !isJsonValue(input.payload)) throw new Error('external event payload must be JSON')
  // Correlation/payload flow into recursive canonicalization (structural
  // equality) on every match attempt. Reject pathological nesting at ingress
  // so it cannot stack-overflow the kernel later.
  if (exceedsJsonDepth(input.correlation, MAX_EXTERNAL_EVENT_DEPTH)) throw new Error(`external event correlation exceeds depth ${MAX_EXTERNAL_EVENT_DEPTH}`)
  if (exceedsJsonDepth(input.payload, MAX_EXTERNAL_EVENT_DEPTH)) throw new Error(`external event payload exceeds depth ${MAX_EXTERNAL_EVENT_DEPTH}`)
  const bytes = Buffer.byteLength(JSON.stringify({ correlation: input.correlation, payload: input.payload }), 'utf8')
  if (bytes > MAX_EXTERNAL_EVENT_BYTES) throw new Error(`external event data exceeds ${MAX_EXTERNAL_EVENT_BYTES} bytes`)
}

/** Depth check whose recursion is bounded by `limit` itself (safe on any input). */
function exceedsJsonDepth(value: unknown, limit: number): boolean {
  if (value === null || typeof value !== 'object') return false
  if (limit <= 1) return true
  const children = Array.isArray(value) ? value : Object.values(value)
  return children.some(child => exceedsJsonDepth(child, limit - 1))
}

const MAX_AGENT_SERIALIZABLE_REPLAYS = 5
const MAX_SERIALIZABLE_REPLAYS = 50
const MAX_EXTERNAL_EVENT_BYTES = 1024 * 1024
const MAX_EXTERNAL_EVENT_DEPTH = 64
const TRANSITION_EVALUATION_TIMEOUT_MS = 30_000

function countLiveActivations(activations: Iterable<ActivationRecord>): number {
  return [...activations].filter(activation => ['ready', 'running', 'waiting', 'committing'].includes(activation.status)).length
}

function cancelLivePeers(
  activations: Iterable<ActivationRecord>,
  exceptId: string,
  reason: string,
  now: number,
): ActivationRecord[] {
  return [...activations]
    .filter(activation => activation.id !== exceptId && ['ready', 'running', 'waiting', 'committing'].includes(activation.status))
    .map(activation => ({
      ...activation,
      status: 'cancelled' as const,
      lease: undefined,
      updatedAt: now,
      error: `cancelled because graph exhausted: ${reason}`,
    }))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function sameExternalDelivery(existing: GraphExternalEventRecord, input: GraphExternalEventInput): boolean {
  return existing.source === input.source &&
    existing.deliveryId === input.deliveryId &&
    existing.name === input.name &&
    structurallyEqual(existing.correlation, input.correlation) &&
    structurallyEqual(existing.payload, input.payload)
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
