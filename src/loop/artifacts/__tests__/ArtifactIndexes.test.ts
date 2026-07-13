import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Charter } from '../../charter/CharterTypes.js'
import { createInstance } from '../../instance/InstanceStore.js'
import { refreshArtifactCheckpoint } from '../../projection/ArtifactCheckpoint.js'
import { GENERIC_SCENARIO_ID } from '../../scenarios/ScenarioDefinitions.js'
import { WakeStore } from '../../wake/WakeStore.js'
import { makeArtifactProposal } from '../ArtifactProtocol.js'
import { findCommittedArtifactTransaction } from '../ArtifactIndexes.js'

function charter(): Charter {
  return {
    id: 'index-test', version: 1, scenario: GENERIC_SCENARIO_ID, goal: 'test',
    observables: [], meters: [{ name: 'iteration', inc: 'every_round' }],
    tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }], gates: {},
    seats: { worker: { context: 'isolated', prompt: 'test' } }, budgets: { lifetime: { rounds: 2 } },
    artifacts: {
      release: {
        id: 'release', kind: 'json', draftPath: 'drafts/release.json', stream: 'release',
        commitMode: 'replace', requiredGates: ['producer', 'artifact_drafts'],
      },
      package: {
        id: 'package', kind: 'json', draftPath: 'drafts/package.json', stream: 'packages',
        commitMode: 'versioned', requiredGates: ['producer', 'artifact_drafts'],
      },
    }, projections: [],
  }
}

describe('Artifact derived indexes', () => {
  it('provides exact old-transaction lookup and bounded replace/versioned stream state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artifact-index-'))
    const instance = await createInstance({ projectDir: dir, charter: charter(), wakeStore: new WakeStore(dir) })
    for (let round = 1; round <= 3; round++) {
      const transactionId = `round:${round}`
      const artifactId = round === 1 ? 'release' : 'package'
      const proposal = makeArtifactProposal({
        proposalId: `${transactionId}:${artifactId}:0`, transactionId, artifactId,
        content: round === 1 ? { release: 1 } : { bytes: 'same-version' },
        draftPath: `drafts/${artifactId}.json`,
      })
      await instance.ledger.appendJsonl(instance.paths.artifactsJsonl, {
        type: 'artifact.transaction_committed', transactionId,
        decisions: [{ proposal, verdict: 'committed', gates: [] }], at: round,
      })
    }
    const first = await refreshArtifactCheckpoint(instance)
    expect(first.checkpoint.streamStates.release).toMatchObject({
      commitMode: 'replace', logicalCount: 1, committedCount: 1,
    })
    expect(first.checkpoint.streamStates.release?.current).not.toHaveProperty('content')
    expect(first.checkpoint.streamStates.packages).toMatchObject({
      commitMode: 'versioned', logicalCount: 1, committedCount: 2,
    })
    expect((await findCommittedArtifactTransaction(instance, 'round:1'))?.transactionId).toBe('round:1')

    // Derived indexes may outlive a lost checkpoint; a rebuild remains
    // deterministic and must not turn the replayed first version into a duplicate.
    await rm(instance.paths.artifactsCheckpointJson, { force: true })
    const rebuilt = await refreshArtifactCheckpoint(instance)
    expect(rebuilt.rebuilt).toBe(true)
    expect(rebuilt.checkpoint.streamStates.packages).toMatchObject({ logicalCount: 1, committedCount: 2 })
  })
})
