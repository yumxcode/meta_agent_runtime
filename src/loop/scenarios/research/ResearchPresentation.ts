import type { LoopInstance } from '../../instance/InstanceStore.js'
import type { ArtifactSpec } from '../../charter/CharterTypes.js'
import { renderRoute } from '../../types.js'
import { resolve } from 'path'
import { withFileLock } from '../../../infra/persist/index.js'
import { refreshArtifactCheckpoint } from '../../projection/ArtifactCheckpoint.js'

export function researchProducerOutputContract(
  draftsDir: string,
  artifacts: Record<string, ArtifactSpec>,
): string {
  const direction = resolve(draftsDir, '..', artifacts.direction?.draftPath ?? 'drafts/direction.json')
  const findings = resolve(draftsDir, '..', artifacts.finding?.draftPath ?? 'drafts/findings_draft.json')
  return `\
【产出契约（硬性）】
1. 选定本轮方向后，先写 ${direction}：{"key":"<方向短标识>","rationale":"一句话"}。
2. 完成工作后，把结构化 findings 草稿写入 ${findings}（数组，每条含 claim 与 evidence 字段）。
3. 最后必须调用 return_result，data 写 {"label":"ok"|"error","note":"一句话"}。
【路径硬性约定】跨轮共享状态只写上面这两个**绝对路径**草稿——入账由内核完成，你无权直接改 ledger/ 下任何文件；禁止写 .meta-agent/ 下任何路径。`
}

export function researchHarvestPreface(input: {
  selfTimer: boolean
  reason?: string
  submitSummary: string
  effect?: { verdict?: string; via?: string; data?: unknown }
}): string {
  if (input.selfTimer) {
    return [
      `【继续】已到你设定的时间（原因：${input.reason ?? '?'}）。`,
      `【提交段摘要】${input.submitSummary || '(无摘要)'}`,
      '请自行检查外部任务状态，决定：继续等待（再调 timer）还是收割（整理 findings/direction 草稿后 return_result data={"label":"ok"}）。',
    ].join('\n')
  }
  return [
    '【收割段】你（或你的前身）在本轮提交段启动了外部任务，现已结束。',
    `【提交段摘要】${input.submitSummary || '(无摘要)'}`,
    `【外部任务结果】verdict=${input.effect?.verdict ?? 'unknown'} via=${input.effect?.via ?? '?'}`,
    `【结果数据】${truncate(JSON.stringify(input.effect?.data ?? null), 3_000)}`,
    '请基于结果完成本轮剩余工作（整理 findings 草稿等），遵守产出契约。',
  ].join('\n')
}

export async function renderResearchReport(
  instance: LoopInstance,
  reason: string,
  narrative?: string,
): Promise<string> {
  const view = await instance.ledger.readView(50)
  const { checkpoint } = await withFileLock(
    instance.paths.artifactsJsonl,
    () => refreshArtifactCheckpoint(instance),
  )
  const findings = checkpoint.views['artifact-finding']
  const directions = checkpoint.views['artifact-direction']
  const lines = [
    `# Loop Report — ${instance.record.instanceId}`,
    '',
    `- reason: ${reason}`,
    `- rounds: ${view.progress.iteration}`,
    `- status: ${view.progress.status}`,
    `- objective_best (${instance.charter.metric?.direction ?? 'max'}): ${view.progress.objectiveBestValue ?? 'null'}`,
    `- total findings: ${findings?.count ?? 0}`,
    `- total cost: $${view.progress.totalCostUsd.toFixed(2)}`,
    ...(narrative ? ['', '## Narrative (finalizer seat)', '', narrative] : []),
    '',
    '## Rounds',
    ...view.lastRounds.map(round =>
      `- #${round.round} [${round.mode}] route=${renderRoute(round.route)} ` +
      `retries=${round.correctiveRetries} cost=$${round.costUsd.toFixed(2)}`),
    '',
    '## Directions tried',
    ...(directions?.items ?? []).map(item => `- ${JSON.stringify(item.content)}`),
    '',
    '## Findings',
    ...(findings?.items ?? []).map(item => `- ${JSON.stringify(item.content)}`),
    '',
    `Generated at ${new Date().toISOString()} from the ledger (code template).`,
  ]
  return lines.join('\n') + '\n'
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value
}
