import type { ActivationUsage, JsonValue } from '../spec/GraphTypes.js'
import type { ShapeSpec } from '../spec/ShapeSpec.js'

/** Stable Graph Runtime execution profile. It is not a user-facing SessionMode. */
export const GRAPH_AGENT_PROFILE = 'graph_agent' as const

export interface GraphAgentPrompt {
  /** Complete system prompt owned by the common graph_agent layer. */
  system: string
  /** Fully assembled user turn for this physical execution segment. */
  user: string
}

export interface GraphAgentWorkspace {
  projectDir: string
  mode: 'shared_readonly' | 'shared_write' | 'isolated_write' | 'ephemeral_snapshot'
  writeAllowPaths: string[]
  writeDenyPaths: string[]
}

export interface GraphAgentContinuity {
  /** Stable only for a persistent Lane; absent means a fresh session. */
  lineageSessionId?: string
  workspaceId: string
  loopInstanceId: string
}

export interface GraphAgentSegmentLimits {
  turns: number
  usd: number
  wallTimeMs?: number
}

export interface GraphAgentTimerCapability {
  maxDelayMs?: number
}

export interface GraphAgentExecutionRequest {
  profile: typeof GRAPH_AGENT_PROFILE
  prompt: GraphAgentPrompt
  /** Frozen Node output contract, enforced by the substrate's result channel. */
  outputSchema?: ShapeSpec
  allowedTools: string[]
  workspace: GraphAgentWorkspace
  continuity: GraphAgentContinuity
  limits: GraphAgentSegmentLimits
  timer?: GraphAgentTimerCapability
  hostCoordinatorRoot?: string
  maxConcurrentModelCalls?: number
  signal: AbortSignal
}

export interface GraphAgentParkIntent {
  afterMs: number
  reason: string
  checkpoint?: JsonValue
}

export interface GraphAgentExecutionDiagnostics {
  timeoutPhase?: 'initializing' | 'model_admission' | 'provider_response' | 'agent_execution'
  runtimeEventCount?: number
  firstRuntimeEventAt?: number
  lastRuntimeEventAt?: number
  lastRuntimeEventType?: string
}

/**
 * Substrate-neutral result of one physical Graph Agent segment.
 *
 * A logical Graph Activation may execute many segments when `park` is returned.
 * The Graph Kernel, not the executor, owns retry, routing, state and commit.
 */
export type GraphAgentExecutionResult =
  | {
      /** Executor admission refused before a model segment started. */
      kind: 'exhausted'
      reason: string
      usage: ActivationUsage
    }
  | {
      kind: 'completed'
      taskId: string
      success: boolean
      output?: unknown
      summary: string
      error?: string
      diagnostics?: GraphAgentExecutionDiagnostics
      usage: ActivationUsage
      park?: GraphAgentParkIntent
    }
  | {
      kind: 'aborted' | 'timed_out' | 'lost'
      taskId: string
      usage: ActivationUsage
      park?: GraphAgentParkIntent
    }
  | {
      kind: 'cancellation_unconfirmed'
      taskId: string
      usage: ActivationUsage
      park?: GraphAgentParkIntent
    }

/** Replaceable execution boundary between the durable Graph Kernel and an LLM runtime. */
export interface GraphAgentExecutor {
  readonly id: string
  execute(request: GraphAgentExecutionRequest): Promise<GraphAgentExecutionResult>
}
