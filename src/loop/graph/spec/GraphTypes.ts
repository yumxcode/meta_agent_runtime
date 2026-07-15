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
export type LaneWorkspaceMode = 'readonly' | 'lane_overlay' | 'effect_only'

export interface LaneDataReadGrant {
  plane: string
  /** Omit to allow every declared View on the Plane. */
  views?: string[]
}

export interface LaneDataAccessSpec {
  /** Upper bound only; each Agent Node must still select an exact View. */
  read?: LaneDataReadGrant[]
  /** Logical record Planes this Lane may publish into. */
  publish?: string[]
  /** Logical workspace Planes this Lane may mutate directly. */
  write?: string[]
}

export interface ExecutionLaneSpec {
  context: LaneContextMode
  workspace: LaneWorkspaceMode
  maxConcurrency?: number
  description?: string
  /** Stable graph-authored identity/instructions shared by Agent nodes on this Lane. */
  agentProfile?: AgentProfileSpec
  /** Data-plane authorization ceiling inherited by Agent nodes on this Lane. */
  dataAccess?: LaneDataAccessSpec
  annotations?: GraphAnnotations
}

export interface AgentProfileSpec {
  systemInstructions: string
}

export type ContextRefreshPolicy = 'activation_start' | 'every_segment' | 'continuation_only'
export type ContextTrust = 'trusted_runtime' | 'trusted_graph' | 'untrusted_data'

export interface ContextSectionSpec {
  /** Unique section name within the node; used as the durable cache key. */
  name: string
  /** Versioned Context Provider reference, for example builtin/evidence-view@1. */
  provider: string
  refresh: ContextRefreshPolicy
  config?: JsonValue
  required?: boolean
  /** Hard rendered-content bound. Defaults to 32768 and cannot exceed 262144. */
  maxBytes?: number
}

export interface ContextAssemblyPlan {
  sections: ContextSectionSpec[]
}

export interface NodeBase {
  type: string
  description?: string
  timeoutMs?: number
  publishes?: ArtifactPublishSpec[]
  annotations?: GraphAnnotations
}

