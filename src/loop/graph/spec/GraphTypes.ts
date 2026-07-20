import type { ShapeSpec } from './ShapeSpec.js'
export type { ShapeSpec } from './ShapeSpec.js'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/**
 * Open, non-executable metadata for domain-specific authoring information.
 * Kernel/Freeze never branch on annotations; executable extensions must be
 * supplied by a versioned Capability Pack.
 */
export type GraphAnnotations = Record<string, JsonValue>

/** Values are data expressions, never executable code. */
export type ValueExpression =
  | { literal: JsonValue }
  | { ref: string }
  | { call: string; args?: ValueExpression[] }

export interface StateVariableSpec {
  type: ShapeSpec
  initial: JsonValue
  description?: string
}

export type LaneContextMode = 'persistent' | 'fresh_per_activation'
export type WorkspaceWriteMode = 'owned' | 'atomic_replace' | 'append_only'

/** A Lane directly owns these workspace paths. No projection or hidden backend exists. */
export interface WorkspaceWriteRule {
  path: string
  mode: WorkspaceWriteMode
  /** Optional schema checked by the Agent/tooling; Kernel never assigns domain meaning. */
  schema?: ShapeSpec
  description?: string
}

export interface LaneWorkspaceContract {
  /** Readable path prefixes. Omit or use ** for the whole project workspace. */
  read?: string[]
  /** Writable path prefixes/files. One path may have only one owning Lane. */
  write?: WorkspaceWriteRule[]
  /** Immutable prefixes even when covered by a broader write rule. */
  deny?: string[]
}

export interface ExecutionLaneSpec {
  context: LaneContextMode
  workspace: LaneWorkspaceContract
  maxConcurrency?: number
  description?: string
  /** Stable graph-authored identity/instructions shared by Agent nodes on this Lane. */
  agentProfile?: AgentProfileSpec
  /**
   * Explicit source-control capability. By default the Kernel denies all
   * writes to the project-root `.git` directory. `scm: 'git'` opts this Lane
   * in to commit/push mechanics: `.git` becomes writable EXCEPT `.git/hooks`
   * and `.git/config` (the code-execution and credential attack surfaces stay
   * protected). At most one Lane per graph may declare scm — the git index is
   * a single-writer resource. Loops that must not touch project history can
   * instead keep a nested clone under an owned write path; a nested `.git`
   * inside an owned prefix is writable without this flag.
   */
  scm?: 'git'
  annotations?: GraphAnnotations
}

export interface AgentProfileSpec {
  systemInstructions: string
}

export interface NodeBase {
  type: string
  description?: string
  timeoutMs?: number
  annotations?: GraphAnnotations
}

export interface AgentNodeSpec extends NodeBase {
  type: 'agent'
  lane: string
  prompt: string
  /** Optional graph-authored system extension; Kernel system rules remain protected. */
  systemInstructions?: string
  inputs?: Record<string, ValueExpression>
  outputSchema?: ShapeSpec
  tools?: string[]
  skills?: string[]
  maxAttempts?: number
  /** Per-process-segment limits. A timer continuation starts a new segment. */
  budget?: { turns?: number; usd?: number; wallTimeMs?: number }
  /** Limits covering the complete logical Activation across every continuation. */
  lifetimeBudget?: { turns?: number; usd?: number; elapsedMs?: number }
  timerPolicy?: { allowHardPark?: boolean; maxDelayMs?: number; maxParks?: number }
}

export interface FunctionNodeSpec extends NodeBase {
  type: 'function'
  function: string
  inputs?: Record<string, ValueExpression>
  outputSchema?: ShapeSpec
}

export interface EffectNodeSpec extends NodeBase {
  type: 'effect'
  effect: string
  inputs?: Record<string, ValueExpression>
  idempotencyKey?: ValueExpression
}

export interface WaitNodeSpec extends NodeBase {
  type: 'wait'
  wait:
    | { kind: 'timer'; delayMs: ValueExpression; maxDelayMs?: number }
    | { kind: 'event'; event: string; correlation?: ValueExpression; timeoutMs?: number }
}

export interface JoinNodeSpec extends NodeBase {
  type: 'join'
  mode: 'all' | 'any'
  /** Explicit predecessor transition IDs; avoids topology-dependent ambiguity. */
  expects: string[]
}

