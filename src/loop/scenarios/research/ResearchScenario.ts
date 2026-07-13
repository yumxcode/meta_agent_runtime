import type { ScenarioRuntime } from '../ScenarioRuntime.js'
import { DEFAULT_SCENARIO_ID } from '../ScenarioDefinitions.js'
import {
  commitResearchArtifacts,
  reconcileResearchArtifacts,
  runResearchProducerGate,
} from './ResearchArtifacts.js'
import {
  renderResearchReport,
  researchHarvestPreface,
  researchProducerOutputContract,
} from './ResearchPresentation.js'

export const researchScenarioRuntime: ScenarioRuntime = {
  id: DEFAULT_SCENARIO_ID,
  producerOutputContract: researchProducerOutputContract,
  reconcileArtifacts: reconcileResearchArtifacts,
  runProducerGate: (instance, gateId) => gateId === 'direction_diversity'
    ? runResearchProducerGate(instance, gateId)
    : Promise.resolve({ verdict: 'error', messages: [`unsupported producer gate '${gateId}'`] }),
  commitArtifacts: async (instance, input) => {
    const result = await commitResearchArtifacts(instance, input)
    return { legacyFindingDelta: result.admittedItems }
  },
  harvestPreface: researchHarvestPreface,
  renderReport: renderResearchReport,
}
