import { createHash } from 'crypto'
import type { ArtifactSpec } from '../charter/CharterTypes.js'

export type { ArtifactCommitMode, ArtifactSpec } from '../charter/CharterTypes.js'

export interface ArtifactProposal {
  proposalId: string
  transactionId: string
  artifactId: string
  content: unknown
  contentHash: string
  draftPath: string
}

export interface ArtifactGateResult {
  proposalId: string
  gateId: string
  verdict: 'pass' | 'fail' | 'error'
  messages: string[]
  evidence: string[]
}

export interface ArtifactDecision {
  proposal: ArtifactProposal
  verdict: 'committed' | 'rejected'
  gates: ArtifactGateResult[]
  reason?: string
}

export function makeArtifactProposal(input: Omit<ArtifactProposal, 'contentHash'>): ArtifactProposal {
  return { ...input, contentHash: hashArtifactContent(input.content) }
}

export function decideArtifact(
  spec: ArtifactSpec,
  proposal: ArtifactProposal,
  gateResults: readonly ArtifactGateResult[],
): ArtifactDecision {
  const byGate = new Map(gateResults
    .filter(result => result.proposalId === proposal.proposalId)
    .map(result => [result.gateId, result]))
  const gates: ArtifactGateResult[] = []
  for (const gateId of spec.requiredGates) {
    const result = byGate.get(gateId)
    if (!result) {
      return {
        proposal, verdict: 'rejected', gates,
        reason: `required gate '${gateId}' did not run`,
      }
    }
    gates.push(result)
    if (result.verdict !== 'pass') {
      return {
        proposal, verdict: 'rejected', gates,
        reason: `gate '${gateId}' returned ${result.verdict}`,
      }
    }
  }
  return { proposal, verdict: 'committed', gates }
}

export function hashArtifactContent(content: unknown): string {
  return createHash('sha256').update(stableJson(content)).digest('hex')
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`
}
