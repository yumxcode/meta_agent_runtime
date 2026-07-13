import { readFile, rm } from 'fs/promises'
import { resolve } from 'path'
import { withFileLock } from '../../../infra/persist/index.js'
import {
  executeArtifactTransaction,
} from '../../artifacts/ArtifactExecutor.js'
import { makeArtifactProposal, type ArtifactGateResult } from '../../artifacts/ArtifactProtocol.js'
import type { ArtifactSpec } from '../../charter/CharterTypes.js'
import type { LoopInstance } from '../../instance/InstanceStore.js'
import { refreshArtifactCheckpoint } from '../../projection/ArtifactCheckpoint.js'
import { findCommittedArtifactTransaction } from '../../artifacts/ArtifactIndexes.js'
import type { ScenarioRuntime } from '../ScenarioRuntime.js'
import { GENERIC_SCENARIO_ID } from '../ScenarioDefinitions.js'

export interface GenericScenarioConfig {
  id: string
  outputInstructions?: string[]
  runGate?(instance: LoopInstance, gateId: string): Promise<{
    verdict: 'pass' | 'fail' | 'error'; messages: string[]
  } | null>
  prepareEventWait?: NonNullable<ScenarioRuntime['prepareEventWait']>
  artifactGate?(input: {
    instance: LoopInstance
    proposalId: string
    contentHash: string
    spec: ArtifactSpec
  }): Promise<ArtifactGateResult | null>
}

export function createGenericScenarioRuntime(config: GenericScenarioConfig): ScenarioRuntime {
  return {
  id: config.id,
  producerOutputContract: (draftsDir, artifacts) => genericOutputContract(
    draftsDir, artifacts, config.outputInstructions,
  ),
  ...(config.prepareEventWait ? { prepareEventWait: config.prepareEventWait } : {}),
  reconcileArtifacts: instance => withFileLock(
    instance.paths.artifactsJsonl,
    async () => { await refreshArtifactCheckpoint(instance) },
  ),
  runProducerGate: async (instance, gateId) => {
    if (gateId !== 'artifact_drafts') {
      return await config.runGate?.(instance, gateId) ?? {
        verdict: 'error', messages: [`Scenario '${config.id}' does not provide Gate '${gateId}'`],
      }
    }
    const drafts = await readGenericDrafts(instance)
    const messages = drafts.flatMap(draft => draft.error ? [`${draft.spec.id}: ${draft.error}`] : [])
    return { verdict: messages.length > 0 ? 'fail' : 'pass', messages }
  },
  commitArtifacts: async (instance, input) => withFileLock(instance.paths.artifactsJsonl, async () => {
    const before = await refreshArtifactCheckpoint(instance)
    const transactionId = `round:${input.round}`
    if (await findCommittedArtifactTransaction(instance, transactionId)) {
      await cleanupGenericDrafts(instance)
      return { legacyFindingDelta: 0 }
    }
    const drafts = await readGenericDrafts(instance)
    const proposals = drafts.filter(draft => draft.present).map(draft => makeArtifactProposal({
      proposalId: `round:${input.round}:${draft.spec.id}:0`,
      transactionId,
      artifactId: draft.spec.id,
      content: draft.content,
      draftPath: draft.spec.draftPath,
    }))
    const byArtifact = new Map(drafts.map(draft => [draft.spec.id, draft]))
    const additional = new Map<string, ArtifactGateResult[]>()
    if (config.artifactGate) {
      for (const proposal of proposals) {
        const spec = instance.charter.artifacts[proposal.artifactId]
        if (!spec) continue
        for (const gateId of spec.requiredGates) {
          if (gateId === 'producer' || gateId === 'artifact_drafts') continue
          const result = await config.artifactGate({
            instance, proposalId: proposal.proposalId,
            contentHash: proposal.contentHash, spec,
          })
          if (result) additional.set(proposal.proposalId, [
            ...(additional.get(proposal.proposalId) ?? []), result,
          ])
        }
      }
    }
    const result = await executeArtifactTransaction({
      transactionId: `round:${input.round}`,
      proposals,
      specs: instance.charter.artifacts,
      existingEvents: [],
      gateResults: (proposal, spec) => genericGateResults(
        proposal.proposalId,
        proposal.contentHash,
        spec,
        input.producerOk,
        byArtifact.get(spec.id)?.error,
        additional.get(proposal.proposalId) ?? [],
      ),
      append: event => instance.ledger.appendJsonl(instance.paths.artifactsJsonl, event),
    })
    await refreshArtifactCheckpoint(instance)
    await cleanupGenericDrafts(instance)
    // totalFindings is a legacy Research projection, never a generic Artifact count.
    return { legacyFindingDelta: 0 }
  }),
  harvestPreface: input => input.selfTimer
    ? [
        `【继续】已到你设定的时间（原因：${input.reason ?? '?'}）。`,
        `【提交段摘要】${input.submitSummary || '(无摘要)'}`,
        '请检查任务状态：仍需等待则再次调用 timer；可以收割则按产出契约返回结果。',
      ].join('\n')
    : [
        '【收割段】本轮外部任务现已结束。',
        `【提交段摘要】${input.submitSummary || '(无摘要)'}`,
        `【外部任务结果】verdict=${input.effect?.verdict ?? 'unknown'} via=${input.effect?.via ?? '?'}`,
        '请根据结果完成本轮工作并遵守产出契约。',
      ].join('\n'),
  renderReport: async (instance, reason, narrative) => {
    const progress = await instance.ledger.readProgress()
    const { checkpoint } = await withFileLock(
      instance.paths.artifactsJsonl,
      () => refreshArtifactCheckpoint(instance),
    )
    return [
      `# Loop Report — ${instance.record.instanceId}`,
      '',
      `- scenario: ${instance.charter.scenario}`,
      `- reason: ${reason}`,
      `- rounds: ${progress.iteration}`,
      `- status: ${progress.status}`,
      `- committed artifacts: ${Object.values(checkpoint.streamStates)
        .reduce((sum, state) => sum + state.logicalCount, 0)}`,
      `- total cost: $${progress.totalCostUsd.toFixed(2)}`,
      ...(narrative ? ['', '## Narrative', '', narrative] : []),
      '',
    ].join('\n')
  },
}
}

