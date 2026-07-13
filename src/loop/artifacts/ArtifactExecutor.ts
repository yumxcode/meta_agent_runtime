import {
  decideArtifact,
  type ArtifactDecision,
  type ArtifactGateResult,
  type ArtifactProposal,
  type ArtifactSpec,
} from './ArtifactProtocol.js'

export type ArtifactLedgerEvent =
  | { type: 'artifact.proposed'; proposal: ArtifactProposal; at: number }
  | { type: 'gate.completed'; result: ArtifactGateResult; at: number }
  | {
      type: 'artifact.transaction_committed'
      transactionId: string
      decisions: ArtifactDecision[]
      at: number
    }

export interface ArtifactTransactionResult {
  transactionId: string
  decisions: ArtifactDecision[]
  alreadyCommitted: boolean
}

/**
 * Execute one append-only Artifact transaction. The caller owns the file lock
 * so Scenario-specific baseline/projection work can share the same critical
 * section. Only the terminal transaction event grants commit authority.
 */
export async function executeArtifactTransaction(input: {
  transactionId: string
  proposals: readonly ArtifactProposal[]
  specs: Readonly<Record<string, ArtifactSpec>>
  existingEvents: readonly unknown[]
  gateResults(proposal: ArtifactProposal, spec: ArtifactSpec): ArtifactGateResult[]
  append(event: ArtifactLedgerEvent): Promise<void>
  now?: () => number
}): Promise<ArtifactTransactionResult> {
  const existing = input.existingEvents.find(event =>
    isCommittedEvent(event) && event.transactionId === input.transactionId)
  if (isCommittedEvent(existing)) {
    return {
      transactionId: existing.transactionId,
      decisions: existing.decisions,
      alreadyCommitted: true,
    }
  }

  const now = input.now ?? Date.now
  const decisions: ArtifactDecision[] = []
  for (const proposal of input.proposals) {
    const proposed: ArtifactLedgerEvent = { type: 'artifact.proposed', proposal, at: now() }
    await input.append(proposed)
    const spec = input.specs[proposal.artifactId]
    if (!spec) {
      decisions.push({
        proposal, verdict: 'rejected', gates: [],
        reason: `proposal references undeclared ArtifactSpec '${proposal.artifactId}'`,
      })
      continue
    }
    const gates = input.gateResults(proposal, spec)
    for (const result of gates) {
      await input.append({ type: 'gate.completed', result, at: now() })
    }
    decisions.push(decideArtifact(spec, proposal, gates))
  }

  await input.append({
    type: 'artifact.transaction_committed',
    transactionId: input.transactionId,
    decisions,
    at: now(),
  })
  return { transactionId: input.transactionId, decisions, alreadyCommitted: false }
}

/** Rebuild logical streams solely from terminal transaction events. */
export function materializeArtifactStreams(
  events: readonly unknown[],
  specs: Readonly<Record<string, ArtifactSpec>>,
): Record<string, ArtifactProposal[]> {
  const streams: Record<string, ArtifactProposal[]> = {}
  const seenTransactions = new Set<string>()
  for (const event of events) {
    if (!isCommittedEvent(event) || seenTransactions.has(event.transactionId)) continue
    seenTransactions.add(event.transactionId)
    for (const decision of event.decisions) {
      if (decision.verdict !== 'committed') continue
      const spec = specs[decision.proposal.artifactId]
      if (!spec) continue
      const stream = streams[spec.stream] ?? []
      if (spec.commitMode === 'replace') {
        streams[spec.stream] = [decision.proposal]
      } else if (spec.commitMode === 'versioned') {
        if (!stream.some(proposal => proposal.contentHash === decision.proposal.contentHash)) {
          streams[spec.stream] = [...stream, decision.proposal]
        }
      } else {
        streams[spec.stream] = [...stream, decision.proposal]
      }
    }
  }
  return streams
}

export function isCommittedEvent(value: unknown): value is Extract<
  ArtifactLedgerEvent,
  { type: 'artifact.transaction_committed' }
> {
  if (!value || typeof value !== 'object') return false
  const event = value as { type?: unknown; transactionId?: unknown; decisions?: unknown }
  return event.type === 'artifact.transaction_committed' &&
    typeof event.transactionId === 'string' && Array.isArray(event.decisions)
}
