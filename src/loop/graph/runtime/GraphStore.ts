import { randomUUID } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  atomicWriteJson,
  ensureDir,
  listJsonIds,
  readJsonFile,
  withFileLock,
} from '../../../infra/persist/index.js'
import { ensureWorkspaceIdentity } from '../../workspace/WorkspaceIdentity.js'
import type { CapabilityRegistry, FunctionProvider } from '../registry/CapabilityRegistry.js'
import type {
  ActivationCommitIntent,
  ActivationRecord,
  FrozenLoopGraphSpec,
  GraphInstanceRecord,
  GraphJournalEvent,
  GraphStateSnapshot,
  JsonValue,
  GraphArtifactRecord,
  SequencedGraphJournalEvent,
  ActivationUsage,
  GraphExternalEventRecord,
  ContextSectionSnapshot,
  GraphEffectIntent,
} from '../spec/GraphTypes.js'
import { verifyFrozenGraphIntegrity } from '../spec/GraphValidate.js'
import { evaluateBindings } from './GraphExpression.js'
import { hydrateInitialStateFromWorkspace } from './WorkspaceFile.js'

export interface GraphPaths {
  root: string
  instanceJson: string
  graphDir: string
  specJson: string
  stateJson: string
  activationsDir: string
  journalDir: string
  intentsDir: string
  effectIntentsDir: string
  lanesDir: string
  artifactsDir: string
  eventsDir: string
  journalSequenceJson: string
  checkpointJson: string
  transactionLock: string
}

export interface GraphSnapshot {
  instance: GraphInstanceRecord
  state: GraphStateSnapshot
  activations: Map<string, ActivationRecord>
  lastSequence: number
  commitKeys: Map<string, number>
  artifacts: Map<string, GraphArtifactRecord>
  externalEvents: Map<string, GraphExternalEventRecord>
}

export function graphPaths(projectDir: string, instanceId: string): GraphPaths {
  const root = join(resolve(projectDir), '.loop', instanceId)
  const graphDir = join(root, 'graph')
  return {
    root,
    instanceJson: join(root, 'instance.json'),
    graphDir,
    specJson: join(graphDir, 'spec.json'),
    stateJson: join(graphDir, 'state.json'),
    activationsDir: join(graphDir, 'activations'),
    journalDir: join(graphDir, 'journal'),
    intentsDir: join(graphDir, 'commit-intents'),
    effectIntentsDir: join(graphDir, 'effect-intents'),
    lanesDir: join(graphDir, 'lanes'),
    artifactsDir: join(graphDir, 'artifacts'),
    eventsDir: join(graphDir, 'events'),
    journalSequenceJson: join(graphDir, 'journal-sequence.json'),
    checkpointJson: join(graphDir, 'checkpoint.json'),
    transactionLock: join(graphDir, '.transaction'),
  }
}

export interface CreateGraphInstanceInput {
  projectDir: string
  instanceId?: string
  graph: FrozenLoopGraphSpec
  functions: CapabilityRegistry<FunctionProvider>
  now?: number
}

export class GraphStore {
  readonly paths: GraphPaths

  constructor(readonly projectDir: string, readonly instanceId: string) {
    this.projectDir = resolve(projectDir)
    this.paths = graphPaths(this.projectDir, instanceId)
  }

