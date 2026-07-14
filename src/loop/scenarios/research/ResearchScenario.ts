import type { ScenarioRuntime } from '../ScenarioPlugin.js'
import { DEFAULT_SCENARIO_ID } from '../ScenarioDefinitions.js'
import { reconcileResearchArtifacts, runResearchProducerGate } from './ResearchArtifacts.js'
import {
  renderResearchReport,
  researchHarvestPreface,
  researchProducerOutputContract,
} from './ResearchPresentation.js'
import { researchPaths } from './ResearchPaths.js'

export const researchScenarioRuntime: ScenarioRuntime = {
  id: DEFAULT_SCENARIO_ID,
  buildCapsuleView: async ({ checkpoint }) => {
    const findings = checkpoint.views['artifact-finding']
    const directions = checkpoint.views['artifact-direction']
    const directionsTried = (directions?.items ?? []).map(item => {
      const direction = item.content
      return typeof direction === 'object' && direction !== null && 'key' in direction
        ? String((direction as { key: unknown }).key)
        : JSON.stringify(direction)
    })
    const recentFindings = (findings?.items ?? []).map(item => JSON.stringify(item.content))
    return {
      schemaVersion: 1,
      data: {
        totalFindings: findings?.count ?? 0,
        directionsTried,
        recentFindings,
      },
      sections: [
        { title: '已试方向（禁止重复）', items: directionsTried },
        { title: '近期 findings', items: recentFindings },
      ],
    }
  },
  judgeContractExtension: () => ({
    fields: ['accepted_finding_indexes'],
    instructions: [
      'accepted_finding_indexes 必须是 findings 草稿中通过 rubric 的零基索引数组。',
      'new_findings_count 必须等于 accepted_finding_indexes.length。',
    ],
  }),
  producerOutputContract: researchProducerOutputContract,
  reconcileReadModel: reconcileResearchArtifacts,
  runProducerGate: (instance, gateId) => gateId === 'direction_diversity'
    ? runResearchProducerGate(instance, gateId)
    : Promise.resolve({ verdict: 'error', messages: [`unsupported producer gate '${gateId}'`] }),
  artifactGate: async input => {
    if (input.gateId === 'judge' && input.spec.id === 'finding') {
      const accepted = input.judge?.data['accepted_finding_indexes']
      const match = input.proposalId.match(/:finding:(\d+)$/)
      const index = match ? Number(match[1]) : null
      const explicitlyAccepted = Array.isArray(accepted)
        ? index !== null && accepted.some(value => value === index)
        : input.artifactProposalCount === 1 ||
          input.judge?.data['new_findings_count'] === input.artifactProposalCount
      const verdict = !input.judgeRequired
        ? 'pass' as const
        : !input.judge || !input.judge.ok
          ? 'error' as const
          : input.judge.data['verdict'] === 'fail' || !explicitlyAccepted
            ? 'fail' as const
            : 'pass' as const
      const messages = Array.isArray(input.judge?.data['messages'])
        ? (input.judge!.data['messages'] as unknown[]).map(String)
        : []
      if (verdict === 'fail' && messages.length === 0) {
        messages.push(`finding proposal index ${index ?? '?'} was not accepted by the judge`)
      }
      return {
        proposalId: input.proposalId, gateId: input.gateId, verdict, messages,
        evidence: [input.contentHash],
      }
    }
    if (input.gateId === 'direction_diversity' && input.spec.id === 'direction') {
      const key = directionKey(input.content)
      const file = await input.instance.ledger.readJson<{ directions?: unknown[] }>(
        researchPaths(input.instance.paths).directionsJson,
      )
      const duplicate = key !== null && (file?.directions ?? []).some(direction => directionKey(direction) === key)
      return {
        proposalId: input.proposalId,
        gateId: input.gateId,
        verdict: key === null ? 'error' : duplicate ? 'fail' : 'pass',
        messages: key === null ? ['direction.key is required'] : duplicate ? [`direction '${key}' is duplicated`] : [],
        evidence: [input.contentHash],
      }
    }
    return null
  },
  harvestPreface: researchHarvestPreface,
  renderReport: renderResearchReport,
}

function directionKey(value: unknown): string | null {
  return typeof value === 'object' && value !== null &&
    typeof (value as { key?: unknown }).key === 'string'
    ? (value as { key: string }).key
    : null
}
