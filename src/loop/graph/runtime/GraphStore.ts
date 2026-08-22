import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  atomicWriteJson,
  deleteJsonFile,
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
  SequencedGraphJournalEvent,
  ActivationUsage,
  GraphExternalEventRecord,
  GraphEffectIntent,
} from '../spec/GraphTypes.js'
import { verifyFrozenGraphIntegrity } from '../spec/GraphValidate.js'
import { evaluateBindings } from './GraphExpression.js'
import { emptyUsage } from './UsageMath.js'
import { recordTrajectoryItem, trajectoryEnabled } from '../../../trajectory/hub.js'
import { sha256 } from '../../../trajectory/privacy.js'

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
  eventsDir: string
  journalSequenceJson: string
  checkpointJson: string
  checkpointPrevJson: string
  transactionLock: string
}

export interface GraphSnapshot {
  instance: GraphInstanceRecord
  state: GraphStateSnapshot
  activations: Map<string, ActivationRecord>
  lastSequence: number
  commitKeys: Map<string, number>
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
    eventsDir: join(graphDir, 'events'),
    journalSequenceJson: join(graphDir, 'journal-sequence.json'),
    checkpointJson: join(graphDir, 'checkpoint.json'),
    checkpointPrevJson: join(graphDir, 'checkpoint.prev.json'),
    transactionLock: join(graphDir, '.transaction'),
  }
}

export interface CreateGraphInstanceInput {
  projectDir: string
  instanceId?: string
  graph: FrozenLoopGraphSpec
  functions: CapabilityRegistry<FunctionProvider>
  now?: number
  mustCreate?: boolean
  recoverySeed?: {
    state: GraphStateSnapshot
    activation: Pick<ActivationRecord, 'nodeId' | 'input'>
    sourceInstanceId: string
    sourceActivationId: string
    reason?: string
  }
}

export interface CreateGraphRecoveryForkInput {
  projectDir: string
  sourceInstanceId: string
  targetInstanceId: string
  functions: CapabilityRegistry<FunctionProvider>
  activationId?: string
  reason?: string
  allowUnsafe?: boolean
  now?: number
}

export class GraphStore {
  readonly paths: GraphPaths
  /** Audit projection is deliberately outside the graph commit protocol. */
  private trajectoryProjection: Promise<void> = Promise.resolve()
  private trajectoryPersistenceDegraded = false
  private trajectoryWarningEmitted = false
  private lastJournalSequence = 0
  private lastProjectedSequence = 0
  private auditLagExceeded = false
  private auditLagWarningEmitted = false
  /**
   * Highest journal sequence whose projections this process has already
   * repaired. Repair is idempotent, so doing it once per event per process
   * keeps crash recovery while removing the O(journal-since-checkpoint)
   * write amplification from every snapshot.
   */
  private repairedThrough = 0
  /**
   * Highest journal sequence known to be deleted. Seeded from the checkpoint's
   * durable `prunedThrough` (or the journal directory) on first use — see
   * GraphCheckpoint.prunedThrough for why an in-memory-only cursor silently
   * disabled pruning.  `undefined` = not yet resolved.
   */
  private journalPrunedThrough: number | undefined
  /** Next time settled commit-intent files are swept (throttle). */
  private nextIntentPruneAt = 0
  /** Cursor into intentsDir so successive sweeps do not re-read the same prefix. */
  private intentSweepCursor = 0
  /**
   * The frozen spec is immutable for the life of an instance (graphHash is its
   * identity), so re-reading it on every checkpoint was pure overhead.
   */
  private specCache: FrozenLoopGraphSpec | null | undefined
  /**
   * Transaction locks held by the CURRENT async context (B6).
   *
   * withFileLock is not reentrant: a transaction whose `fn` opens another
   * transaction on the same store blocks on a lock this very call stack holds,
   * waits out the full 60s timeout, and then reports a timeout that reads like
   * contention from another process. The `*Locked` method-name convention is
   * the only thing preventing that, and conventions are not checked.
   *
   * A plain depth counter cannot express this: GraphKernel.tick runs claimed
   * activations through `Promise.allSettled`, so several transactions on the
   * same store are legitimately in flight at once. Those are PARALLEL, not
   * nested — they queue on the lock file and each makes progress. Only a call
   * inside another's dynamic extent is a deadlock, and async context is exactly
   * what distinguishes the two: siblings branch from a context that does not
   * hold the lock, a nested call inherits one that does.
   */
  private static readonly txScope = new AsyncLocalStorage<ReadonlySet<string>>()