  static async create(input: CreateGraphInstanceInput): Promise<GraphStore> {
    verifyFrozenGraphIntegrity(input.graph)
    const instanceId = input.instanceId ?? `${input.graph.id}-v${input.graph.version}`
    const store = new GraphStore(input.projectDir, instanceId)
    await store.ensureLayout()
    const initialize = await store.withTransaction(async () => {
      const existing = await readJsonFile<GraphInstanceRecord>(store.paths.instanceJson)
      if (existing) {
        if (existing.engine !== 'durable-graph-v1') throw new Error(`instance '${instanceId}' belongs to a different loop engine`)
        if (existing.graphHash !== input.graph.graphHash) throw new Error(`instance '${instanceId}' already exists with a different graph`)
        return false
      }
      const events = await store.readJournalLocked()
      if (events.length) {
        await store.reconcileLocked(events)
        return false
      }
      return true
    })
    if (!initialize) return store

    // Capability Functions are trusted and declared pure, but they are still
    // plugin code. Materialize entrypoint inputs outside the Graph transaction.
    const workspace = await ensureWorkspaceIdentity(input.projectDir)
    const now = input.now ?? Date.now()
    const initialState = await hydrateInitialStateFromWorkspace(
      input.projectDir,
      input.graph,
      Object.fromEntries(Object.entries(input.graph.state).map(([name, variable]) => [name, variable.initial])),
    )
    const state: GraphStateSnapshot = {
      schemaVersion: 'graph-state-1.0',
      version: 0,
      values: initialState,
      updatedAt: now,
    }
    const materializedEntries = await Promise.all(input.graph.entrypoints.map(async entry => ({
      entry,
      values: await evaluateBindings(entry.inputs, { state: state.values }, input.functions),
    })))
    const activations: ActivationRecord[] = materializedEntries.map(({ entry, values }) => ({
          schemaVersion: 'graph-activation-1.0',
          id: activationId(),
          nodeId: entry.node,
          status: 'ready',
          attempt: 0,
          segmentCount: 0,
          parkCount: 0,
          usage: emptyUsage(),
          readyReason: 'initial',
          createdAt: now,
          updatedAt: now,
          input: values,
          inputStateVersion: 0,
          continuationVersion: 0,
    }))
    const instance: GraphInstanceRecord = {
        schemaVersion: 'graph-instance-1.0',
        engine: 'durable-graph-v1',
        instanceId,
        graphId: input.graph.id,
        graphVersion: input.graph.version,
        graphHash: input.graph.graphHash,
        workspaceId: workspace.workspaceId,
        projectDir: resolve(input.projectDir),
        status: 'active',
        createdAt: now,
        updatedAt: now,
        activationCount: activations.length,
        totalCostUsd: 0,
    }
    await store.withTransaction(async () => {
      const existing = await readJsonFile<GraphInstanceRecord>(store.paths.instanceJson)
      if (existing) {
        if (existing.engine !== 'durable-graph-v1') throw new Error(`instance '${instanceId}' belongs to a different loop engine`)
        if (existing.graphHash !== input.graph.graphHash) throw new Error(`instance '${instanceId}' already exists with a different graph`)
        return
      }
      const racedEvents = await store.readJournalLocked()
      if (racedEvents.length) {
        await store.reconcileLocked(racedEvents)
        return
      }
      await atomicWriteJson(store.paths.specJson, input.graph)
      const event: GraphJournalEvent = { type: 'graph_created', at: now, state, activations, instance }
      await store.appendEventLocked(event)
      await store.writeProjectionsLocked({
        instance,
        state,
        activations: new Map(activations.map(a => [a.id, a])),
        lastSequence: 1,
        commitKeys: new Map(),
        artifacts: new Map(),
        externalEvents: new Map(),
      })
    })
    return store
  }

  async ensureLayout(): Promise<void> {
    await Promise.all([
      this.paths.root,
      this.paths.graphDir,
      this.paths.activationsDir,
      this.paths.journalDir,
      this.paths.intentsDir,
      this.paths.effectIntentsDir,
      this.paths.lanesDir,
      this.paths.artifactsDir,
      this.paths.eventsDir,
    ].map(dir => mkdir(dir, { recursive: true })))
  }

  async loadSpec(): Promise<FrozenLoopGraphSpec> {
    const spec = await readJsonFile<FrozenLoopGraphSpec>(this.paths.specJson)
    if (!spec || spec.schemaVersion !== 'graph-1.0' || !spec.graphHash) throw new Error(`graph spec is missing for '${this.instanceId}'`)
    verifyFrozenGraphIntegrity(spec)
    return spec
  }

  async snapshot(): Promise<GraphSnapshot> {
    await this.ensureLayout()
    return this.withTransaction(async () => this.reconcileLocked())
  }

