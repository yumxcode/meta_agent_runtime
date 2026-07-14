import { resolve } from 'path'
import { withFileLock } from '../../../infra/persist/index.js'
import { type ArtifactGateResult } from '../../artifacts/ArtifactProtocol.js'
import type { ArtifactSpec } from '../../charter/CharterTypes.js'
import type { LoopInstance } from '../../instance/InstanceStore.js'
import { refreshArtifactCheckpoint } from '../../projection/ArtifactCheckpoint.js'
import type { ScenarioRuntime } from '../ScenarioPlugin.js'
import type { ScenarioCapsuleView, ScenarioJson } from '../ScenarioPlugin.js'
import type { ArtifactCheckpoint } from '../../projection/ArtifactCheckpoint.js'
import { GENERIC_SCENARIO_ID } from '../ScenarioDefinitions.js'
import { readBoundedArtifactText } from '../../artifacts/ArtifactIo.js'

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
  buildCapsuleView?(instance: LoopInstance, checkpoint: ArtifactCheckpoint): Promise<ScenarioCapsuleView>
}

export function createGenericScenarioRuntime(config: GenericScenarioConfig): ScenarioRuntime {
  return {
  id: config.id,
  buildCapsuleView: async ({ instance, checkpoint }) => config.buildCapsuleView?.(instance, checkpoint) ?? ({
    schemaVersion: 1,
    data: toScenarioJson({ projections: checkpoint.views, streams: checkpoint.streamStates }),
    sections: Object.entries(checkpoint.views).map(([id, view]) => ({
      title: id,
      items: view.items.map(item => JSON.stringify(item.content)),
    })),
  }),
  producerOutputContract: (draftsDir, artifacts) => genericOutputContract(
    draftsDir, artifacts, config.outputInstructions,
  ),
  ...(config.prepareEventWait ? { prepareEventWait: config.prepareEventWait } : {}),
  artifactGate: async ({ instance, proposalId, contentHash, spec, gateId }) => {
    if (!config.artifactGate || !spec.requiredGates.includes(gateId)) return null
    return config.artifactGate({ instance, proposalId, contentHash, spec })
  },
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

function toScenarioJson(value: unknown): ScenarioJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(toScenarioJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, toScenarioJson(child)]))
  }
  return String(value)
}
}

export const genericScenarioRuntime = createGenericScenarioRuntime({ id: GENERIC_SCENARIO_ID })

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
      raw = (await readBoundedArtifactText(resolve(instance.paths.root, spec.draftPath))).text
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return code === 'ENOENT'
        ? {
            spec, present: false, content: null,
            ...(spec.draft?.requirement === 'each_round'
              ? { error: 'required Artifact draft is missing' }
              : {}),
          }
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

function genericOutputContract(
  draftsDir: string,
  artifacts: Record<string, ArtifactSpec>,
  instructions: string[] = [],
): string {
  const entries = Object.values(artifacts).map(spec =>
    `- ${spec.id} (${spec.kind}, ${spec.commitMode}, ` +
      `${spec.draft?.requirement ?? 'optional'}) → ${resolve(draftsDir, '..', spec.draftPath)}`)
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
