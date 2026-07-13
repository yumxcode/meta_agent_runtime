import { describe, expect, it } from 'vitest'
import {
  decideArtifact,
  hashArtifactContent,
  makeArtifactProposal,
  type ArtifactSpec,
} from '../ArtifactProtocol.js'

const spec: ArtifactSpec = {
  id: 'report', kind: 'json', draftPath: 'drafts/report.json',
  stream: 'reports', commitMode: 'append', requiredGates: ['shape', 'review'],
}
const proposal = makeArtifactProposal({
  proposalId: 'p1', transactionId: 't1', artifactId: 'report',
  content: { b: 2, a: 1 }, draftPath: spec.draftPath,
})

describe('ArtifactProtocol', () => {
  it('hashes JSON deterministically independent of object key order', () => {
    expect(proposal.contentHash).toBe(hashArtifactContent({ a: 1, b: 2 }))
  })

  it('fails closed when a required Gate is missing or fails', () => {
    const shape = {
      proposalId: 'p1', gateId: 'shape', verdict: 'pass' as const,
      messages: [], evidence: ['hash'],
    }
    expect(decideArtifact(spec, proposal, [shape])).toMatchObject({
      verdict: 'rejected', reason: "required gate 'review' did not run",
    })
    expect(decideArtifact(spec, proposal, [shape, {
      proposalId: 'p1', gateId: 'review', verdict: 'error', messages: [], evidence: [],
    }])).toMatchObject({ verdict: 'rejected', reason: "gate 'review' returned error" })
  })

  it('commits only after every required Gate passes', () => {
    const decision = decideArtifact(spec, proposal, ['shape', 'review'].map(gateId => ({
      proposalId: 'p1', gateId, verdict: 'pass' as const, messages: [], evidence: ['hash'],
    })))
    expect(decision).toMatchObject({ verdict: 'committed', proposal: { proposalId: 'p1' } })
    expect(decision.gates).toHaveLength(2)
  })
})