  async claimReady(options: { owner: string; now?: number; ttlMs?: number; limit?: number }): Promise<ActivationRecord[]> {
    const now = options.now ?? Date.now()
    const ttlMs = options.ttlMs ?? 10 * 60_000
    const limit = options.limit ?? Number.POSITIVE_INFINITY
    return this.withTransaction(async () => {
      const snapshot = await this.reconcileLocked()
      if (snapshot.instance.status !== 'active') return []
      const spec = await this.loadSpec()
      const runningLanes = new Set(
        [...snapshot.activations.values()]
          .filter(a => a.status === 'running' && a.laneId)
          .map(a => a.laneId!),
      )
      const runningPerNode = new Map<string, number>()
      for (const activation of snapshot.activations.values()) if (activation.status === 'running') {
        runningPerNode.set(activation.nodeId, (runningPerNode.get(activation.nodeId) ?? 0) + 1)
      }
      const maxTotal = spec.concurrency?.maxActivations ?? 1
      let runningTotal = [...snapshot.activations.values()].filter(a => a.status === 'running').length
      const claimed: ActivationRecord[] = []
      const ready = [...snapshot.activations.values()].filter(a => a.status === 'ready').sort(compareActivation)
      const terminal = ready.find(activation => spec.nodes[activation.nodeId]?.type === 'terminal')
      // A Terminal is a graph-wide barrier: never start it beside live work,
      // and once one is ready do not launch additional branches ahead of it.
      const candidates = terminal ? (runningTotal === 0 ? [terminal] : []) : ready
      for (const activation of candidates) {
        if (claimed.length >= limit || runningTotal >= maxTotal) break
        const node = spec.nodes[activation.nodeId]
        if (!node) throw new Error(`activation '${activation.id}' references missing node '${activation.nodeId}'`)
        const laneId = node.type === 'agent' ? node.lane : undefined
        if (laneId && runningLanes.has(laneId)) continue
        const maxNode = spec.concurrency?.maxPerNode ?? Number.POSITIVE_INFINITY
        if ((runningPerNode.get(activation.nodeId) ?? 0) >= maxNode) continue
        const next: ActivationRecord = {
          ...activation,
          laneId,
          status: 'running',
          attempt: activation.readyReason === 'continuation' || activation.readyReason === 'replay'
            ? activation.attempt
            : activation.attempt + 1,
          segmentCount: (activation.segmentCount ?? 0) + 1,
          executionStateVersion: snapshot.state.version,
          firstStartedAt: activation.firstStartedAt ?? now,
          readyReason: undefined,
          updatedAt: now,
          lease: { token: randomUUID(), owner: options.owner, expiresAt: now + ttlMs },
        }
        snapshot.activations.set(next.id, next)
        await this.appendEventLocked({ type: 'activation_claimed', at: now, activation: next })
        await atomicWriteJson(this.activationPath(next.id), next)
        if (laneId) runningLanes.add(laneId)
        runningPerNode.set(next.nodeId, (runningPerNode.get(next.nodeId) ?? 0) + 1)
        runningTotal++
        claimed.push(next)
        if (node.type === 'terminal') break
      }
      return claimed
    })
  }

  async heartbeat(activationIdValue: string, leaseToken: string, now = Date.now(), ttlMs = 10 * 60_000): Promise<boolean> {
    return this.withTransaction(async () => {
      const snapshot = await this.reconcileLocked()
      const activation = snapshot.activations.get(activationIdValue)
      if (activation?.status !== 'running' || activation.lease?.token !== leaseToken) return false
      const next = { ...activation, updatedAt: now, lease: { ...activation.lease, expiresAt: now + ttlMs } }
      // Lease renewal is ephemeral scheduler state. The original claim is in
      // the journal; repeated heartbeats only update its fenced projection.
      await atomicWriteJson(this.activationPath(next.id), next)
      return true
    })
  }

  /** Durably memoize an activation_start context section under the live lease. */
  async cacheActivationContext(input: {
    activationId: string
    leaseToken: string
    section: ContextSectionSnapshot
    now?: number
  }): Promise<ContextSectionSnapshot> {
    return this.withTransaction(async () => {
      const snapshot = await this.reconcileLocked()
      const activation = snapshot.activations.get(input.activationId)
      if (!activation || activation.status !== 'running' || activation.lease?.token !== input.leaseToken) {
        throw new Error(`activation lease lost while caching context for '${input.activationId}'`)
      }
      const existing = activation.contextCache?.[input.section.name]
      if (existing) return existing
      const next: ActivationRecord = {
        ...activation,
        contextCache: { ...(activation.contextCache ?? {}), [input.section.name]: input.section },
        updatedAt: input.now ?? Date.now(),
      }
      await this.appendEventLocked({
        type: 'activation_context_cached',
        at: input.now ?? Date.now(),
        activation: next,
        sectionName: input.section.name,
      })
      await atomicWriteJson(this.activationPath(next.id), next)
      return input.section
    })
  }

