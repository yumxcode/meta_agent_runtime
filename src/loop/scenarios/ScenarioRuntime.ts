import type { ArtifactSpec, FrozenCharter } from '../charter/CharterTypes.js'
import type { LoopInstance } from '../instance/InstanceStore.js'
import {
  COMPLIANCE_SCENARIO_ID,
  GENERIC_SCENARIO_ID,
  DEFAULT_SCENARIO_ID,
  RELEASE_SCENARIO_ID,
  listScenarioDefinitions,
} from './ScenarioDefinitions.js'
import { genericScenarioRuntime } from './generic/GenericScenario.js'
import { researchScenarioRuntime } from './research/ResearchScenario.js'
import { complianceScenarioRuntime, releaseScenarioRuntime } from './generic/BuiltinWorkScenarios.js'

export interface ScenarioGateOutcome {
  verdict: 'pass' | 'fail' | 'error'
  messages: string[]
}

export interface ScenarioRuntime {
  readonly id: string
  producerOutputContract(draftsDir: string, artifacts: Record<string, ArtifactSpec>): string
  reconcileArtifacts(instance: LoopInstance): Promise<void>
  runProducerGate(instance: LoopInstance, gateId: string): Promise<ScenarioGateOutcome>
  /** Scenario may bind an event wait to trusted draft-derived evidence. */
  prepareEventWait?(instance: LoopInstance, input: {
    round: number
    effectKey?: string
    payload?: Record<string, unknown>
    maxWaitMs: number
  }): Promise<{
    effectKey: string
    payload?: Record<string, unknown>
    maxWaitMs: number
    adapterId?: string
    effectBindingId?: string
    authRequired?: boolean
    retryPolicy?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; callTimeoutMs: number }
  }>
  commitArtifacts(instance: LoopInstance, input: {
    round: number
    producerOk: boolean
    judgeRequired: boolean
    judge: { ok: boolean; data: Record<string, unknown> } | null
  }): Promise<{ legacyFindingDelta: number }>
  harvestPreface(input: {
    selfTimer: boolean
    reason?: string
    submitSummary: string
    effect?: { verdict?: string; via?: string; data?: unknown }
  }): string
  renderReport(instance: LoopInstance, reason: string, narrative?: string): Promise<string>
}

const REGISTRY = new Map<string, ScenarioRuntime>([
  [researchScenarioRuntime.id, researchScenarioRuntime],
  [genericScenarioRuntime.id, genericScenarioRuntime],
  [releaseScenarioRuntime.id, releaseScenarioRuntime],
  [complianceScenarioRuntime.id, complianceScenarioRuntime],
])

for (const definition of listScenarioDefinitions()) {
  if (!REGISTRY.has(definition.id)) throw new Error(`Scenario '${definition.id}' has no runtime registration`)
}

/** Resolve only from the ID frozen into the instance Charter; unknown IDs fail closed. */
export function scenarioRuntimeFor(charter: Pick<FrozenCharter, 'scenario'> | string): ScenarioRuntime {
  const id = typeof charter === 'string' ? charter : charter.scenario
  const runtime = REGISTRY.get(id)
  if (!runtime) throw new Error(`Scenario '${id}' is not registered`)
  return runtime
}

export function registeredScenarioIds(): readonly string[] {
  return [...REGISTRY.keys()].sort()
}

export {
  DEFAULT_SCENARIO_ID,
  GENERIC_SCENARIO_ID,
  RELEASE_SCENARIO_ID,
  COMPLIANCE_SCENARIO_ID,
}
