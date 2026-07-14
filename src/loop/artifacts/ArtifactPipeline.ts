import { rm } from 'fs/promises'
import { resolve } from 'path'
import { withFileLock } from '../../infra/persist/index.js'
import type { ArtifactSpec } from '../charter/CharterTypes.js'
import type { LoopInstance } from '../instance/InstanceStore.js'
import { refreshArtifactCheckpoint } from '../projection/ArtifactCheckpoint.js'
import type { ArtifactCheckpoint } from '../projection/ArtifactCheckpoint.js'
import { executeArtifactTransaction, type ArtifactTransactionResult } from './ArtifactExecutor.js'
import { findCommittedArtifactTransaction } from './ArtifactIndexes.js'
import {
  makeArtifactProposal,
  type ArtifactGateResult,
  type ArtifactProposal,
} from './ArtifactProtocol.js'
import {
  MAX_ARTIFACT_DRAFT_TOTAL_BYTES,
  readBoundedArtifactText,
} from './ArtifactIo.js'
import { runScenarioHook } from '../scenarios/ScenarioHost.js'

export interface DraftRead {
  spec: ArtifactSpec
  present: boolean
  contents: unknown[]
  error?: string
}

export interface ArtifactPipelineResult {
  transaction: ArtifactTransactionResult
  obligationErrors: string[]
  checkpoint: ArtifactCheckpoint
  finalizationErrors: string[]
}

/**
 * The one generic Artifact commit path. Scenario code may provide individual
 * gate verdicts, but cannot append journal events or decide transaction order.
 */
export async function commitRoundArtifacts(
  instance: LoopInstance,
  input: {
    round: number
    producerOk: boolean
    judgeRequired: boolean
    judge: { ok: boolean; data: Record<string, unknown> } | null
    /** Wake/lease fencing assertion supplied by the Kernel. */
    assertAuthority?: () => Promise<void>
  },
): Promise<ArtifactPipelineResult> {
  const runtime = instance.scenarios.runtime(instance.charter.scenario)
  const transactionId = `round:${input.round}`
  // Read and validate drafts, including plugin hooks, before acquiring the
  // journal lock. A slow plugin must never make a healthy writer's lock look
  // stale and allow a second Artifact transaction into the critical section.
  const drafts = await readArtifactDrafts(instance)
  const obligationErrors = drafts.flatMap(draft => {
    if (draft.error) return [`${draft.spec.id}: ${draft.error}`]
    if (draft.spec.draft?.requirement === 'each_round' && draft.contents.length === 0) {
      return [`${draft.spec.id}: required Artifact draft is missing or empty`]
    }
    return []
  })
  const proposals = drafts.flatMap(draft => draft.contents.map((content, index) =>
    makeArtifactProposal({
      proposalId: `${transactionId}:${draft.spec.id}:${index}`,
      transactionId,
      artifactId: draft.spec.id,
      content,
      draftPath: draft.spec.draftPath,
    })))
  const byArtifact = new Map(drafts.map(draft => [draft.spec.id, draft]))
  const proposalCounts = new Map<string, number>()
  for (const proposal of proposals) {
    proposalCounts.set(proposal.artifactId, (proposalCounts.get(proposal.artifactId) ?? 0) + 1)
  }
  const gateResults = new Map<string, ArtifactGateResult[]>()
  for (const proposal of proposals) {
    const spec = instance.charter.artifacts[proposal.artifactId]
    if (!spec) continue
    const results: ArtifactGateResult[] = []
    for (const gateId of spec.requiredGates) {
      const builtIn = gateId === 'judge' ? null : kernelGate(
        proposal,
        gateId,
        input,
        byArtifact.get(spec.id)?.error,
      )
      if (builtIn) {
        results.push(builtIn)
        continue
      }
      const scenarioResult = runtime.artifactGate
        ? await runScenarioHook({
            scenarioId: runtime.id,
            hook: 'artifactGate',
            invoke: signal => runtime.artifactGate!({
              instance,
              proposalId: proposal.proposalId,
              contentHash: proposal.contentHash,
              content: proposal.content,
              spec,
              gateId,
              judgeRequired: input.judgeRequired,
              judge: input.judge,
              artifactProposalCount: proposalCounts.get(proposal.artifactId) ?? 0,
              signal,
            }),
            validate: value => value === null || (
              typeof value === 'object' && value !== null &&
              ['pass', 'fail', 'error'].includes(value.verdict) &&
              Array.isArray(value.messages)
            ) ? [] : ['expected null or an ArtifactGateResult'],
          })
        : null
      if (scenarioResult) {
        results.push(scenarioResult)
        continue
      }
      const fallback = kernelGate(proposal, gateId, input, byArtifact.get(spec.id)?.error)
      if (fallback) results.push(fallback)
    }
    gateResults.set(proposal.proposalId, results)
  }

  const result = await withFileLock(instance.paths.artifactsJsonl, async () => {
    await input.assertAuthority?.()
    // Recover a transaction committed before its checkpoint write, then make
    // the transaction-id check and append under the same lock.
    await refreshArtifactCheckpoint(instance)
    const existing = await findCommittedArtifactTransaction(instance, transactionId)
    if (existing) {
      return {
        transaction: {
          transactionId,
          decisions: existing.decisions,
          alreadyCommitted: true,
        },
        // Replays must re-route IDENTICALLY: the first attempt's obligation
        // failures were persisted below (drafts are deleted after commit, so
        // they cannot be recomputed). Without this, a crash between Artifact
        // commit and Round append silently turned an escalate into continue.
        obligationErrors: await readTransactionObligations(instance, transactionId),
      }
    }
    await input.assertAuthority?.()
    // Persist obligation failures BEFORE the transaction commits, idempotently
    // keyed by transactionId, so every replay observes the same route input.
    if (obligationErrors.length > 0) {
      await recordTransactionObligations(instance, transactionId, obligationErrors)
    }
    const transaction = await executeArtifactTransaction({
      transactionId,
      proposals,
      specs: instance.charter.artifacts,
      existingEvents: [],
      gateResults: proposal => gateResults.get(proposal.proposalId) ?? [],
      append: event => instance.ledger.appendJsonl(instance.paths.artifactsJsonl, event),
    })
    await refreshArtifactCheckpoint(instance)
    return { transaction, obligationErrors }
  })
  await cleanupDrafts(instance)

  // Compatibility projections and Scenario-owned read models are rebuilt only
  // after the generic transaction is durable and outside its file lock.
  if (runtime.reconcileReadModel) {
    await runScenarioHook({
      scenarioId: runtime.id,
      hook: 'reconcileReadModel',
      invoke: signal => runtime.reconcileReadModel!(instance, signal),
    })
  }
  const { checkpoint } = await withFileLock(
    instance.paths.artifactsJsonl,
    () => refreshArtifactCheckpoint(instance),
  )
  const finalizationErrors = Object.values(instance.charter.artifacts).flatMap(spec =>
    spec.draft?.requirement === 'on_finalize' &&
      (checkpoint.streamStates[spec.stream]?.logicalCount ?? 0) === 0
      ? [`${spec.id}: at least one committed Artifact is required before finalize`]
      : [])
  return { ...result, checkpoint, finalizationErrors }
}