  async prepareCommit(input: {
    activationId: string
    leaseToken: string
    outcome: string
    output: JsonValue
    usage?: ActivationUsage
    now?: number
  }): Promise<ActivationCommitIntent> {
    return this.withTransaction(async () => {
      const snapshot = await this.reconcileLocked()
      const activation = snapshot.activations.get(input.activationId)
      if (!activation || activation.status !== 'running' || activation.lease?.token !== input.leaseToken) {
        throw new Error(`activation lease lost for '${input.activationId}'`)
      }
      const commitKey = `${activation.id}:${activation.continuationVersion}`
      const existing = await readJsonFile<ActivationCommitIntent>(this.intentPath(commitKey))
      if (existing) return existing
      const intent: ActivationCommitIntent = {
        schemaVersion: 'graph-commit-intent-1.0',
        commitKey,
        activationId: activation.id,
        continuationVersion: activation.continuationVersion,
        leaseToken: input.leaseToken,
        outcome: input.outcome,
        output: input.output,
        usage: input.usage,
        createdAt: input.now ?? Date.now(),
        status: 'prepared',
      }
      await atomicWriteJson(this.intentPath(commitKey), intent)
      return intent
    })
  }

  async listPreparedIntents(): Promise<ActivationCommitIntent[]> {
    const ids = await listJsonIds(this.paths.intentsDir)
    const intents = await Promise.all(ids.map(id => readJsonFile<ActivationCommitIntent>(join(this.paths.intentsDir, `${id}.json`))))
    return intents.filter((intent): intent is ActivationCommitIntent => intent?.status === 'prepared')
  }

  /** Persist the Effect operation before contacting the external provider. */
  async prepareEffectIntent(input: Omit<GraphEffectIntent, 'schemaVersion' | 'status' | 'createdAt' | 'updatedAt'>, now = Date.now()): Promise<GraphEffectIntent> {
    return this.withTransaction(async () => {
      const path = this.effectIntentPath(input.operationKey)
      const existing = await readJsonFile<GraphEffectIntent>(path)
      if (existing) {
        if (existing.effect !== input.effect || existing.idempotencyKey !== input.idempotencyKey || JSON.stringify(existing.input) !== JSON.stringify(input.input)) {
          throw new Error(`Effect operation '${input.operationKey}' changed after it was prepared`)
        }
        return existing
      }
      const intent: GraphEffectIntent = {
        schemaVersion: 'graph-effect-intent-1.0',
        ...input,
        status: 'prepared',
        createdAt: now,
        updatedAt: now,
      }
      await atomicWriteJson(path, intent)
      return intent
    })
  }

  async recordEffectReceipt(operationKey: string, receipt: JsonValue, now = Date.now()): Promise<GraphEffectIntent> {
    return this.withTransaction(async () => {
      const path = this.effectIntentPath(operationKey)
      const intent = await readJsonFile<GraphEffectIntent>(path)
      if (!intent) throw new Error(`Effect operation '${operationKey}' was not prepared`)
      if (intent.receipt !== undefined && JSON.stringify(intent.receipt) !== JSON.stringify(receipt)) {
        throw new Error(`Effect operation '${operationKey}' returned a different receipt for the same idempotency key`)
      }
      const next: GraphEffectIntent = { ...intent, status: 'submitted', receipt, updatedAt: now }
      await atomicWriteJson(path, next)
      return next
    })
  }

  async readEffectIntent(operationKey: string): Promise<GraphEffectIntent | null> {
    await this.ensureLayout()
    return readJsonFile<GraphEffectIntent>(this.effectIntentPath(operationKey))
  }

  async completeEffectIntent(operationKey: string, result: { status: 'succeeded'; output: JsonValue } | { status: 'failed'; error: string }, now = Date.now()): Promise<void> {
    await this.withTransaction(async () => {
      const path = this.effectIntentPath(operationKey)
      const intent = await readJsonFile<GraphEffectIntent>(path)
      if (!intent) throw new Error(`Effect operation '${operationKey}' was not prepared`)
      const next: GraphEffectIntent = result.status === 'succeeded'
        ? { ...intent, status: 'succeeded', output: result.output, updatedAt: now }
        : { ...intent, status: 'failed', error: result.error, updatedAt: now }
      await atomicWriteJson(path, next)
    })
  }

  async releaseExpiredClaims(now = Date.now()): Promise<number> {
    return this.withTransaction(async () => {
      const snapshot = await this.reconcileLocked()
      let released = 0
      for (const activation of snapshot.activations.values()) {
        if (activation.status !== 'running' || (activation.lease?.expiresAt ?? Number.POSITIVE_INFINITY) > now) continue
        const next: ActivationRecord = {
          ...activation,
          status: 'ready',
          lease: undefined,
          readyReason: 'retry',
          updatedAt: now,
        }
        snapshot.activations.set(next.id, next)
        await this.appendEventLocked({ type: 'activation_released', at: now, activation: next, reason: 'lease_expired' })
        await atomicWriteJson(this.activationPath(next.id), next)
        released++
      }
      return released
    })
  }

