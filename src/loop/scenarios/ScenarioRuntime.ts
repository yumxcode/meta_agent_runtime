import type { FrozenCharter } from '../charter/CharterTypes.js'
import {
  COMPLIANCE_SCENARIO_ID,
  GENERIC_SCENARIO_ID,
  DEFAULT_SCENARIO_ID,
  RELEASE_SCENARIO_ID,
} from './ScenarioDefinitions.js'
import { defaultScenarioRegistry } from './BuiltinScenarioPlugins.js'
import type { ScenarioRuntime } from './ScenarioPlugin.js'
export type { ScenarioGateOutcome, ScenarioRuntime } from './ScenarioPlugin.js'

/** Resolve only from the ID frozen into the instance Charter; unknown IDs fail closed. */
export function scenarioRuntimeFor(charter: Pick<FrozenCharter, 'scenario'> | string): ScenarioRuntime {
  const id = typeof charter === 'string' ? charter : charter.scenario
  return defaultScenarioRegistry.runtime(id)
}

export function registeredScenarioIds(): readonly string[] {
  return defaultScenarioRegistry.ids()
}

export {
  DEFAULT_SCENARIO_ID,
  GENERIC_SCENARIO_ID,
  RELEASE_SCENARIO_ID,
  COMPLIANCE_SCENARIO_ID,
}