export interface TerminalNodeSpec extends NodeBase {
  type: 'terminal'
  status: 'done' | 'failed' | 'paused'
  result?: ValueExpression
}

export type NodeSpec =
  | AgentNodeSpec
  | FunctionNodeSpec
  | EffectNodeSpec
  | WaitNodeSpec
  | JoinNodeSpec
  | TerminalNodeSpec

export interface StateUpdateSpec {
  target: string
  reducer: string
  args?: ValueExpression[]
}

export interface TransitionTarget {
  node: string
  inputs?: Record<string, ValueExpression>
}

export interface TransitionSpec {
  id: string
  from: string
  /** Executor outcome, such as success, failure, timer, event, or always. */
  on?: string
  when?: string
  default?: boolean
  priority?: number
  updates?: StateUpdateSpec[]
  to: string | TransitionTarget | Array<string | TransitionTarget>
  annotations?: GraphAnnotations
}

export interface EntrypointSpec {
  id: string
  node: string
  inputs?: Record<string, ValueExpression>
}

export interface FrozenCapabilityRef {
  id: string
  version: string
  integrity: string
}

export interface LoopLimits {
  maxActivations: number
  maxWallTimeMs?: number
  maxCostUsd?: number
  maxFanOut?: number
  maxPendingTimers?: number
}

export interface LoopConcurrencyPolicy {
  maxActivations?: number
  maxPerNode?: number
  /**
   * commit_latest keeps maximum throughput and serializes only commit effects.
   * serializable replays an Activation whose State snapshot became stale while
   * it was computing. The policy is graph-wide and domain agnostic.
   */
  stateConsistency?: 'commit_latest' | 'serializable'
}

export interface LoopGraphSpec {
  schemaVersion: 'graph-2.0'
  id: string
  version: number
  goal: string
  capabilityPacks?: FrozenCapabilityRef[]
  state: Record<string, StateVariableSpec>
  lanes: Record<string, ExecutionLaneSpec>
  nodes: Record<string, NodeSpec>
  transitions: TransitionSpec[]
  entrypoints: EntrypointSpec[]
  limits: LoopLimits
  concurrency?: LoopConcurrencyPolicy
  annotations?: GraphAnnotations
}

export interface CapabilityLock {
  functions: FrozenCapabilityRef[]
  reducers: FrozenCapabilityRef[]
  effects: FrozenCapabilityRef[]
  packs: FrozenCapabilityRef[]
  /** Exact graph_agent tool names required by the frozen graph. */
  agentTools?: string[]
}

export interface FrozenLoopGraphSpec extends LoopGraphSpec {
  capabilityLock: CapabilityLock
  graphHash: string
  frozenAt: number
}

export type ActivationStatus =
  | 'ready'
  | 'running'
  | 'waiting'
  | 'committing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface ActivationRecord {
  schemaVersion: 'graph-activation-1.0'
  id: string
  nodeId: string
  laneId?: string
  status: ActivationStatus
  attempt: number
  /** Number of process segments started for this logical Activation. */
  segmentCount?: number
  /** Number of durable timer parks committed for this Activation. */
  parkCount?: number
  /** Number of non-attempt-consuming replays (lease loss, serializable conflicts). */
  replayCount?: number
  /** Usage accumulated across completed and parked execution segments. */
  usage?: ActivationUsage
  /** First time this Activation acquired an execution lease. */
  firstStartedAt?: number
  /** Why a ready Activation should be claimed; continuations do not consume retries. */
  readyReason?: 'initial' | 'continuation' | 'retry' | 'replay'
  createdAt: number
  updatedAt: number
  input: Record<string, JsonValue>
  inputStateVersion: number
  /** Authoritative State version observed when the current segment was claimed. */
  executionStateVersion?: number
  continuationVersion: number
  parentActivationId?: string
  sourceTransitionId?: string
  /** Causal fork epoch used to coalesce one Join execution per fan-out. */
  forkGroupId?: string
  lease?: { token: string; owner: string; expiresAt: number }
  output?: JsonValue
  outcome?: string
  error?: string
  /** Concise operator-facing reason why the latest execution segment stopped. */
  summary?: string
  wakeAt?: number
  waitingReason?: 'continuation' | 'retry' | 'replay'
  event?: { name: string; correlation?: JsonValue }
  terminalResult?: JsonValue
  /** A paused Terminal may be resumed exactly once through its resume edge. */
  resumedAt?: number
}