  async readIntent(commitKey: string): Promise<ActivationCommitIntent | null> {
    return readJsonFile<ActivationCommitIntent>(this.intentPath(commitKey))
  }

  async setStatus(status: GraphInstanceRecord['status'], reason?: string, now = Date.now()): Promise<GraphInstanceRecord> {
    return this.withTransaction(async () => {
      const snapshot = await this.reconcileLocked()
      if (snapshot.instance.status === 'done' || snapshot.instance.status === 'failed') return snapshot.instance
      if (snapshot.instance.status === status && snapshot.instance.statusReason === reason) return snapshot.instance
      const instance: GraphInstanceRecord = { ...snapshot.instance, status, statusReason: reason, updatedAt: now }
      await this.appendEventLocked({ type: 'graph_status_changed', at: now, instance })
      await atomicWriteJson(this.paths.instanceJson, instance)
      return instance
    })
  }

  async failActivation(activationIdValue: string, error: string, now = Date.now()): Promise<void> {
    await this.withTransaction(async () => {
      const snapshot = await this.reconcileLocked()
      const activation = snapshot.activations.get(activationIdValue)
      if (activation && !['succeeded', 'failed', 'cancelled'].includes(activation.status)) {
        const failed: ActivationRecord = { ...activation, status: 'failed', lease: undefined, error, updatedAt: now }
        await this.appendEventLocked({ type: 'activation_released', at: now, activation: failed, reason: 'kernel_failure' })
        await atomicWriteJson(this.activationPath(failed.id), failed)
      }
      if (snapshot.instance.status !== 'done' && snapshot.instance.status !== 'failed') {
        const instance: GraphInstanceRecord = { ...snapshot.instance, status: 'failed', statusReason: error, updatedAt: now }
        await this.appendEventLocked({ type: 'graph_status_changed', at: now, instance })
        await atomicWriteJson(this.paths.instanceJson, instance)
      }
    })
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureLayout()
    return withFileLock(this.paths.transactionLock, fn, { staleMs: 15 * 60_000, timeoutMs: 60_000 })
  }

  /** Caller must hold withTransaction. Journal is written before projections. */
  async appendEventLocked(event: GraphJournalEvent): Promise<SequencedGraphJournalEvent> {
    let sequence = await this.readLastSequenceLocked() + 1
    while (await readJsonFile<SequencedGraphJournalEvent>(this.journalPath(sequence))) sequence++
    const record: SequencedGraphJournalEvent = {
      schemaVersion: 'graph-journal-1.0', sequence, eventId: randomUUID(), event,
    }
    await atomicWriteJson(this.journalPath(sequence), record)
    await atomicWriteJson(this.paths.journalSequenceJson, { schemaVersion: '1.0', lastSequence: sequence })
    return record
  }

  async readJournal(): Promise<SequencedGraphJournalEvent[]> {
    return this.withTransaction(() => this.readJournalLocked())
  }

  /** Caller must hold withTransaction. */
  async readJournalLockedView(): Promise<SequencedGraphJournalEvent[]> {
    return this.readJournalLocked()
  }

  /** Caller must hold withTransaction. */
  async authoritativeSnapshotLocked(): Promise<GraphSnapshot> {
    return this.reconcileLocked()
  }

  /** Caller must hold withTransaction. */
  async writeCommitProjectionLocked(event: Extract<GraphJournalEvent, { type: 'activation_committed' }>, sequence: number): Promise<void> {
    await atomicWriteJson(this.paths.stateJson, event.state)
    await atomicWriteJson(this.paths.instanceJson, event.instance)
    await atomicWriteJson(this.activationPath(event.activation.id), event.activation)
    for (const activation of event.spawned) await atomicWriteJson(this.activationPath(activation.id), activation)
    for (const activation of event.cancelled ?? []) await atomicWriteJson(this.activationPath(activation.id), activation)
    for (const artifact of event.artifacts ?? []) {
      await atomicWriteJson(join(this.paths.artifactsDir, `${artifact.id}.json`), artifact)
      if (artifact.supersedes) {
        const previousPath = join(this.paths.artifactsDir, `${artifact.supersedes}.json`)
        const previous = await readJsonFile<GraphArtifactRecord>(previousPath)
        if (previous) await atomicWriteJson(previousPath, { ...previous, status: 'superseded', supersededBy: artifact.id })
      }
    }
    const intent = await readJsonFile<ActivationCommitIntent>(this.intentPath(event.commitKey))
    if (intent) await atomicWriteJson(this.intentPath(event.commitKey), { ...intent, status: 'committed', journalSequence: sequence })
  }

