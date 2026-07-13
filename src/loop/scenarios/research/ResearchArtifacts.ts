import { readFile, rm, stat } from 'fs/promises'
import { resolve } from 'path'
import { atomicWriteFile, atomicWriteJson, withFileLock } from '../../../infra/persist/index.js'
import type { LoopInstance } from '../../instance/InstanceStore.js'
import {
  makeArtifactProposal,
  hashArtifactContent,
  type ArtifactDecision,
  type ArtifactGateResult,
  type ArtifactProposal,
  type ArtifactSpec,
} from '../../artifacts/ArtifactProtocol.js'
import {
  executeArtifactTransaction,
  type ArtifactLedgerEvent,
} from '../../artifacts/ArtifactExecutor.js'
import { refreshArtifactCheckpoint } from '../../projection/ArtifactCheckpoint.js'
import { readArtifactJournal } from '../../artifacts/ArtifactSegmentStore.js'
import { findCommittedArtifactTransaction } from '../../artifacts/ArtifactIndexes.js'

interface ResearchJudgeResult {
  ok: boolean
  data: Record<string, unknown>
}

type ResearchArtifactEvent =
  | { type: 'artifact.baseline'; findings: unknown[]; directions: unknown[]; at: number }
  | ArtifactLedgerEvent

export interface ResearchArtifactCommitResult {
  transactionId: string
  committed: Record<'finding' | 'direction', number>
  /** Compatibility progress delta consumed by the generic round accounting. */
  admittedItems: number
  rejected: number
}

export interface ResearchProducerGateOutcome {
  verdict: 'pass' | 'fail' | 'error'
  messages: string[]
}

interface ResearchProjectionIndex {
  schemaVersion: '1.0'
  authorityEventCount: number
  lastTransactionId?: string
  lastSummary?: ResearchArtifactCommitResult
  findingsCount: number
  findingsBytes: number
  directions: unknown[]
  directionsHash: string
  updatedAt: number
}

/** Repair legacy projections from the append-only Artifact authority. */
export async function reconcileResearchArtifacts(instance: LoopInstance): Promise<void> {
  await withFileLock(instance.paths.artifactsJsonl, async () => {
    const events = await ensureBaseline(instance, await readAllEvents(instance))
    const checkpoint = await refreshArtifactCheckpoint(instance)
    await projectResearchArtifacts(instance, events, checkpoint.checkpoint.eventCount)
  })
}

export async function commitResearchArtifacts(
  instance: LoopInstance,
  input: {
    round: number
    producerOk: boolean
    judgeRequired: boolean
    judge: ResearchJudgeResult | null
  },
): Promise<ResearchArtifactCommitResult> {
  const transactionId = `round:${input.round}`
  return withFileLock(instance.paths.artifactsJsonl, async () => {
    let checkpoint = await refreshArtifactCheckpoint(instance)
    const indexedTransaction = await findCommittedArtifactTransaction(instance, transactionId)
    let index = await readUsableProjectionIndex(instance, checkpoint.checkpoint.eventCount)
    let events: ResearchArtifactEvent[] = []
    if (!index) {
      events = await ensureBaseline(instance, await readAllEvents(instance))
      checkpoint = await refreshArtifactCheckpoint(instance)
      await projectResearchArtifacts(instance, events, checkpoint.checkpoint.eventCount)
      index = await readUsableProjectionIndex(instance, checkpoint.checkpoint.eventCount)
    }
    if (!index) throw new Error('Research compatibility projection could not be rebuilt')
    if (indexedTransaction) {
      await cleanupDrafts(instance)
      return summarize(indexedTransaction.transactionId, indexedTransaction.decisions)
    }
    const proposals = await readResearchProposals(instance, transactionId)
    const committedDirections = index.directions
    const specs = researchArtifactSpecs(instance)
    const transaction = await executeArtifactTransaction({
      transactionId,
      proposals,
      specs,
      existingEvents: [],
      gateResults: (proposal, spec) => gateResults(spec, proposal, input, committedDirections),
      append: async event => {
        await instance.ledger.appendJsonl(instance.paths.artifactsJsonl, event)
      },
    })
    const summary = summarize(transaction.transactionId, transaction.decisions)
    checkpoint = await refreshArtifactCheckpoint(instance)
    await appendResearchProjectionDelta(
      instance, index, transaction.decisions, checkpoint.checkpoint.eventCount, summary,
    )
    await cleanupDrafts(instance)
    return summary
  })
}