  constructor(readonly projectDir: string, readonly instanceId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(instanceId)) {
      throw new Error(`invalid graph instance id '${instanceId}'`)
    }
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
        if (input.mustCreate) throw new Error(`instance '${instanceId}' already exists`)
        if (existing.engine !== 'durable-graph-v2') throw new Error(`instance '${instanceId}' belongs to a different loop engine`)
        if (existing.graphHash !== input.graph.graphHash) throw new Error(`instance '${instanceId}' already exists with a different graph`)
        return false
      }
      if (await store.hasDurableHistoryLocked()) {
        if (input.mustCreate) throw new Error(`instance '${instanceId}' already has durable history`)
        await store.reconcileLocked()
        return false
      }
      return true
    })
    if (!initialize) return store

    // Capability Functions are trusted and declared pure, but they are still
    // plugin code. Materialize entrypoint inputs outside the Graph transaction.
    const workspace = await ensureWorkspaceIdentity(input.projectDir)
    const now = input.now ?? Date.now()
    const state: GraphStateSnapshot = input.recoverySeed
      ? {
          ...input.recoverySeed.state,
          values: structuredClone(input.recoverySeed.state.values),
          updatedAt: now,
        }
      : {
          schemaVersion: 'graph-state-1.0',
          version: 0,
          values: Object.fromEntries(
            Object.entries(input.graph.state).map(([name, variable]) => [name, variable.initial]),
          ),
          updatedAt: now,
        }
    const materializedEntries = input.recoverySeed
      ? [{
          entry: { id: 'recovery', node: input.recoverySeed.activation.nodeId },
          values: structuredClone(input.recoverySeed.activation.input),
        }]
      : await Promise.all(input.graph.entrypoints.map(async entry => ({
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
          inputStateVersion: state.version,
          continuationVersion: 0,
    }))
    const instance: GraphInstanceRecord = {
        schemaVersion: 'graph-instance-1.0',
        engine: 'durable-graph-v2',
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
        ...(input.recoverySeed ? {
          recovery: {
            sourceInstanceId: input.recoverySeed.sourceInstanceId,
            sourceActivationId: input.recoverySeed.sourceActivationId,
            recoveredAt: now,
            ...(input.recoverySeed.reason ? { reason: input.recoverySeed.reason } : {}),
          },
        } : {}),
    }
    await store.withTransaction(async () => {
      const existing = await readJsonFile<GraphInstanceRecord>(store.paths.instanceJson)
      if (existing) {
        if (input.mustCreate) throw new Error(`instance '${instanceId}' already exists`)
        if (existing.engine !== 'durable-graph-v2') throw new Error(`instance '${instanceId}' belongs to a different loop engine`)
        if (existing.graphHash !== input.graph.graphHash) throw new Error(`instance '${instanceId}' already exists with a different graph`)
        return
      }
      if (await store.hasDurableHistoryLocked()) {
        if (input.mustCreate) throw new Error(`instance '${instanceId}' already has durable history`)
        await store.reconcileLocked()
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
        externalEvents: new Map(),
      })
    })
    return store
  }

  static async createRecoveryFork(input: CreateGraphRecoveryForkInput): Promise<GraphStore> {
    if (input.sourceInstanceId === input.targetInstanceId) {
      throw new Error('recovery fork must use a new instance id')
    }
    const source = new GraphStore(input.projectDir, input.sourceInstanceId)
    const [snapshot, graph] = await Promise.all([source.snapshot(), source.loadSpec()])
    if (!['failed', 'exhausted', 'done'].includes(snapshot.instance.status)) {
      throw new Error(`loop recover requires a terminal source; '${input.sourceInstanceId}' is ${snapshot.instance.status}`)
    }
    if (snapshot.instance.status === 'done' && !input.allowUnsafe) {
      throw new Error('recovering a done instance requires --force')
    }
    const candidates = [...snapshot.activations.values()]
      .filter(activation => {
        const node = graph.nodes[activation.nodeId]
        return node?.type !== 'terminal' &&
          (activation.status === 'failed' || activation.outcome === 'failure' || activation.outcome === 'exhausted')
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
    const activation = input.activationId
      ? snapshot.activations.get(input.activationId)
      : candidates[0]
    if (!activation) throw new Error(`no recoverable activation found in '${input.sourceInstanceId}'`)
    const node = graph.nodes[activation.nodeId]
    if (!node || node.type === 'terminal') throw new Error(`activation '${activation.id}' is not a recoverable work node`)
    if (!input.allowUnsafe && node.type === 'effect') {
      throw new Error(`recovering Effect activation '${activation.id}' may duplicate side effects; re-run with --force after verifying idempotency`)
    }
    if (!input.allowUnsafe && !candidates.some(candidate => candidate.id === activation.id)) {
      throw new Error(`activation '${activation.id}' did not fail or exhaust; re-run with --force to recover it`)
    }
    return GraphStore.create({
      projectDir: input.projectDir,
      instanceId: input.targetInstanceId,
      graph,
      functions: input.functions,
      now: input.now,
      mustCreate: true,
      recoverySeed: {
        state: snapshot.state,
        activation: { nodeId: activation.nodeId, input: activation.input },
        sourceInstanceId: input.sourceInstanceId,
        sourceActivationId: activation.id,
        reason: input.reason,
      },
    })
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
      this.paths.eventsDir,
    ].map(dir => mkdir(dir, { recursive: true })))
  }

  async loadSpec(): Promise<FrozenLoopGraphSpec> {
    const spec = await readJsonFile<FrozenLoopGraphSpec>(this.paths.specJson)
    if (!spec || spec.schemaVersion !== 'graph-2.0' || !spec.graphHash) throw new Error(`graph spec is missing for '${this.instanceId}'`)
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
      const terminal = ready
        .filter(activation => spec.nodes[activation.nodeId]?.type === 'terminal')
        .sort((a, b) => compareTerminalActivation(a, b, spec))[0]
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
          blockedFailure: undefined,
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
      if (snapshot.instance.status !== 'active') return false
      const activation = snapshot.activations.get(activationIdValue)
      if (activation?.status !== 'running' || activation.lease?.token !== leaseToken) return false
      const next = { ...activation, updatedAt: now, lease: { ...activation.lease, expiresAt: now + ttlMs } }
      // Lease renewal is ephemeral scheduler state. The original claim is in
      // the journal; repeated heartbeats only update its fenced projection.
      await atomicWriteJson(this.activationPath(next.id), next)
      return true
    })
  }

  async prepareCommit(input: {
    activationId: string
    leaseToken: string
    expectedStateVersion?: number
    outcome: string
    output: JsonValue
    summary?: string
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
      if (existing && existing.status !== 'discarded') return existing
      const intent: ActivationCommitIntent = {
        schemaVersion: 'graph-commit-intent-1.0',
        commitKey,
        activationId: activation.id,
        continuationVersion: activation.continuationVersion,
        leaseToken: input.leaseToken,
        expectedStateVersion: input.expectedStateVersion,
        outcome: input.outcome,
        output: input.output,
        summary: input.summary,
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
    const intents = await Promise.all(ids.map(id => readJsonFile<ActivationCommitIntent>(join(this.paths.intentsDir, `${id}.json`), { tolerateUnreadable: true })))
    return intents
      .filter((intent): intent is ActivationCommitIntent => intent?.status === 'prepared')
      .sort((a, b) => a.createdAt - b.createdAt || a.commitKey.localeCompare(b.commitKey))
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
        // Providers may return receipts with nondeterministic fields (timestamps,
        // request ids) on idempotent resubmission. The first durable receipt is
        // authoritative; throwing here would poison every retry of the segment.
        return intent
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
      if (isFinalStatus(snapshot.instance.status)) return snapshot.instance
      if (snapshot.instance.status === status && snapshot.instance.statusReason === reason) return snapshot.instance
      if (status === 'paused' || isFinalStatus(status)) {
        for (const activation of snapshot.activations.values()) {
          let next: ActivationRecord | undefined
          if (status === 'paused' && activation.status === 'running') {
            next = {
              ...activation,
              status: 'ready',
              lease: undefined,
              readyReason: 'replay',
              error: reason ?? 'graph paused',
              updatedAt: now,
            }
          } else if (status !== 'paused' && ['ready', 'running', 'waiting'].includes(activation.status)) {
            next = {
              ...activation,
              status: 'cancelled',
              lease: undefined,
              error: reason ?? `graph ${status}`,
              updatedAt: now,
            }
          }
          if (!next) continue
          await this.appendEventLocked({ type: 'activation_released', at: now, activation: next, reason: `graph_${status}` })
          await atomicWriteJson(this.activationPath(next.id), next)
        }
      }
      const instance: GraphInstanceRecord = {
        ...snapshot.instance,
        status,
        statusReason: reason,
        ...(status === 'active' ? { blockedFailure: undefined } : {}),
        updatedAt: now,
      }
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
      if (!isFinalStatus(snapshot.instance.status)) {
        const instance: GraphInstanceRecord = { ...snapshot.instance, status: 'failed', statusReason: error, updatedAt: now }
        await this.appendEventLocked({ type: 'graph_status_changed', at: now, instance })
        await atomicWriteJson(this.paths.instanceJson, instance)
      }
    })
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    // B6: reentrancy is a deadlock, not contention. Surface it as such.
    const key = this.paths.transactionLock
    const held = GraphStore.txScope.getStore()
    if (held?.has(key)) {
      throw new Error(
        `GraphStore.withTransaction is not reentrant (instance '${this.instanceId}'). ` +
        'This call is inside a transaction already held for the same instance and would ' +
        'deadlock on its own lock; use the *Locked variant instead of opening a nested ' +
        'transaction.',
      )
    }
    await this.ensureLayout()
    const nested = new Set(held ?? [])
    nested.add(key)
    return GraphStore.txScope.run(nested, () =>
      withFileLock(key, fn, { staleMs: 15 * 60_000, timeoutMs: 60_000 }))
  }

  /** Caller must hold withTransaction. Journal is written before projections. */
  async appendEventLocked(event: GraphJournalEvent): Promise<SequencedGraphJournalEvent> {
    let sequence = await this.readLastSequenceLocked() + 1
    while (await journalEntryExists(this.journalPath(sequence))) sequence++
    const record: SequencedGraphJournalEvent = {
      schemaVersion: 'graph-journal-1.0', sequence, eventId: randomUUID(), event,
    }
    await atomicWriteJson(this.journalPath(sequence), record)
    await atomicWriteJson(this.paths.journalSequenceJson, { schemaVersion: '1.0', lastSequence: sequence })
    // The graph journal above is authoritative. Serialize its trajectory
    // projection in the background so an audit/index failure cannot roll back,
    // delay, or otherwise alter graph execution.
    this.lastJournalSequence = Math.max(this.lastJournalSequence, sequence)
    this.trajectoryProjection = this.trajectoryProjection
      .then(() => this.recordTrajectoryProjection(record))
      .then(() => {
        this.lastProjectedSequence = Math.max(this.lastProjectedSequence, record.sequence)
      })
      .catch(error => {
        this.trajectoryPersistenceDegraded = true
        if (!this.trajectoryWarningEmitted) {
          this.trajectoryWarningEmitted = true
          console.warn(
            `[GraphStore:${this.instanceId}] trajectory projection degraded:`,
            error instanceof Error ? error.message : String(error),
          )
        }
      })
    this.observeAuditLag()
    return record
  }

  /** Graph correctness never depends on this flag; hosts may surface it. */
  isTrajectoryPersistenceDegraded(): boolean {
    return this.trajectoryPersistenceDegraded
  }

  /**
   * Journal events written but not yet projected into the audit trajectory.
   *
   * Each projection does a full canonical barrier (`fsync`) plus a metadata
   * write, which is what makes `flushTrajectoryProjection()` a real durability
   * guarantee — and also what makes the audit side the slower of the two. The
   * lag is therefore expected to be non-zero under load; it is only a problem
   * when it grows without bound, because shutdown has to drain all of it.
   * Execution never waits on this number.
   */
  trajectoryAuditLag(): number {
    return Math.max(0, this.lastJournalSequence - this.lastProjectedSequence)
  }

  /** True once the audit backlog has passed its soft cap at least once. */
  isTrajectoryAuditLagExceeded(): boolean {
    return this.auditLagExceeded
  }

  private observeAuditLag(): void {
    if (this.trajectoryAuditLag() <= MAX_TRAJECTORY_AUDIT_LAG) return
    this.auditLagExceeded = true
    if (this.auditLagWarningEmitted) return
    this.auditLagWarningEmitted = true
    console.warn(
      `[GraphStore:${this.instanceId}] trajectory audit lag ${this.trajectoryAuditLag()} ` +
      `exceeds ${MAX_TRAJECTORY_AUDIT_LAG} journal events; shutdown will have to drain the backlog. ` +
      'Graph execution is unaffected.',
    )
  }

  /** Test/shutdown hook for callers that need the audit projection durable. */
  async flushTrajectoryProjection(): Promise<void> {
    await this.trajectoryProjection
  }

  private async recordTrajectoryProjection(record: SequencedGraphJournalEvent): Promise<void> {
    if (!trajectoryEnabled()) return
    const event = record.event
    const instance = 'instance' in event
      ? event.instance
      : await readJsonFile<GraphInstanceRecord>(this.paths.instanceJson)
    if (!instance) throw new Error('graph instance projection is unavailable')
    const activation = 'activation' in event ? event.activation : undefined
    const details: Record<string, JsonValue> = { eventId: record.eventId }
    if ('reason' in event) details['reason'] = event.reason
    if ('transitionId' in event && event.transitionId) details['transitionId'] = event.transitionId
    if (event.type === 'graph_status_changed') details['status'] = event.instance.status
    const descriptor = {
      subject: {
        kind: 'graph_instance' as const,
        workspaceId: instance.workspaceId,
        instanceId: this.instanceId,
      },
      mode: 'loop_graph',
      workspace: this.projectDir,
      workspaceId: instance.workspaceId,
      source: 'graph_journal_projection',
    }
    const trajectoryId = await recordTrajectoryItem(descriptor, {
      type: 'phase',
      domain: 'loop_graph',
      action: event.type,
      nodeId: activation?.nodeId,
      activationId: activation?.id,
      journalSequence: record.sequence,
      details,
    }, {}, { durability: 'projected' })
    if (!trajectoryId) throw new Error('graph phase projection was not recorded')

    if ('state' in event) {
      const statePayload = JSON.stringify({ state: event.state, instance })
      const checkpointId = await recordTrajectoryItem(descriptor, {
        type: 'state_checkpoint',
        mode: 'loop_graph',
        stateSchemaVersion: event.state.schemaVersion,
        revision: event.state.version,
        contentHash: sha256(statePayload),
        storeRef: `${this.journalPath(record.sequence)}#state`,
      }, {}, { durability: 'projected' })
      if (!checkpointId) throw new Error('graph checkpoint projection was not recorded')
    }
  }

  async readJournal(): Promise<SequencedGraphJournalEvent[]> {
    return this.withTransaction(() => this.readJournalLocked())
  }

  /** Caller must hold withTransaction. */
  async readJournalLockedView(): Promise<SequencedGraphJournalEvent[]> {
    return this.readJournalLocked()
  }

  /** Caller must hold withTransaction. Reads a single journal event by sequence. */
  async readJournalEventLocked(sequence: number): Promise<SequencedGraphJournalEvent | null> {
    return readJsonFile<SequencedGraphJournalEvent>(this.journalPath(sequence))
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
    const intent = await readJsonFile<ActivationCommitIntent>(this.intentPath(event.commitKey))
    if (intent) await atomicWriteJson(this.intentPath(event.commitKey), { ...intent, status: 'committed', journalSequence: sequence })
  }

  /** Caller must hold withTransaction. A discarded intent may be recreated by its replay. */
  async discardCommitIntentLocked(intent: ActivationCommitIntent, reason: string): Promise<void> {
    await atomicWriteJson(this.intentPath(intent.commitKey), {
      ...intent,
      status: 'discarded',
      discardReason: reason,
    } satisfies ActivationCommitIntent)
  }

  /** Caller must hold withTransaction. */
  async writePausedResumeProjectionLocked(event: Extract<GraphJournalEvent, { type: 'paused_terminal_resumed' }>): Promise<void> {
    await atomicWriteJson(this.paths.stateJson, event.state)
    await atomicWriteJson(this.paths.instanceJson, event.instance)
    await atomicWriteJson(this.activationPath(event.activation.id), event.activation)
    for (const activation of event.spawned) await atomicWriteJson(this.activationPath(activation.id), activation)
  }

  /** Caller must hold withTransaction. */
  async writeBlockedProjectionLocked(event: Extract<GraphJournalEvent, { type: 'activation_blocked' }>): Promise<void> {
    await atomicWriteJson(this.paths.instanceJson, event.instance)
    await atomicWriteJson(this.activationPath(event.activation.id), event.activation)
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
    // Prefer the current checkpoint; fall back to the previous generation if
    // the current one is missing/corrupt (readJsonFile quarantines corrupt
    // files as .corrupt). Journal pruning keeps every sequence AFTER the
    // previous generation, so the fallback always has a contiguous tail.
    const usable = (candidate: GraphCheckpoint | null): GraphCheckpoint | null =>
      candidate?.schemaVersion === 'graph-checkpoint-2.0' && candidate.lastSequence <= lastSequence ? candidate : null
    const usableCheckpoint = events
      ? null
      : usable(await readJsonFile<GraphCheckpoint>(this.paths.checkpointJson))
        ?? usable(await readJsonFile<GraphCheckpoint>(this.paths.checkpointPrevJson))
    const journal = events ?? await this.readJournalRangeLocked((usableCheckpoint?.lastSequence ?? 0) + 1, lastSequence)
    if (!usableCheckpoint && journal.length === 0) throw new Error(`graph instance '${this.instanceId}' has no journal`)
    let instance: GraphInstanceRecord | undefined = usableCheckpoint?.instance
    let state: GraphStateSnapshot | undefined = usableCheckpoint?.state
    const activations = new Map<string, ActivationRecord>((usableCheckpoint?.activations ?? []).map(item => [item.id, item]))
    const commitKeys = new Map<string, number>(usableCheckpoint?.commitKeys ?? [])
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
          activations.set(event.activation.id, event.activation)
          if (event.type === 'activation_released' && event.instance) instance = event.instance
          break
        case 'activation_blocked':
          activations.set(event.activation.id, event.activation)
          instance = event.instance
          break
        case 'activation_committed':
          activations.set(event.activation.id, event.activation)
          for (const activation of event.spawned) activations.set(activation.id, activation)
          for (const activation of event.cancelled ?? []) activations.set(activation.id, activation)
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
          for (const activation of event.cancelled ?? []) activations.set(activation.id, activation)
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
    const snapshot = { instance, state, activations, lastSequence, commitKeys, externalEvents }
    const repairFrom = this.repairedThrough
    let repaired = 0
    for (const record of journal) {
      if (record.sequence <= repairFrom) continue
      await this.repairEventProjectionLocked(record)
      repaired++
    }
    // B5: the projection reconcile only has work to do when this call actually
    // replayed something. `snapshot()` is called several times per tick
    // (GraphKernel.tick alone calls it 4+ times) and most of those calls replay
    // zero events — yet each one used to serialise the entire State snapshot
    // twice to discover there was nothing to write.
    //
    // The comparison is also key-order sensitive: it is a string compare of
    // JSON.stringify output, so a future refactor that rebuilds these objects
    // with `{...a, ...b}` would silently make it always-unequal and turn every
    // snapshot into two full writes, with no test failing. Gating on `repaired`
    // bounds that blast radius to calls that replayed events.
    if (repaired > 0) {
      const [diskState, diskInstance] = await Promise.all([
        readJsonFile<GraphStateSnapshot>(this.paths.stateJson),
        readJsonFile<GraphInstanceRecord>(this.paths.instanceJson),
      ])
      if (JSON.stringify(diskState) !== JSON.stringify(state)) await atomicWriteJson(this.paths.stateJson, state)
      if (JSON.stringify(diskInstance) !== JSON.stringify(instance)) await atomicWriteJson(this.paths.instanceJson, instance)
    }
    if (!usableCheckpoint || lastSequence - usableCheckpoint.lastSequence >= CHECKPOINT_INTERVAL) {
      await this.writeCheckpointLocked(snapshot)
    }
    for (const [commitKey, sequence] of commitKeys) {
      if (sequence <= repairFrom) continue
      const intent = await readJsonFile<ActivationCommitIntent>(this.intentPath(commitKey))
      if (intent?.status === 'prepared') await atomicWriteJson(this.intentPath(commitKey), { ...intent, status: 'committed', journalSequence: sequence })
    }
    this.repairedThrough = Math.max(this.repairedThrough, lastSequence)
    return snapshot
  }

  private async writeProjectionsLocked(snapshot: GraphSnapshot): Promise<void> {
    await atomicWriteJson(this.paths.instanceJson, snapshot.instance)
    await atomicWriteJson(this.paths.stateJson, snapshot.state)
    for (const activation of snapshot.activations.values()) await atomicWriteJson(this.activationPath(activation.id), activation)
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
      while (await journalEntryExists(this.journalPath(lastSequence + 1))) lastSequence++
      if (lastSequence !== counter!.lastSequence) {
        await atomicWriteJson(this.paths.journalSequenceJson, { schemaVersion: '1.0', lastSequence })
      }
      return lastSequence
    }
    const ids = (await listJsonIds(this.paths.journalDir)).filter(id => /^\d{12}$/.test(id)).sort()
    // The journal prefix may have been pruned behind a checkpoint, so a bare
    // directory scan can undercount after losing the counter file. Take the
    // max of the directory tail and both checkpoint generations.
    const checkpoint = await readJsonFile<GraphCheckpoint>(this.paths.checkpointJson)
      ?? await readJsonFile<GraphCheckpoint>(this.paths.checkpointPrevJson)
    const lastSequence = Math.max(
      ids.length ? Number(ids.at(-1)) : 0,
      checkpoint?.schemaVersion === 'graph-checkpoint-2.0' ? checkpoint.lastSequence : 0,
    )
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
      case 'activation_blocked':
        await this.writeBlockedProjectionLocked(event)
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
    const now = Date.now()
    // Compaction: without it, the checkpoint (and therefore the in-memory
    // snapshot rebuilt on EVERY snapshot() call) grows linearly with the total
    // number of Activations ever created — unbounded for a long-lived loop.
    // Retention is deliberately conservative; see retainActivationInCheckpoint.
    const spec = await this.readSpecCachedLocked()
    const activations = [...snapshot.activations.values()]
      .filter(activation => retainActivationInCheckpoint(activation, spec, now))
    const externalEvents = [...snapshot.externalEvents.values()]
      .filter(event => event.status === 'pending' ||
        now - (event.consumedAt ?? event.createdAt) < EXTERNAL_EVENT_RETENTION_MS)
    // Two-generation rotation: keep the outgoing checkpoint as .prev so a
    // corrupt current checkpoint still recovers without the full journal.
    const previous = await readJsonFile<GraphCheckpoint>(this.paths.checkpointJson)
    // Journal sequences at or below BOTH generations' lastSequence are covered
    // twice over and can be deleted. commitKey entries pointing into that
    // pruned prefix are dropped with them: their duplicate-commit lookup would
    // dereference a deleted journal file anyway, and a same-commitKey replay
    // that old is impossible while the Activation itself is compacted.
    const pruneThrough = Math.min(previous?.lastSequence ?? 0, snapshot.lastSequence)
    // B2: resolve the durable prune cursor BEFORE writing the checkpoint, so
    // the value we persist reflects the work this call is about to do.
    const prunedBefore = await this.resolvePrunedThroughLocked(previous)
    // Bounded batch per checkpoint keeps the transaction short; the backlog
    // drains across successive checkpoints.
    let prunedNow = prunedBefore
    if (pruneThrough > prunedBefore) {
      let deleted = 0
      for (let sequence = prunedBefore + 1; sequence <= pruneThrough && deleted < HOUSEKEEPING_BATCH; sequence++) {
        await deleteJsonFile(this.journalPath(sequence)).catch(() => undefined)
        prunedNow = sequence
        deleted++
      }
    }
    this.journalPrunedThrough = prunedNow

    const checkpoint: GraphCheckpoint = {
      schemaVersion: 'graph-checkpoint-2.0',
      lastSequence: snapshot.lastSequence,
      instance: snapshot.instance,
      state: snapshot.state,
      activations,
      commitKeys: [...snapshot.commitKeys.entries()].filter(([, sequence]) => sequence > pruneThrough),
      externalEvents,
      prunedThrough: prunedNow,
    }
    if (previous && previous.lastSequence < checkpoint.lastSequence) {
      await atomicWriteJson(this.paths.checkpointPrevJson, previous)
    }
    await atomicWriteJson(this.paths.checkpointJson, checkpoint)
    await this.pruneSettledIntentsLocked(now)
  }

  /**
   * The frozen spec never changes for an instance, so read it once. Cached as
   * `null` too — a missing spec.json is a legitimate state for instances
   * created before the spec projection existed, and re-reading it every
   * checkpoint to rediscover that costs an open() per checkpoint forever.
   */
  private async readSpecCachedLocked(): Promise<FrozenLoopGraphSpec | null> {
    if (this.specCache === undefined) {
      this.specCache = await readJsonFile<FrozenLoopGraphSpec>(this.paths.specJson)
    }
    return this.specCache
  }

  /**
   * Durable journal-prune cursor. Preference order:
   *   1. this process's memo (already resolved);
   *   2. the checkpoint's persisted `prunedThrough`;
   *   3. derivation from the journal directory — the lowest surviving sequence
   *      minus one — for checkpoints written before the field existed.
   *
   * (3) is exact rather than conservative: journal files are deleted strictly
   * in ascending order, so everything below the smallest surviving file is
   * gone. Falling back to 0 instead would reintroduce the very stall this
   * cursor exists to remove.
   */
  private async resolvePrunedThroughLocked(previous: GraphCheckpoint | null): Promise<number> {
    if (this.journalPrunedThrough !== undefined) return this.journalPrunedThrough
    if (typeof previous?.prunedThrough === 'number' && previous.prunedThrough >= 0) {
      this.journalPrunedThrough = previous.prunedThrough
      return this.journalPrunedThrough
    }
    const ids = (await listJsonIds(this.paths.journalDir)).filter(id => /^\d{12}$/.test(id)).sort()
    // No journal files at all: everything up to the checkpoint has been pruned.
    const derived = ids.length ? Number(ids[0]) - 1 : (previous?.lastSequence ?? 0)
    this.journalPrunedThrough = Math.max(0, derived)
    return this.journalPrunedThrough
  }

  /**
   * Remove committed/discarded commit-intent files older than the retention
   * window. recoverPrepared() lists EVERY intent file on every tick, so
   * settled intents left forever degrade each tick linearly. Replay dedup is
   * unaffected: commit() dedups via the journal-backed commitKeys index, not
   * via these files.
   */
  private async pruneSettledIntentsLocked(now: number): Promise<void> {
    if (now < this.nextIntentPruneAt) return
    this.nextIntentPruneAt = now + HOUSEKEEPING_INTERVAL_MS
    const ids = (await listJsonIds(this.paths.intentsDir)).sort()
    if (ids.length === 0) return

    // B3: budget INSPECTIONS, not deletions.
    //
    // The old loop broke on `deleted >= HOUSEKEEPING_BATCH`, but nothing is
    // deletable until INTENT_RETENTION_MS (7 days) has elapsed — so for the
    // first week of an instance's life `deleted` stayed 0, the break never
    // fired, and every sweep read EVERY intent file in the directory. Inside
    // the global transaction lock, no less: the exact linear degradation this
    // function was added to remove.
    //
    // A rotating cursor over the sorted id list bounds the work per sweep and
    // still visits every entry across successive sweeps. It is a plain offset
    // rather than a remembered id because entries are deleted underneath it;
    // overshooting simply wraps and re-examines from the top, which is cheap
    // and self-correcting.
    let cursor = this.intentSweepCursor % ids.length
    let inspected = 0
    while (inspected < HOUSEKEEPING_BATCH && inspected < ids.length) {
      const id = ids[cursor]!
      cursor = (cursor + 1) % ids.length
      inspected++
      const path = join(this.paths.intentsDir, `${id}.json`)
      // Enumeration: an unreadable intent must not abort housekeeping.
      const intent = await readJsonFile<ActivationCommitIntent>(path, { tolerateUnreadable: true })
      if (!intent || intent.status === 'prepared') continue
      if (now - intent.createdAt < INTENT_RETENTION_MS) continue
      await deleteJsonFile(path).catch(() => undefined)
    }
    this.intentSweepCursor = cursor
  }

  /** True when this instance has any durable history (journal tail or checkpoint). */
  private async hasDurableHistoryLocked(): Promise<boolean> {
    if (await this.readLastSequenceLocked() > 0) return true
    const checkpoint = await readJsonFile<GraphCheckpoint>(this.paths.checkpointJson)
      ?? await readJsonFile<GraphCheckpoint>(this.paths.checkpointPrevJson)
    return checkpoint !== null
  }
}