  /** Caller must hold withTransaction. */
  async writePausedResumeProjectionLocked(event: Extract<GraphJournalEvent, { type: 'paused_terminal_resumed' }>): Promise<void> {
    await atomicWriteJson(this.paths.stateJson, event.state)
    await atomicWriteJson(this.paths.instanceJson, event.instance)
    await atomicWriteJson(this.activationPath(event.activation.id), event.activation)
    for (const activation of event.spawned) await atomicWriteJson(this.activationPath(activation.id), activation)
  }

  /** Caller must hold withTransaction. */
  async writeActivationProjectionLocked(activation: ActivationRecord): Promise<void> {
    await atomicWriteJson(this.activationPath(activation.id), activation)
  }

  /** Caller must hold withTransaction. */
  async writeInstanceProjectionLocked(instance: GraphInstanceRecord): Promise<void> {
    await atomicWriteJson(this.paths.instanceJson, instance)
  }

  /** Caller must hold withTransaction. */
  async writeExternalEventProjectionLocked(event: GraphExternalEventRecord): Promise<void> {
    await atomicWriteJson(join(this.paths.eventsDir, `${event.id}.json`), event)
  }

  private async readJournalLocked(): Promise<SequencedGraphJournalEvent[]> {
    const lastSequence = await this.readLastSequenceLocked()
    return this.readJournalRangeLocked(1, lastSequence)
  }

  private async reconcileLocked(events?: SequencedGraphJournalEvent[]): Promise<GraphSnapshot> {
    const lastSequence = events?.at(-1)?.sequence ?? await this.readLastSequenceLocked()
    const checkpoint = events ? null : await readJsonFile<GraphCheckpoint>(this.paths.checkpointJson)
    const usableCheckpoint = checkpoint?.schemaVersion === 'graph-checkpoint-1.0' && checkpoint.lastSequence <= lastSequence
      ? checkpoint
      : null
    const journal = events ?? await this.readJournalRangeLocked((usableCheckpoint?.lastSequence ?? 0) + 1, lastSequence)
    if (!usableCheckpoint && journal.length === 0) throw new Error(`graph instance '${this.instanceId}' has no journal`)
    let instance: GraphInstanceRecord | undefined = usableCheckpoint?.instance
    let state: GraphStateSnapshot | undefined = usableCheckpoint?.state
    const activations = new Map<string, ActivationRecord>((usableCheckpoint?.activations ?? []).map(item => [item.id, item]))
    const commitKeys = new Map<string, number>(usableCheckpoint?.commitKeys ?? [])
    const artifacts = new Map<string, GraphArtifactRecord>((usableCheckpoint?.artifacts ?? []).map(item => [item.id, item]))
    const externalEvents = new Map<string, GraphExternalEventRecord>()
    for (const item of usableCheckpoint?.externalEvents ?? []) externalEvents.set(item.id, item)
    for (const record of journal) {
      const event = record.event
      switch (event.type) {
        case 'graph_created':
          instance = event.instance
          state = event.state
          activations.clear()
          for (const activation of event.activations) activations.set(activation.id, activation)
          break
        case 'activation_claimed':
        case 'activation_released':
        case 'activation_context_cached':
          activations.set(event.activation.id, event.activation)
          if (event.type === 'activation_released' && event.instance) instance = event.instance
          break
        case 'activation_committed':
          activations.set(event.activation.id, event.activation)
          for (const activation of event.spawned) activations.set(activation.id, activation)
          for (const activation of event.cancelled ?? []) activations.set(activation.id, activation)
          for (const artifact of event.artifacts ?? []) {
            artifacts.set(artifact.id, artifact)
            if (artifact.supersedes) {
              const previous = artifacts.get(artifact.supersedes)
              if (previous) artifacts.set(previous.id, { ...previous, status: 'superseded', supersededBy: artifact.id })
            }
          }
          state = event.state
          instance = event.instance
          commitKeys.set(event.commitKey, record.sequence)
          break
        case 'graph_status_changed':
          instance = event.instance
          break
        case 'paused_terminal_resumed':
          activations.set(event.activation.id, event.activation)
          for (const activation of event.spawned) activations.set(activation.id, activation)
          state = event.state
          instance = event.instance
          break
        case 'external_event_recorded':
          externalEvents.set(event.externalEvent.id, event.externalEvent)
          break
        case 'external_event_consumed':
          externalEvents.set(event.externalEvent.id, event.externalEvent)
          for (const activation of event.activations) activations.set(activation.id, activation)
          break
      }
    }
    if (!instance || !state) throw new Error(`graph journal for '${this.instanceId}' has no creation event`)
    // Heartbeats intentionally do not enter the append-only journal. Overlay a
    // newer projection only when it is the same fenced running claim.
    for (const [id, activation] of activations) {
      if (activation.status !== 'running' || !activation.lease) continue
      const projected = await readJsonFile<ActivationRecord>(this.activationPath(id))
      if (projected?.status === 'running' && projected.lease?.token === activation.lease.token && projected.updatedAt > activation.updatedAt) {
        activations.set(id, projected)
      }
    }
    const snapshot = { instance, state, activations, lastSequence, commitKeys, artifacts, externalEvents }
    for (const record of journal) await this.repairEventProjectionLocked(record)
    const [diskState, diskInstance] = await Promise.all([
      readJsonFile<GraphStateSnapshot>(this.paths.stateJson),
      readJsonFile<GraphInstanceRecord>(this.paths.instanceJson),
    ])
    if (JSON.stringify(diskState) !== JSON.stringify(state)) await atomicWriteJson(this.paths.stateJson, state)
    if (JSON.stringify(diskInstance) !== JSON.stringify(instance)) await atomicWriteJson(this.paths.instanceJson, instance)
    if (!usableCheckpoint || lastSequence - usableCheckpoint.lastSequence >= CHECKPOINT_INTERVAL) {
      await this.writeCheckpointLocked(snapshot)
    }
    for (const [commitKey, sequence] of commitKeys) {
      const intent = await readJsonFile<ActivationCommitIntent>(this.intentPath(commitKey))
      if (intent?.status === 'prepared') await atomicWriteJson(this.intentPath(commitKey), { ...intent, status: 'committed', journalSequence: sequence })
    }
    return snapshot
  }