export async function runResearchProducerGate(
  instance: LoopInstance,
  gateId: 'direction_diversity',
): Promise<ResearchProducerGateOutcome> {
  if (gateId !== 'direction_diversity') {
    return { verdict: 'error', messages: [`unsupported Research producer gate '${gateId}'`] }
  }
  try {
    const draft = JSON.parse(
      await readFile(artifactDraftPath(instance, researchArtifactSpecs(instance).direction), 'utf-8'),
    ) as { key?: unknown }
    if (typeof draft.key !== 'string' || !draft.key) return { verdict: 'pass', messages: [] }
    const file = await instance.ledger.readJson<{ directions: unknown[] }>(instance.paths.directionsJson)
    return (file?.directions ?? []).some(direction => directionKey(direction) === draft.key)
      ? {
          verdict: 'fail',
          messages: [`你选择的方向 '${draft.key}' 与 directions_tried 完全重复。请换一个未出现在已试清单中的方向。`],
        }
      : { verdict: 'pass', messages: [] }
  } catch {
    // A missing direction draft remains compatible with analysis-only rounds;
    // malformed content is rejected later by the Artifact gate.
    return { verdict: 'pass', messages: [] }
  }
}

async function readAllEvents(instance: LoopInstance): Promise<ResearchArtifactEvent[]> {
  return (await readArtifactJournal(instance)).events as ResearchArtifactEvent[]
}

async function ensureBaseline(
  instance: LoopInstance,
  events: ResearchArtifactEvent[],
): Promise<ResearchArtifactEvent[]> {
  if (events.some(event => event.type === 'artifact.baseline')) return events
  const findings = await instance.ledger.readJsonl(instance.paths.findingsJsonl)
  const directionsFile = await instance.ledger.readJson<{ directions?: unknown[] }>(instance.paths.directionsJson)
  const baseline: ResearchArtifactEvent = {
    type: 'artifact.baseline', findings, directions: directionsFile?.directions ?? [], at: Date.now(),
  }
  await instance.ledger.appendJsonl(instance.paths.artifactsJsonl, baseline)
  return [baseline, ...events]
}

async function readResearchProposals(
  instance: LoopInstance,
  transactionId: string,
): Promise<ArtifactProposal[]> {
  const proposals: ArtifactProposal[] = []
  const specs = researchArtifactSpecs(instance)
  try {
    const parsed = JSON.parse(
      await readFile(artifactDraftPath(instance, specs.finding), 'utf-8'),
    ) as unknown
    const findings = Array.isArray(parsed) ? parsed : [parsed]
    findings.forEach((content, index) => proposals.push(makeArtifactProposal({
      proposalId: `${transactionId}:finding:${index}`,
      transactionId,
      artifactId: 'finding',
      content,
      draftPath: specs.finding.draftPath,
    })))
  } catch { /* zero findings or malformed draft: no proposal */ }
  try {
    const content = JSON.parse(
      await readFile(artifactDraftPath(instance, specs.direction), 'utf-8'),
    ) as unknown
    proposals.push(makeArtifactProposal({
      proposalId: `${transactionId}:direction:0`,
      transactionId,
      artifactId: 'direction',
      content,
      draftPath: specs.direction.draftPath,
    }))
  } catch { /* no direction proposal */ }
  return proposals
}