interface ObligationRecord {
  transactionId: string
  errors: string[]
  at: number
}

/** Read the persisted obligation failures for one transaction (replay path). */
export async function readTransactionObligations(
  instance: LoopInstance,
  transactionId: string,
): Promise<string[]> {
  const records = await instance.ledger.readJsonl<ObligationRecord>(
    instance.paths.artifactsObligationsJsonl,
  )
  return records.find(record => record.transactionId === transactionId)?.errors ?? []
}

async function recordTransactionObligations(
  instance: LoopInstance,
  transactionId: string,
  errors: string[],
): Promise<void> {
  const existing = await readTransactionObligations(instance, transactionId)
  if (existing.length > 0) return // idempotent under the artifacts lock
  await instance.ledger.appendJsonl(instance.paths.artifactsObligationsJsonl, {
    transactionId, errors, at: Date.now(),
  } satisfies ObligationRecord)
}

export async function readArtifactDrafts(instance: LoopInstance): Promise<DraftRead[]> {
  const drafts: DraftRead[] = []
  let totalBytes = 0
  for (const spec of Object.values(instance.charter.artifacts)) {
    let raw: string
    try {
      const bounded = await readBoundedArtifactText(resolve(instance.paths.root, spec.draftPath))
      raw = bounded.text
      totalBytes += bounded.bytes
      if (totalBytes > MAX_ARTIFACT_DRAFT_TOTAL_BYTES) {
        drafts.push({
          spec, present: true, contents: [],
          error: `total Artifact drafts exceed ${MAX_ARTIFACT_DRAFT_TOTAL_BYTES} bytes`,
        })
        continue
      }
    } catch (error) {
      drafts.push((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { spec, present: false, contents: [] }
        : { spec, present: false, contents: [], error: (error as Error).message })
      continue
    }
    let content: unknown
    if (spec.kind === 'text' || spec.kind === 'workspace_diff') {
      content = raw
    } else {
      try {
        content = JSON.parse(raw) as unknown
      } catch (error) {
        drafts.push({
          spec, present: true, contents: [],
          error: `invalid JSON: ${(error as Error).message}`,
        })
        continue
      }
    }
    if (spec.draft?.cardinality === 'many') {
      if (!Array.isArray(content)) {
        drafts.push({ spec, present: true, contents: [], error: 'draft must be a JSON array' })
        continue
      }
      drafts.push({ spec, present: true, contents: content })
      continue
    }
    drafts.push({ spec, present: true, contents: [content] })
  }
  return drafts
}

function kernelGate(
  proposal: ArtifactProposal,
  gateId: string,
  input: {
    producerOk: boolean
    judgeRequired: boolean
    judge: { ok: boolean; data: Record<string, unknown> } | null
  },
  draftError?: string,
): ArtifactGateResult | null {
  if (gateId === 'producer') {
    return {
      proposalId: proposal.proposalId,
      gateId,
      verdict: input.producerOk ? 'pass' : 'fail',
      messages: input.producerOk ? [] : ['producer did not complete successfully'],
      evidence: [proposal.contentHash],
    }
  }
  if (gateId === 'artifact_drafts') {
    return {
      proposalId: proposal.proposalId,
      gateId,
      verdict: draftError ? 'error' : 'pass',
      messages: draftError ? [draftError] : [],
      evidence: [proposal.contentHash],
    }
  }
  if (gateId === 'judge') {
    const verdict: ArtifactGateResult['verdict'] = !input.judgeRequired
      ? 'pass'
      : !input.judge || !input.judge.ok
        ? 'error'
        : input.judge.data['verdict'] === 'pass' ? 'pass' : 'fail'
    const messages = Array.isArray(input.judge?.data['messages'])
      ? (input.judge!.data['messages'] as unknown[]).map(String)
      : []
    return {
      proposalId: proposal.proposalId,
      gateId,
      verdict,
      messages,
      evidence: [proposal.contentHash],
    }
  }
  return null
}

async function cleanupDrafts(instance: LoopInstance): Promise<void> {
  await Promise.all(Object.values(instance.charter.artifacts).map(spec =>
    rm(resolve(instance.paths.root, spec.draftPath), { force: true })))
}