export type GraphInstanceStatus = 'active' | 'waiting' | 'paused' | 'done' | 'failed'

export interface GraphInstanceRecord {
  schemaVersion: 'graph-instance-1.0'
  engine: 'durable-graph-v2'
  instanceId: string
  graphId: string
  graphVersion: number
  graphHash: string
  workspaceId: string
  projectDir: string
  status: GraphInstanceStatus
  createdAt: number
  updatedAt: number
  activationCount: number
  totalCostUsd: number
  terminalResult?: JsonValue
  statusReason?: string
}

export interface GraphStateSnapshot {
  schemaVersion: 'graph-state-1.0'
  version: number
  values: Record<string, JsonValue>
  updatedAt: number
}

export interface ActivationUsage {
  turns: number
  costUsd: number
  durationMs: number
}

export interface GraphExternalEventRecord {
  schemaVersion: 'graph-external-event-1.0'
  id: string
  /** Namespace of the external delivery identity, for example github or gitlab. */
  source?: string
  /** Source-scoped idempotency key supplied by the ingress adapter. */
  deliveryId?: string
  name: string
  correlation?: JsonValue
  payload?: JsonValue
  status: 'pending' | 'consumed'
  createdAt: number
  consumedAt?: number
  consumedBy?: string[]
}

export interface GraphExternalEventInput {
  name: string
  /** source and deliveryId must either both be present or both be absent. */
  source?: string
  deliveryId?: string
  correlation?: JsonValue
  payload?: JsonValue
}

export interface GraphExternalEventDeliveryResult {
  event: GraphExternalEventRecord
  resumed: number
  /** True when this source delivery was already durably accepted. */
  duplicate: boolean
}

export type GraphJournalEvent =
  | {
      type: 'graph_created'
      at: number
      state: GraphStateSnapshot
      activations: ActivationRecord[]
      instance: GraphInstanceRecord
    }
  | {
      type: 'activation_claimed'
      at: number
      activation: ActivationRecord
    }
  | {
      type: 'activation_released'
      at: number
      activation: ActivationRecord
      reason: string
      /** Present when release changes instance-level accounting, such as park cost. */
      instance?: GraphInstanceRecord
    }
  | {
      type: 'activation_committed'
      at: number
      commitKey: string
      activation: ActivationRecord
      spawned: ActivationRecord[]
      cancelled?: ActivationRecord[]
      state: GraphStateSnapshot
      instance: GraphInstanceRecord
      transitionId?: string
    }
  | {
      type: 'graph_status_changed'
      at: number
      instance: GraphInstanceRecord
    }
  | {
      type: 'paused_terminal_resumed'
      at: number
      activation: ActivationRecord
      spawned: ActivationRecord[]
      state: GraphStateSnapshot
      instance: GraphInstanceRecord
      transitionId: string
    }
  | {
      type: 'external_event_recorded'
      at: number
      externalEvent: GraphExternalEventRecord
    }
  | {
      type: 'external_event_consumed'
      at: number
      externalEvent: GraphExternalEventRecord
      activations: ActivationRecord[]
    }

export interface SequencedGraphJournalEvent {
  schemaVersion: 'graph-journal-1.0'
  sequence: number
  eventId: string
  event: GraphJournalEvent
}

export interface ActivationCommitIntent {
  schemaVersion: 'graph-commit-intent-1.0'
  commitKey: string
  activationId: string
  continuationVersion: number
  leaseToken: string
  outcome: string
  output: JsonValue
  /** Concise operator-facing completion summary, persisted with the commit. */
  summary?: string
  usage?: ActivationUsage
  createdAt: number
  status: 'prepared' | 'committed'
  journalSequence?: number
}

export interface GraphEffectIntent {
  schemaVersion: 'graph-effect-intent-1.0'
  operationKey: string
  activationId: string
  continuationVersion: number
  effect: string
  idempotencyKey: string
  input: Record<string, JsonValue>
  status: 'prepared' | 'submitted' | 'succeeded' | 'failed'
  receipt?: JsonValue
  output?: JsonValue
  error?: string
  createdAt: number
  updatedAt: number
}
