import { hashArtifactContent, type ArtifactGateResult } from '../../artifacts/ArtifactProtocol.js'
import { effectLedgerFor, readPendingRound } from '../../effects/WaitOps.js'
import type { LoopInstance } from '../../instance/InstanceStore.js'
import {
  COMPLIANCE_SCENARIO_ID,
  RELEASE_SCENARIO_ID,
} from '../ScenarioDefinitions.js'
import {
  createGenericScenarioRuntime,
  readGenericDrafts,
} from './GenericScenario.js'
import { EVENT_EFFECT_ADAPTER_ID } from '../../effects/EffectAdapter.js'

export const releaseScenarioRuntime = createGenericScenarioRuntime({
  id: RELEASE_SCENARIO_ID,
  outputInstructions: [
    'Release manifest 使用 replace 语义，release note 使用按内容去重的 versioned 语义。',
  ],
  buildCapsuleView: async (_instance, checkpoint) => {
    const manifest = checkpoint.views['artifact-release_manifest']?.items.at(-1)?.content ?? null
    const notes = checkpoint.views['artifact-release_note']?.items.map(item => String(item.content)) ?? []
    return {
      schemaVersion: 1,
      data: { currentManifest: asJson(manifest), recentReleaseNotes: notes },
      sections: [
        { title: 'Current release manifest', items: manifest === null ? [] : [JSON.stringify(manifest)] },
        { title: 'Recent release notes', items: notes },
      ],
    }
  },
})

export const complianceScenarioRuntime = createGenericScenarioRuntime({
  id: COMPLIANCE_SCENARIO_ID,
  outputInstructions: [
    'Compliance bundle 必须经过人工批准：写好草稿后以 label:"wait" 返回；',
    'runtime 会根据草稿 hash 生成审批 effectKey，禁止自行决定或伪造批准结果。',
  ],
  buildCapsuleView: async (instance, checkpoint) => {
    const bundle = checkpoint.views['artifact-compliance_bundle']?.items.at(-1)
    const pending = await readPendingRound(instance)
    const effect = pending?.effectKey ? await effectLedgerFor(instance).get(pending.effectKey) : null
    return {
      schemaVersion: 1,
      data: {
        bundleHash: bundle?.contentHash ?? null,
        approvalStatus: effect?.status ?? 'not_requested',
        approvalVerdict: effect?.outcome?.verdict ?? null,
      },
      sections: [{
        title: 'Compliance approval',
        items: [`status=${effect?.status ?? 'not_requested'} verdict=${effect?.outcome?.verdict ?? 'none'}`],
      }],
    }
  },
  prepareEventWait: async (instance, input) => {
    const draft = await complianceDraft(instance)
    if (!draft.present || draft.error) {
      throw new Error(`Compliance approval wait requires a valid compliance_bundle draft`)
    }
    const contentHash = hashArtifactContent(draft.content)
    return {
      effectKey: `human-approval:${instance.record.instanceId}:round:${input.round}`,
      adapterId: EVENT_EFFECT_ADAPTER_ID,
      authRequired: true,
      maxWaitMs: input.maxWaitMs,
      payload: {
        protocol: 'builtin/human-artifact-approval@1',
        scenario: COMPLIANCE_SCENARIO_ID,
        round: input.round,
        artifactId: draft.spec.id,
        contentHash,
      },
    }
  },
  runGate: async (instance, gateId) => {
    if (gateId !== 'human_approval') return null
    const approval = await readHumanApproval(instance)
    return { verdict: approval.verdict, messages: approval.messages }
  },
  artifactGate: async ({ instance, proposalId, contentHash, spec }) => {
    if (!spec.requiredGates.includes('human_approval')) return null
    const approval = await readHumanApproval(instance, contentHash)
    return {
      proposalId,
      gateId: 'human_approval',
      verdict: approval.verdict,
      messages: approval.messages,
      evidence: [contentHash, ...(approval.effectKey ? [approval.effectKey] : [])],
    } satisfies ArtifactGateResult
  },
})

function asJson(value: unknown): import('../ScenarioPlugin.js').ScenarioJson {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value)) as import('../ScenarioPlugin.js').ScenarioJson
}

async function complianceDraft(instance: LoopInstance) {
  const drafts = await readGenericDrafts(instance)
  const draft = drafts.find(candidate => candidate.spec.id === 'compliance_bundle')
  if (!draft) throw new Error(`Compliance Scenario is missing its frozen compliance_bundle ArtifactSpec`)
  return draft
}

async function readHumanApproval(
  instance: LoopInstance,
  expectedContentHash?: string,
): Promise<{
  verdict: 'pass' | 'fail' | 'error'
  messages: string[]
  effectKey?: string
}> {
  const pending = await readPendingRound(instance)
  if (!pending || pending.kind !== 'effect' || !pending.effectKey?.startsWith('human-approval:')) {
    return { verdict: 'error', messages: ['compliance bundle has no bound human approval request'] }
  }
  const effect = await effectLedgerFor(instance).get(pending.effectKey)
  if (!effect || effect.status !== 'concluded' || !effect.outcome) {
    return {
      verdict: 'error', effectKey: pending.effectKey,
      messages: ['human approval effect is not concluded'],
    }
  }
  const draft = await complianceDraft(instance)
  if (!draft.present || draft.error) {
    return { verdict: 'error', effectKey: pending.effectKey, messages: ['approved draft is missing or invalid'] }
  }
  const contentHash = hashArtifactContent(draft.content)
  const requestedHash = typeof effect.payload?.['contentHash'] === 'string'
    ? effect.payload['contentHash'] : null
  const outcomeData = isRecord(effect.outcome.data) ? effect.outcome.data : {}
  const auth = isRecord(outcomeData['_auth']) ? outcomeData['_auth'] : {}
  const principal = typeof auth['principal'] === 'string' ? auth['principal'] : null
  const roles = Array.isArray(auth['roles']) ? auth['roles'] : []
  if (!principal || !roles.includes('approver')) {
    return {
      verdict: 'fail', effectKey: pending.effectKey,
      messages: ['approval is not authenticated as a principal with the approver role'],
    }
  }
  const approvedHash = typeof outcomeData['contentHash'] === 'string' ? outcomeData['contentHash'] : null
  if (expectedContentHash && expectedContentHash !== contentHash) {
    return { verdict: 'error', effectKey: pending.effectKey, messages: ['proposal changed after Gate evaluation'] }
  }
  if (requestedHash !== contentHash || approvedHash !== contentHash) {
    return {
      verdict: 'fail', effectKey: pending.effectKey,
      messages: ['approval contentHash does not match the current compliance bundle'],
    }
  }
  if (effect.outcome.verdict !== 'approved') {
    return {
      verdict: 'fail', effectKey: pending.effectKey,
      messages: [`human approval returned '${effect.outcome.verdict}'`],
    }
  }
  return { verdict: 'pass', messages: [], effectKey: pending.effectKey }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