  private async writeProjectionsLocked(snapshot: GraphSnapshot): Promise<void> {
    await atomicWriteJson(this.paths.instanceJson, snapshot.instance)
    await atomicWriteJson(this.paths.stateJson, snapshot.state)
    for (const activation of snapshot.activations.values()) await atomicWriteJson(this.activationPath(activation.id), activation)
    for (const artifact of snapshot.artifacts.values()) await atomicWriteJson(join(this.paths.artifactsDir, `${artifact.id}.json`), artifact)
    for (const event of snapshot.externalEvents.values()) await this.writeExternalEventProjectionLocked(event)
  }

  private activationPath(id: string): string { return join(this.paths.activationsDir, `${id}.json`) }
  private intentPath(commitKey: string): string { return join(this.paths.intentsDir, `${commitKey}.json`) }
  private effectIntentPath(operationKey: string): string { return join(this.paths.effectIntentsDir, `${operationKey}.json`) }
  private journalPath(sequence: number): string { return join(this.paths.journalDir, `${String(sequence).padStart(12, '0')}.json`) }

  private async readLastSequenceLocked(): Promise<number> {
    const counter = await readJsonFile<{ lastSequence?: number }>(this.paths.journalSequenceJson)
    if (Number.isInteger(counter?.lastSequence) && counter!.lastSequence! >= 0) {
      let lastSequence = counter!.lastSequence!
      while (await readJsonFile<SequencedGraphJournalEvent>(this.journalPath(lastSequence + 1))) lastSequence++
      if (lastSequence !== counter!.lastSequence) {
        await atomicWriteJson(this.paths.journalSequenceJson, { schemaVersion: '1.0', lastSequence })
      }
      return lastSequence
    }
    const ids = (await listJsonIds(this.paths.journalDir)).filter(id => /^\d{12}$/.test(id)).sort()
    const lastSequence = ids.length ? Number(ids.at(-1)) : 0
    await atomicWriteJson(this.paths.journalSequenceJson, { schemaVersion: '1.0', lastSequence })
    return lastSequence
  }

  private async readJournalRangeLocked(from: number, to: number): Promise<SequencedGraphJournalEvent[]> {
    if (from > to) return []
    const events: SequencedGraphJournalEvent[] = []
    for (let sequence = from; sequence <= to; sequence++) {
      const event = await readJsonFile<SequencedGraphJournalEvent>(this.journalPath(sequence))
      if (!event || event.sequence !== sequence) throw new Error(`graph journal sequence gap at ${sequence}`)
      events.push(event)
    }
    return events
  }

