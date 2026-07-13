import { describe, expect, it } from 'vitest'
import {
  executeArtifactTransaction,
  materializeArtifactStreams,
  type ArtifactLedgerEvent,
} from '../ArtifactExecutor.js'
import { makeArtifactProposal, type ArtifactSpec } from '../ArtifactProtocol.js'

const specs: Record<string, ArtifactSpec> = {
  log: {
    id: 'log', kind: 'json', draftPath: 'drafts/log.json', stream: 'logs',
    commitMode: 'append', requiredGates: ['producer'],
  },
  current: {
    id: 'current', kind: 'text', draftPath: 'drafts/current.txt', stream: 'current',
    commitMode: 'replace', requiredGates: ['producer'],
  },
  release: {
    id: 'release', kind: 'external_ref', draftPath: 'drafts/release.json', stream: 'releases',
    commitMode: 'versioned', requiredGates: ['producer'],
  },
}

function proposal(transactionId: string, artifactId: string, content: unknown) {
  return makeArtifactProposal({
    proposalId: `${transactionId}:${artifactId}`,
    transactionId,
    artifactId,
    content,
    draftPath: specs[artifactId]!.draftPath,
  })
}

describe('ArtifactExecutor', () => {
  it('writes proposal/Gate/terminal decision and is transaction-idempotent', async () => {
    const events: ArtifactLedgerEvent[] = []
    const run = () => executeArtifactTransaction({
      transactionId: 'round:1', proposals: [proposal('round:1', 'log', { n: 1 })],
      specs, existingEvents: events,
      gateResults: item => [{
        proposalId: item.proposalId, gateId: 'producer', verdict: 'pass',
        messages: [], evidence: [item.contentHash],
      }],
      append: async event => { events.push(event) }, now: () => 1,
    })
    expect((await run()).alreadyCommitted).toBe(false)
    expect(events.map(event => event.type)).toEqual([
      'artifact.proposed', 'gate.completed', 'artifact.transaction_committed',
    ])
    expect((await run()).alreadyCommitted).toBe(true)
    expect(events).toHaveLength(3)
  })

  it('replays append, replace and versioned stream semantics from terminal events only', async () => {
    const events: ArtifactLedgerEvent[] = []
    const commit = async (transactionId: string, proposals: ReturnType<typeof proposal>[]) => {
      await executeArtifactTransaction({
        transactionId, proposals, specs, existingEvents: events,
        gateResults: item => [{
          proposalId: item.proposalId, gateId: 'producer', verdict: 'pass',
          messages: [], evidence: [item.contentHash],
        }],
        append: async event => { events.push(event) },
      })
    }
    await commit('round:1', [
      proposal('round:1', 'log', 1), proposal('round:1', 'current', 'a'),
      proposal('round:1', 'release', { ref: 'v1' }),
    ])
    await commit('round:2', [
      proposal('round:2', 'log', 2), proposal('round:2', 'current', 'b'),
      proposal('round:2', 'release', { ref: 'v1' }),
    ])
    const streams = materializeArtifactStreams(events, specs)
    expect(streams.logs?.map(item => item.content)).toEqual([1, 2])
    expect(streams.current?.map(item => item.content)).toEqual(['b'])
    expect(streams.releases?.map(item => item.content)).toEqual([{ ref: 'v1' }])
  })

  it('ignores uncommitted proposal events during replay', () => {
    const dangling: ArtifactLedgerEvent = {
      type: 'artifact.proposed', proposal: proposal('round:lost', 'log', 99), at: 1,
    }
    expect(materializeArtifactStreams([dangling], specs)).toEqual({})
  })
})