function gateResults(
  spec: ArtifactSpec,
  proposal: ArtifactProposal,
  input: { producerOk: boolean; judgeRequired: boolean; judge: ResearchJudgeResult | null },
  committedDirections: unknown[],
): ArtifactGateResult[] {
  const results: ArtifactGateResult[] = [{
    proposalId: proposal.proposalId,
    gateId: 'producer',
    verdict: input.producerOk ? 'pass' : 'fail',
    messages: input.producerOk ? [] : ['producer did not complete successfully'],
    evidence: [proposal.contentHash],
  }]
  if (spec.id === 'finding' && spec.requiredGates.includes('judge')) {
    const verdict: ArtifactGateResult['verdict'] = !input.judgeRequired
      ? 'pass'
      : !input.judge || !input.judge.ok
        ? 'error'
        : input.judge.data['verdict'] === 'fail'
          ? 'fail'
          : 'pass'
    results.push({
      proposalId: proposal.proposalId, gateId: 'judge', verdict,
      messages: Array.isArray(input.judge?.data['messages'])
        ? (input.judge!.data['messages'] as unknown[]).map(String)
        : [],
      evidence: [proposal.contentHash],
    })
  } else if (spec.id === 'direction' && spec.requiredGates.includes('direction_diversity')) {
    const key = directionKey(proposal.content)
    const duplicate = key !== null && committedDirections.some(direction => directionKey(direction) === key)
    results.push({
      proposalId: proposal.proposalId,
      gateId: 'direction_diversity',
      verdict: key === null ? 'error' : duplicate ? 'fail' : 'pass',
      messages: key === null ? ['direction.key is required'] : duplicate ? [`direction '${key}' is duplicated`] : [],
      evidence: [proposal.contentHash],
    })
  }
  return results
}

async function projectResearchArtifacts(
  instance: LoopInstance,
  events: ResearchArtifactEvent[],
  authorityEventCount: number,
): Promise<void> {
  const projection = materialize(events)
  if (projection.findings.length > 0) {
    await atomicWriteFile(
      instance.paths.findingsJsonl,
      projection.findings.map(finding => JSON.stringify(finding)).join('\n') + '\n',
    )
  } else {
    await rm(instance.paths.findingsJsonl, { force: true }).catch(() => undefined)
  }
  await atomicWriteJson(instance.paths.directionsJson, { directions: projection.directions })
  await writeProjectionIndex(instance, {
    schemaVersion: '1.0',
    authorityEventCount,
    lastTransactionId: lastCommittedEvent(events)?.transactionId,
    lastSummary: lastCommittedEvent(events)
      ? summarize(lastCommittedEvent(events)!.transactionId, lastCommittedEvent(events)!.decisions)
      : undefined,
    findingsCount: projection.findings.length,
    findingsBytes: await fileBytes(instance.paths.findingsJsonl),
    directions: projection.directions,
    directionsHash: hashArtifactContent(projection.directions),
    updatedAt: Date.now(),
  })
}

async function appendResearchProjectionDelta(
  instance: LoopInstance,
  previous: ResearchProjectionIndex,
  decisions: ArtifactDecision[],
  authorityEventCount: number,
  summary: ResearchArtifactCommitResult,
): Promise<void> {
  const findings = decisions.filter(decision =>
    decision.verdict === 'committed' && decision.proposal.artifactId === 'finding')
  for (const decision of findings) {
    await instance.ledger.appendJsonl(instance.paths.findingsJsonl, decision.proposal.content)
  }
  const directions = [...previous.directions]
  for (const decision of decisions) {
    if (decision.verdict !== 'committed' || decision.proposal.artifactId !== 'direction') continue
    const key = directionKey(decision.proposal.content)
    if (key !== null && !directions.some(direction => directionKey(direction) === key)) {
      directions.push(decision.proposal.content)
    }
  }
  await atomicWriteJson(instance.paths.directionsJson, { directions })
  await writeProjectionIndex(instance, {
    schemaVersion: '1.0', authorityEventCount,
    lastTransactionId: summary.transactionId, lastSummary: summary,
    findingsCount: previous.findingsCount + findings.length,
    findingsBytes: await fileBytes(instance.paths.findingsJsonl),
    directions,
    directionsHash: hashArtifactContent(directions),
    updatedAt: Date.now(),
  })
}

