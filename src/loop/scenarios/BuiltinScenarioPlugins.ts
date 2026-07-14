import {
  complianceScenarioDefinition,
  genericScenarioDefinition,
  releaseScenarioDefinition,
  researchScenarioDefinition,
} from './ScenarioDefinitions.js'
import { complianceScenarioRuntime, releaseScenarioRuntime } from './generic/BuiltinWorkScenarios.js'
import { genericScenarioRuntime } from './generic/GenericScenario.js'
import { researchScenarioRuntime } from './research/ResearchScenario.js'
import { ScenarioRegistry } from './ScenarioRegistry.js'
import type { ScenarioPluginV1 } from './ScenarioPlugin.js'

function builtin(
  definition: ScenarioPluginV1['definition'],
  runtime: ScenarioPluginV1['runtime'],
): ScenarioPluginV1 {
  return {
    manifest: {
      apiVersion: 1,
      id: definition.id,
      version: '1.0.0',
      integrity: `builtin:${definition.id}:1`,
    },
    definition,
    runtime,
  }
}

export const builtinScenarioPlugins: readonly ScenarioPluginV1[] = [
  builtin(researchScenarioDefinition, researchScenarioRuntime),
  builtin(genericScenarioDefinition, genericScenarioRuntime),
  builtin(releaseScenarioDefinition, releaseScenarioRuntime),
  builtin(complianceScenarioDefinition, complianceScenarioRuntime),
]

export function createBuiltinScenarioRegistry(): ScenarioRegistry {
  return new ScenarioRegistry(builtinScenarioPlugins)
}

/** Compatibility composition root for existing public APIs. */
export const defaultScenarioRegistry = createBuiltinScenarioRegistry()
