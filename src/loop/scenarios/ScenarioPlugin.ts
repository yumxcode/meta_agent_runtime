import type { ArtifactGateResult } from '../artifacts/ArtifactProtocol.js'
import type { ArtifactSpec, FrozenCharter } from '../charter/CharterTypes.js'
import type { LoopInstance } from '../instance/InstanceStore.js'
import type { ArtifactCheckpoint } from '../projection/ArtifactCheckpoint.js'

export const SCENARIO_PLUGIN_API_VERSION = 1 as const

export type ScenarioJson =
  | null | boolean | number | string
  | ScenarioJson[]
  | { [key: string]: ScenarioJson }

export interface ScenarioCapsuleSection {
  title: string
  items: string[]
}

/** Scenario-owned, kernel-bounded cross-round context. */
export interface ScenarioCapsuleView {
  schemaVersion: number
  data: ScenarioJson
  sections: ScenarioCapsuleSection[]
}

export interface ScenarioGateOutcome {
  verdict: 'pass' | 'fail' | 'error'
  messages: string[]
}

export interface ScenarioDefinition {
  id: string
  artifacts(charter: import('../charter/CharterTypes.js').Charter): Record<string, ArtifactSpec>
  /** Gate verdicts this Scenario can attach to an Artifact decision. */
  artifactGateIds: readonly string[]
  mandatoryArtifactGateIds: readonly string[]
  allowAdditionalArtifacts: boolean
  gateBindings: readonly import('../charter/CharterTypes.js').FrozenGateBinding[]
  defaultMetric?: import('../charter/CharterTypes.js').Charter['metric']
  validateConfig?(value: ScenarioJson | undefined): string[]
}

/**
 * Runtime hooks are deliberately narrower than the loop pipeline. A Scenario
 * may describe output, context, gates, waits and report sections; the Kernel
 * remains the only owner of scheduling, routing and durable commits.
 *
 * Plugins use `artifactGate`; only the kernel-owned ArtifactPipeline commits.
 */
export interface ScenarioRuntime {
  readonly id: string
  producerOutputContract(draftsDir: string, artifacts: Record<string, ArtifactSpec>): string
  buildCapsuleView?(input: {
    instance: LoopInstance
    checkpoint: ArtifactCheckpoint
    signal?: AbortSignal
  }): Promise<ScenarioCapsuleView>
  judgeContractExtension?(charter: FrozenCharter): {
    fields: string[]
    instructions: string[]
  }
  runProducerGate(instance: LoopInstance, gateId: string, signal?: AbortSignal): Promise<ScenarioGateOutcome>
  artifactGate?(input: {
    instance: LoopInstance
    proposalId: string
    contentHash: string
    content: unknown
    spec: ArtifactSpec
    gateId: string
    judgeRequired: boolean
    judge: { ok: boolean; data: Record<string, unknown> } | null
    artifactProposalCount: number
    signal?: AbortSignal
  }): Promise<ArtifactGateResult | null>
  prepareEventWait?(instance: LoopInstance, input: {
    round: number
    effectKey?: string
    payload?: Record<string, unknown>
    maxWaitMs: number
    signal?: AbortSignal
  }): Promise<{
    effectKey: string
    payload?: Record<string, unknown>
    maxWaitMs: number
    adapterId?: string
    effectBindingId?: string
    authRequired?: boolean
    retryPolicy?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; callTimeoutMs: number }
  }>
  harvestPreface(input: {
    selfTimer: boolean
    reason?: string
    submitSummary: string
    effect?: { verdict?: string; via?: string; data?: unknown }
  }): string
  renderReport(instance: LoopInstance, reason: string, narrative?: string, signal?: AbortSignal): Promise<string>
  /** Optional Scenario-owned compatibility/read-model projection after authority refresh. */
  reconcileReadModel?(instance: LoopInstance, signal?: AbortSignal): Promise<void>
}

export interface ScenarioPluginManifest {
  apiVersion: typeof SCENARIO_PLUGIN_API_VERSION
  id: string
  version: string
  /** Package/file digest supplied by the trusted loader or plugin publisher. */
  integrity: string
}

export interface ScenarioPluginV1 {
  manifest: ScenarioPluginManifest
  definition: ScenarioDefinition
  runtime: ScenarioRuntime
}

export interface FrozenScenarioPluginRef {
  id: string
  apiVersion: typeof SCENARIO_PLUGIN_API_VERSION
  version: string
  integrity: string
}

/** Read-only information exposed to future pure Scenario validators. */
export interface ScenarioValidationContext {
  charter: FrozenCharter
  checkpoint: ArtifactCheckpoint
}