export interface AgentNodeSpec extends NodeBase {
  type: 'agent'
  lane: string
  prompt: string
  /** Optional graph-authored system extension; Kernel system rules remain protected. */
  systemInstructions?: string
  /** Ordered, declarative context injected after the mandatory activation section. */
  context?: ContextAssemblyPlan
  inputs?: Record<string, ValueExpression>
  outputSchema?: ShapeSpec
  tools?: string[]
  skills?: string[]
  writes?: string[]
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

export interface ArtifactChannelSpec {
  kind?: 'artifact' | 'evidence'
  schema?: ShapeSpec
  admission?: 'automatic' | 'judge'
  maxItems?: number
}

export interface ArtifactPublishSpec {
  /** Logical Data Plane reference used by Distill; Freeze compiles it to channel. */
  plane?: string
  /** Physical record channel. Intended for low-level/frozen GraphSpecs. */
  channel?: string
  /** Executor outcome that admits this publication; defaults to success. */
  on?: string
  value: ValueExpression
  status?: 'proposed' | 'admitted'
  supersedes?: ValueExpression
  tags?: string[]
}

export interface GraphArtifactRecord {
  schemaVersion: 'graph-artifact-1.0'
  id: string
  channel: string
  kind: 'artifact' | 'evidence'
  status: 'proposed' | 'admitted' | 'rejected' | 'superseded'
  content: JsonValue
  tags: string[]
  provenance: {
    activationId: string
    nodeId: string
    laneId?: string
    stateVersion: number
    createdAt: number
  }
  supersedes?: string
  supersededBy?: string
}

export interface EvidenceViewSpec {
  channels: string[]
  statuses?: Array<'proposed' | 'admitted' | 'rejected' | 'superseded'>
  maxItems?: number
}

export interface ArtifactViewSpec extends EvidenceViewSpec {}

/**
 * Optional workspace-backed representation of a Graph data plane. Bindings are
 * deliberately path/name agnostic: Distill may map any user protocol onto
 * these primitives, and graphs without bindings retain their existing runtime.
 */
export type WorkspacePlane =
  | 'input'
  | 'state_projection'
  | 'evidence'
  | 'artifact'
  | 'audit'
  | 'observability'

export type WorkspaceBindingDirection = 'ingest' | 'materialize' | 'bidirectional'
export type WorkspaceBindingFormat = 'json' | 'jsonl' | 'text' | 'markdown'

export type WorkspaceProjectionSpec =
  | { kind: 'state'; keys?: string[] }
  | { kind: 'evidence_view'; view: string; record?: 'content' | 'envelope'; flattenArrays?: boolean }
  | { kind: 'artifact_view'; view: string; record?: 'content' | 'envelope'; flattenArrays?: boolean }
  | { kind: 'journal'; eventTypes?: GraphJournalEvent['type'][]; record?: 'event' | 'envelope' }
  /** Distill-level reference compiled away by Freeze. */
  | { kind: 'data_view'; view: string; record?: 'content' | 'envelope'; flattenArrays?: boolean }

export interface WorkspaceBindingSpec {
  plane: WorkspacePlane
  /** Workspace-relative path. No absolute paths, traversal, or runtime internals. */
  path: string
  format: WorkspaceBindingFormat
  direction: WorkspaceBindingDirection
  /** When present, resolve/materialize inside this Lane's durable workspace. */
  lane?: string
  /** Missing ingest files fail when true; defaults to false. */
  required?: boolean
  /** Preserve existing JSONL records and append only unseen projected values. */
  appendOnly?: boolean
  /** Required whenever direction includes materialization. */
  projection?: WorkspaceProjectionSpec
  /** State projections may seed Kernel State exactly once during instance creation. */
  initializeState?: 'graph_defaults' | 'workspace_if_present' | 'workspace_required'
}

export type DataPlaneBackend = 'state' | 'record' | 'journal' | 'workspace'
export type DataPlaneMutability = 'append_only' | 'superseding'

interface DataPlaneBaseSpec {
  backend: DataPlaneBackend
  /** User-defined domain meaning; Kernel never branches on this value. */
  semanticRole: string
  description?: string
  /** Trust is checked against the selected physical backend and cannot elevate data. */
  trust: ContextTrust
  annotations?: GraphAnnotations
}

export type DataPlaneSpec =
  | (DataPlaneBaseSpec & {
      backend: 'state'
      stateKeys: string[]
    })
  | (DataPlaneBaseSpec & {
      backend: 'record'
      recordKind: 'evidence' | 'artifact'
      schema?: ShapeSpec
      mutability: DataPlaneMutability
      admission: 'automatic' | 'judge'
      retention?: { maxItems?: number }
    })
  | (DataPlaneBaseSpec & {
      backend: 'journal'
      eventTypes?: GraphJournalEvent['type'][]
    })
  | (DataPlaneBaseSpec & {
      backend: 'workspace'
      binding: WorkspaceBindingSpec
    })

export interface DataPlaneViewSpec {
  plane: string
  description?: string
  /** State selector; valid only for state backend. */
  stateKeys?: string[]
  /** Record admission selector; valid only for record backend. */
  statuses?: Array<'proposed' | 'admitted' | 'rejected' | 'superseded'>
  /** Journal selector; valid only for journal backend. */
  eventTypes?: GraphJournalEvent['type'][]
  maxItems?: number
}

export interface CompiledDataPlaneRef {
  backend: DataPlaneBackend
  physicalId?: string
  trust: ContextTrust
}

/** Freeze-owned physical authorization table consumed by the Kernel. */
export interface CompiledLaneDataAccessSpec {
  readViews: Array<{ view: string; backend: DataPlaneBackend; physicalId?: string }>
  publishChannels: string[]
  writeBindings: string[]
}

export interface ContextSectionSnapshot {
  schemaVersion: 'graph-context-section-1.0'
  name: string
  provider: FrozenCapabilityRef
  source: string
  trust: ContextTrust
  role: 'context_data'
  refresh: ContextRefreshPolicy
  resolvedAt: number
  stateVersion: number
  truncated: boolean
  originalBytes: number
  renderedBytes: number
  content: JsonValue
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
  schemaVersion: 'graph-1.0'
  id: string
  version: number
  goal: string
  capabilityPacks?: FrozenCapabilityRef[]
  state: Record<string, StateVariableSpec>
  lanes: Record<string, ExecutionLaneSpec>
  nodes: Record<string, NodeSpec>
  transitions: TransitionSpec[]
  entrypoints: EntrypointSpec[]
  artifacts?: Record<string, ArtifactChannelSpec>
  artifactViews?: Record<string, ArtifactViewSpec>
  evidenceViews?: Record<string, EvidenceViewSpec>
  /** Optional filesystem sources/projections for any domain protocol. */
  workspaceBindings?: Record<string, WorkspaceBindingSpec>
  /** Distill-authored logical planes compiled to fixed physical backends by Freeze. */
  dataPlanes?: Record<string, DataPlaneSpec>
  /** Exact named selectors used by Agent Context Assembly. */
  dataViews?: Record<string, DataPlaneViewSpec>
  limits: LoopLimits
  concurrency?: LoopConcurrencyPolicy
  annotations?: GraphAnnotations
}

export interface CapabilityLock {
  functions: FrozenCapabilityRef[]
  reducers: FrozenCapabilityRef[]
  effects: FrozenCapabilityRef[]
  contextProviders: FrozenCapabilityRef[]
  packs: FrozenCapabilityRef[]
}

export interface FrozenLoopGraphSpec extends LoopGraphSpec {
  capabilityLock: CapabilityLock
  graphHash: string
  frozenAt: number
  /** Freeze-owned logical-to-physical resolution table. */
  compiledDataPlanes?: Record<string, CompiledDataPlaneRef>
  /** Freeze-owned Lane ACL resolved entirely to physical IDs. */
  compiledLaneDataAccess?: Record<string, CompiledLaneDataAccessSpec>
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
  /** Durable activation_start Context Provider results, keyed by section name. */
  contextCache?: Record<string, ContextSectionSnapshot>
  parentActivationId?: string
  sourceTransitionId?: string
  /** Causal fork epoch used to coalesce one Join execution per fan-out. */
  forkGroupId?: string
  lease?: { token: string; owner: string; expiresAt: number }
  output?: JsonValue
  outcome?: string
  error?: string
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
  engine: 'durable-graph-v1'
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
  name: string
  correlation?: JsonValue
  payload?: JsonValue
  status: 'pending' | 'consumed'
  createdAt: number
  consumedAt?: number
  consumedBy?: string[]
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
      type: 'activation_context_cached'
      at: number
      activation: ActivationRecord
      sectionName: string
    }
  | {
      type: 'activation_committed'
      at: number
      commitKey: string
      activation: ActivationRecord
      spawned: ActivationRecord[]
      cancelled?: ActivationRecord[]
      artifacts?: GraphArtifactRecord[]
      publicationRejections?: Array<{ channel: string; reason: string }>
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