async function readUsableProjectionIndex(
  instance: LoopInstance,
  authorityEventCount: number,
): Promise<ResearchProjectionIndex | null> {
  const index = await instance.ledger.readJson<ResearchProjectionIndex>(instance.paths.researchProjectionIndexJson)
  if (!index || index.schemaVersion !== '1.0' || index.authorityEventCount !== authorityEventCount ||
      !Number.isInteger(index.findingsCount) || index.findingsCount < 0 ||
      !Array.isArray(index.directions) || index.directionsHash !== hashArtifactContent(index.directions)) return null
  if (await fileBytes(instance.paths.findingsJsonl) !== index.findingsBytes) return null
  const file = await instance.ledger.readJson<{ directions?: unknown[] }>(instance.paths.directionsJson)
  if (hashArtifactContent(file?.directions ?? []) !== index.directionsHash) return null
  return index
}

async function writeProjectionIndex(
  instance: LoopInstance,
  index: ResearchProjectionIndex,
): Promise<void> {
  await atomicWriteJson(instance.paths.researchProjectionIndexJson, index)
}

async function fileBytes(path: string): Promise<number> {
  try { return (await stat(path)).size } catch { return 0 }
}

function lastCommittedEvent(events: ResearchArtifactEvent[]): Extract<ArtifactLedgerEvent, {
  type: 'artifact.transaction_committed'
}> | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type === 'artifact.transaction_committed') return event
  }
  return undefined
}

function materialize(events: ResearchArtifactEvent[]): { findings: unknown[]; directions: unknown[] } {
  const baseline = events.find(event => event.type === 'artifact.baseline')
  const findings = baseline?.type === 'artifact.baseline' ? [...baseline.findings] : []
  const directions = baseline?.type === 'artifact.baseline' ? [...baseline.directions] : []
  const seenTransactions = new Set<string>()
  for (const event of events) {
    if (event.type !== 'artifact.transaction_committed' || seenTransactions.has(event.transactionId)) continue
    seenTransactions.add(event.transactionId)
    for (const decision of event.decisions) {
      if (decision.verdict !== 'committed') continue
      if (decision.proposal.artifactId === 'finding') findings.push(decision.proposal.content)
      if (decision.proposal.artifactId === 'direction') {
        const key = directionKey(decision.proposal.content)
        if (key !== null && !directions.some(direction => directionKey(direction) === key)) {
          directions.push(decision.proposal.content)
        }
      }
    }
  }
  return { findings, directions }
}

function summarize(transactionId: string, decisions: ArtifactDecision[]): ResearchArtifactCommitResult {
  const finding = decisions.filter(decision =>
    decision.verdict === 'committed' && decision.proposal.artifactId === 'finding').length
  const direction = decisions.filter(decision =>
    decision.verdict === 'committed' && decision.proposal.artifactId === 'direction').length
  return {
    transactionId,
    committed: {
      finding,
      direction,
    },
    admittedItems: finding,
    rejected: decisions.filter(decision => decision.verdict === 'rejected').length,
  }
}

async function cleanupDrafts(instance: LoopInstance): Promise<void> {
  const specs = researchArtifactSpecs(instance)
  await Promise.all([
    rm(artifactDraftPath(instance, specs.finding), { force: true }),
    rm(artifactDraftPath(instance, specs.direction), { force: true }),
  ]).catch(() => undefined)
}

function researchArtifactSpecs(
  instance: LoopInstance,
): Record<'finding' | 'direction', ArtifactSpec> {
  const finding = instance.charter.artifacts.finding
  const direction = instance.charter.artifacts.direction
  if (!finding || !direction) {
    throw new Error(`Research Scenario requires frozen 'finding' and 'direction' ArtifactSpec entries`)
  }
  return { finding, direction }
}

function artifactDraftPath(instance: LoopInstance, spec: ArtifactSpec): string {
  return resolve(instance.paths.root, spec.draftPath)
}

function directionKey(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const key = (value as { key?: unknown }).key
  return typeof key === 'string' && key ? key : null
}