const CHECKPOINT_INTERVAL = 50
/** Terminal (succeeded/failed/cancelled) Activations older than this are folded out of checkpoints. */
const ACTIVATION_RETENTION_MS = 24 * 60 * 60_000
/** Consumed external events stay deduplicable for this window (webhook redelivery horizon). */
const EXTERNAL_EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000
/** Committed/discarded commit-intent files older than this are deleted. */
const INTENT_RETENTION_MS = 7 * 24 * 60 * 60_000
const HOUSEKEEPING_BATCH = 500
const HOUSEKEEPING_INTERVAL_MS = 10 * 60_000
/**
 * Soft cap on journal events awaiting audit projection. Crossing it never slows
 * or fails graph execution — it only marks the instance so the backlog is
 * visible before shutdown has to drain it.
 */
const MAX_TRAJECTORY_AUDIT_LAG = 256

/**
 * Conservative checkpoint retention. An Activation is dropped ONLY when every
 * reader is provably done with it:
 *   • live statuses (ready/running/waiting/committing) are always kept;
 *   • join-node Activations are kept — spawned-join dedup inspects succeeded
 *     join members per fork group (CommitCoordinator.commit);
 *   • terminal-node Activations are kept — resumePausedTerminal looks up
 *     succeeded paused Terminals without resumedAt;
 *   • anything else is kept for ACTIVATION_RETENTION_MS after its last update
 *     (grace for observers/CLI), then folded out.
 * When the spec cannot be read, nothing is dropped.
 */