export const genericScenarioRuntime = createGenericScenarioRuntime({ id: GENERIC_SCENARIO_ID })

async function cleanupGenericDrafts(instance: LoopInstance): Promise<void> {
  await Promise.all(Object.values(instance.charter.artifacts).map(spec =>
    rm(resolve(instance.paths.root, spec.draftPath), { force: true })))
}

export interface GenericDraft {
  spec: ArtifactSpec
  present: boolean
  content: unknown
  error?: string
}

export async function readGenericDrafts(instance: LoopInstance): Promise<GenericDraft[]> {
  return Promise.all(Object.values(instance.charter.artifacts).map(async spec => {
    let raw: string
    try {
      raw = await readFile(resolve(instance.paths.root, spec.draftPath), 'utf-8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return code === 'ENOENT'
        ? { spec, present: false, content: null }
        : { spec, present: true, content: null, error: (error as Error).message }
    }
    if (spec.kind === 'text' || spec.kind === 'workspace_diff') {
      return { spec, present: true, content: raw }
    }
    try {
      return { spec, present: true, content: JSON.parse(raw) as unknown }
    } catch (error) {
      return { spec, present: true, content: raw, error: `invalid JSON: ${(error as Error).message}` }
    }
  }))
}

function genericGateResults(
  proposalId: string,
  contentHash: string,
  spec: ArtifactSpec,
  producerOk: boolean,
  draftError?: string,
  additional: ArtifactGateResult[] = [],
): ArtifactGateResult[] {
  const available: Record<string, ArtifactGateResult> = {
    producer: {
      proposalId, gateId: 'producer', verdict: producerOk ? 'pass' : 'fail',
      messages: producerOk ? [] : ['producer did not complete successfully'], evidence: [contentHash],
    },
    artifact_drafts: {
      proposalId, gateId: 'artifact_drafts', verdict: draftError ? 'error' : 'pass',
      messages: draftError ? [draftError] : [], evidence: [contentHash],
    },
  }
  for (const result of additional) available[result.gateId] = result
  return spec.requiredGates.map(gateId => available[gateId]!).filter(Boolean)
}

function genericOutputContract(
  draftsDir: string,
  artifacts: Record<string, ArtifactSpec>,
  instructions: string[] = [],
): string {
  const entries = Object.values(artifacts).map(spec =>
    `- ${spec.id} (${spec.kind}, ${spec.commitMode}) → ${resolve(draftsDir, '..', spec.draftPath)}`)
  return [
    '【产出契约（硬性）】',
    ...(entries.length > 0 ? ['本轮需要产出时，只写以下 Artifact 草稿：', ...entries] : [
      '本 Scenario 未声明 Artifact 草稿。',
    ]),
    '完成后必须调用 return_result，data 写 {"label":"ok"|"error","note":"一句话"}。',
    ...instructions,
    '禁止直接修改 ledger/；Artifact 的 Gate、提交与重放由内核完成。',
  ].join('\n')
}