  private async repairEventProjectionLocked(record: SequencedGraphJournalEvent): Promise<void> {
    const event = record.event
    switch (event.type) {
      case 'graph_created':
        await atomicWriteJson(this.paths.stateJson, event.state)
        await atomicWriteJson(this.paths.instanceJson, event.instance)
        for (const activation of event.activations) await atomicWriteJson(this.activationPath(activation.id), activation)
        return
      case 'activation_claimed':
        // Do not shorten a lease already extended by a projection-only heartbeat.
        {
          const current = await readJsonFile<ActivationRecord>(this.activationPath(event.activation.id))
          if (current?.status === 'running' && current.lease?.token === event.activation.lease?.token && current.updatedAt > event.activation.updatedAt) return
          await atomicWriteJson(this.activationPath(event.activation.id), event.activation)
        }
        return
      case 'activation_released':
        await atomicWriteJson(this.activationPath(event.activation.id), event.activation)
        if (event.instance) await atomicWriteJson(this.paths.instanceJson, event.instance)
        return
      case 'activation_context_cached':
        await atomicWriteJson(this.activationPath(event.activation.id), event.activation)
        return
      case 'activation_committed':
        await this.writeCommitProjectionLocked(event, record.sequence)
        return
      case 'graph_status_changed':
        await atomicWriteJson(this.paths.instanceJson, event.instance)
        return
      case 'paused_terminal_resumed':
        await this.writePausedResumeProjectionLocked(event)
        return
      case 'external_event_recorded':
        await this.writeExternalEventProjectionLocked(event.externalEvent)
        return
      case 'external_event_consumed':
        await this.writeExternalEventProjectionLocked(event.externalEvent)
        for (const activation of event.activations) await atomicWriteJson(this.activationPath(activation.id), activation)
        return
    }
  }

  private async writeCheckpointLocked(snapshot: GraphSnapshot): Promise<void> {
    const checkpoint: GraphCheckpoint = {
      schemaVersion: 'graph-checkpoint-1.0',
      lastSequence: snapshot.lastSequence,
      instance: snapshot.instance,
      state: snapshot.state,
      activations: [...snapshot.activations.values()],
      commitKeys: [...snapshot.commitKeys.entries()],
      artifacts: [...snapshot.artifacts.values()],
      externalEvents: [...snapshot.externalEvents.values()],
    }
    await atomicWriteJson(this.paths.checkpointJson, checkpoint)
  }
}

const CHECKPOINT_INTERVAL = 50

interface GraphCheckpoint {
  schemaVersion: 'graph-checkpoint-1.0'
  lastSequence: number
  instance: GraphInstanceRecord
  state: GraphStateSnapshot
  activations: ActivationRecord[]
  commitKeys: Array<[string, number]>
  artifacts: GraphArtifactRecord[]
  externalEvents: GraphExternalEventRecord[]
}

function activationId(): string {
  return `act-${randomUUID()}`
}

function compareActivation(a: ActivationRecord, b: ActivationRecord): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}

export function newActivation(input: {
  nodeId: string
  values: Record<string, JsonValue>
  stateVersion: number
  now: number
  parentActivationId: string
  sourceTransitionId: string
  forkGroupId?: string
}): ActivationRecord {
  return {
    schemaVersion: 'graph-activation-1.0',
    id: activationId(),
    nodeId: input.nodeId,
    status: 'ready',
    attempt: 0,
    segmentCount: 0,
    parkCount: 0,
    usage: emptyUsage(),
    readyReason: 'initial',
    createdAt: input.now,
    updatedAt: input.now,
    input: input.values,
    inputStateVersion: input.stateVersion,
    continuationVersion: 0,
    parentActivationId: input.parentActivationId,
    sourceTransitionId: input.sourceTransitionId,
    forkGroupId: input.forkGroupId,
  }
}

function emptyUsage(): ActivationUsage {
  return { turns: 0, costUsd: 0, durationMs: 0 }
}

export async function listGraphInstanceRecords(projectDir: string): Promise<GraphInstanceRecord[]> {
  const root = join(resolve(projectDir), '.loop')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const records: GraphInstanceRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const record = await readJsonFile<GraphInstanceRecord>(join(root, entry.name, 'instance.json'))
    if (record?.engine === 'durable-graph-v1') records.push(record)
  }
  return records.sort((a, b) => a.instanceId.localeCompare(b.instanceId))
}