function retainActivationInCheckpoint(
  activation: ActivationRecord,
  spec: FrozenLoopGraphSpec | null,
  now: number,
): boolean {
  if (['ready', 'running', 'waiting', 'committing'].includes(activation.status)) return true
  if (!spec || spec.schemaVersion !== 'graph-2.0') return true
  const nodeType = spec.nodes[activation.nodeId]?.type
  if (nodeType === 'join' || nodeType === 'terminal' || nodeType === undefined) return true
  return now - activation.updatedAt < ACTIVATION_RETENTION_MS
}

interface GraphCheckpoint {
  schemaVersion: 'graph-checkpoint-2.0'
  lastSequence: number
  instance: GraphInstanceRecord
  state: GraphStateSnapshot
  activations: ActivationRecord[]
  commitKeys: Array<[string, number]>
  externalEvents: GraphExternalEventRecord[]
  /**
   * B2: highest journal sequence whose file has been deleted. Durable, because
   * the in-memory-only cursor it replaces reset to 0 in every new process.
   *
   * `deleteJsonFile` swallows ENOENT, so re-walking an already-pruned prefix
   * still consumed the per-checkpoint budget. Each CLI invocation is a fresh
   * process, so the cursor restarted at 1 every time and could only advance
   * HOUSEKEEPING_BATCH per checkpoint — with CHECKPOINT_INTERVAL=50 that is
   * 10 new events per 1 sequence of catch-up. An instance with N historical
   * events needed ~N/10 new events before pruning resumed; past a few thousand
   * events the journal directory effectively stopped being pruned at all.
   *
   * Optional so checkpoints written by older builds still load (they simply
   * fall back to deriving the cursor from the journal directory).
   */
  prunedThrough?: number
}

