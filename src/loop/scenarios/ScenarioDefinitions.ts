import type { ArtifactSpec, Charter, FrozenGateBinding } from '../charter/CharterTypes.js'

export const DEFAULT_SCENARIO_ID = 'builtin/research@1'
export const GENERIC_SCENARIO_ID = 'builtin/generic@1'
export const RELEASE_SCENARIO_ID = 'builtin/release@1'
export const COMPLIANCE_SCENARIO_ID = 'builtin/compliance@1'

export interface ScenarioDefinition {
  id: string
  artifacts(charter: Charter): Record<string, ArtifactSpec>
  /** Gate verdicts this Scenario can attach to an Artifact decision. */
  artifactGateIds: readonly string[]
  mandatoryArtifactGateIds: readonly string[]
  allowAdditionalArtifacts: boolean
  gateBindings: FrozenGateBinding[]
}

const research: ScenarioDefinition = {
  id: DEFAULT_SCENARIO_ID,
  artifacts: charter => ({
    finding: {
      id: 'finding', kind: 'json', draftPath: 'drafts/findings_draft.json',
      stream: 'findings', commitMode: 'append',
      requiredGates: charter.seats?.judge ? ['producer', 'judge'] : ['producer'],
    },
    direction: {
      id: 'direction', kind: 'json', draftPath: 'drafts/direction.json',
      stream: 'directions', commitMode: 'versioned',
      requiredGates: ['producer', 'direction_diversity'],
    },
  }),
  artifactGateIds: ['producer', 'judge', 'direction_diversity'],
  mandatoryArtifactGateIds: ['producer'],
  allowAdditionalArtifacts: false,
  gateBindings: [{
    id: 'direction_diversity', kind: 'contract', handler: 'scenario', gateIds: [],
    retryProducer: 1, executionRetry: 0, feedback: 'generic',
  }],
}

const generic: ScenarioDefinition = {
  id: GENERIC_SCENARIO_ID,
  artifacts: () => ({}),
  artifactGateIds: ['producer', 'artifact_drafts'],
  mandatoryArtifactGateIds: ['producer', 'artifact_drafts'],
  allowAdditionalArtifacts: true,
  gateBindings: [{
    id: 'artifact_drafts', kind: 'contract', handler: 'scenario', gateIds: [],
    retryProducer: 1, executionRetry: 0, feedback: 'messages',
  }],
}

const release: ScenarioDefinition = {
  id: RELEASE_SCENARIO_ID,
  artifacts: () => ({
    release_manifest: {
      id: 'release_manifest', kind: 'json', draftPath: 'drafts/release_manifest.json',
      stream: 'release_manifest', commitMode: 'replace',
      requiredGates: ['producer', 'artifact_drafts'],
    },
    release_note: {
      id: 'release_note', kind: 'text', draftPath: 'drafts/release_note.md',
      stream: 'release_notes', commitMode: 'versioned',
      requiredGates: ['producer', 'artifact_drafts'],
    },
  }),
  artifactGateIds: ['producer', 'artifact_drafts'],
  mandatoryArtifactGateIds: ['producer', 'artifact_drafts'],
  allowAdditionalArtifacts: false,
  gateBindings: [{
    id: 'artifact_drafts', kind: 'contract', handler: 'scenario', gateIds: [],
    retryProducer: 1, executionRetry: 0, feedback: 'messages',
  }],
}

const compliance: ScenarioDefinition = {
  id: COMPLIANCE_SCENARIO_ID,
  artifacts: () => ({
    compliance_bundle: {
      id: 'compliance_bundle', kind: 'json', draftPath: 'drafts/compliance_bundle.json',
      stream: 'compliance_bundles', commitMode: 'versioned',
      requiredGates: ['producer', 'artifact_drafts', 'human_approval'],
    },
  }),
  artifactGateIds: ['producer', 'artifact_drafts', 'human_approval'],
  mandatoryArtifactGateIds: ['producer', 'artifact_drafts', 'human_approval'],
  allowAdditionalArtifacts: false,
  gateBindings: [
    {
      id: 'artifact_drafts', kind: 'contract', handler: 'scenario', gateIds: [],
      retryProducer: 1, executionRetry: 0, feedback: 'messages',
    },
    {
      id: 'human_approval', kind: 'contract', handler: 'scenario', gateIds: [],
      retryProducer: 0, executionRetry: 0, feedback: 'messages',
    },
  ],
}

const DEFINITIONS = new Map([research, generic, release, compliance]
  .map(definition => [definition.id, definition]))

export function scenarioDefinition(id: string): ScenarioDefinition | undefined {
  return DEFINITIONS.get(id)
}

export function listScenarioDefinitions(): readonly ScenarioDefinition[] {
  return [...DEFINITIONS.values()]
}