function activationId(): string {
  return `act-${randomUUID()}`
}

function compareActivation(a: ActivationRecord, b: ActivationRecord): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}

/** Stable, conservative arbitration for simultaneously-ready Terminals. */
function compareTerminalActivation(a: ActivationRecord, b: ActivationRecord, graph: FrozenLoopGraphSpec): number {
  const rank = (activation: ActivationRecord): number => {
    const node = graph.nodes[activation.nodeId]
    if (node?.type !== 'terminal') return 3
    return node.status === 'failed' ? 0 : node.status === 'exhausted' ? 1 : node.status === 'paused' ? 2 : 3
  }
  let inputOrder = 0
  try {
    inputOrder = stableJson(a.input).localeCompare(stableJson(b.input))
  } catch {
    // Pathologically deep agent-produced input must not crash claimReady with
    // a stack overflow; fall through to the remaining stable tie-breakers.
    inputOrder = 0
  }
  return rank(a) - rank(b) ||
    a.nodeId.localeCompare(b.nodeId) ||
    (a.sourceTransitionId ?? '').localeCompare(b.sourceTransitionId ?? '') ||
    inputOrder ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
}

function isFinalStatus(status: GraphInstanceRecord['status']): boolean {
  return status === 'done' || status === 'exhausted' || status === 'failed'
}

/**
 * Pure existence check for one journal entry — deliberately NOT readJsonFile().
 *
 * M3-fix: readJsonFile() quarantines a file it cannot parse (renames it to
 * `<path>.<ts>.corrupt`) and returns null. Both journal scans used it as their
 * existence probe, so probing a CORRUPT entry deleted it, stopped the scan at
 * that sequence, and let the next append reuse the number — the event vanished
 * and, because the numbering stayed contiguous, readJournalRangeLocked's
 * `journal sequence gap` check never fired. A destructive read was silently
 * repairing away the very evidence the recovery path is built on.
 *
 * With a plain access() the bad entry stays put, so the next reconcile raises
 * `graph journal sequence gap at N` — which isDeterministicGraphError already
 * classifies as deterministic, parking the instance as `failed` for inspection
 * instead of continuing on a corrupted history.
 */
async function journalEntryExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(',')}}`
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

export async function listGraphInstanceRecords(projectDir: string): Promise<GraphInstanceRecord[]> {
  const root = join(resolve(projectDir), '.loop')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const records: GraphInstanceRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const record = await readJsonFile<GraphInstanceRecord>(join(root, entry.name, 'instance.json'))
    if (record?.engine === 'durable-graph-v2') records.push(record)
  }
  return records.sort((a, b) => a.instanceId.localeCompare(b.instanceId))
}
