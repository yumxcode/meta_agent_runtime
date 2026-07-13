import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Charter } from '../../charter/CharterTypes.js'
import { createInstance } from '../../instance/InstanceStore.js'
import { WakeStore } from '../../wake/WakeStore.js'
import { makeArtifactProposal } from '../../artifacts/ArtifactProtocol.js'
import { refreshArtifactCheckpoint } from '../ArtifactCheckpoint.js'
import { GENERIC_SCENARIO_ID } from '../../scenarios/ScenarioDefinitions.js'

function checkpointCharter(): Charter {
  return {
    id: 'checkpoint-test', version: 1, scenario: GENERIC_SCENARIO_ID, goal: 'test',
    observables: [], meters: [{ name: 'iteration', inc: 'every_round' }],
    tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }], gates: {},
    seats: { worker: { context: 'isolated', prompt: 'test' } },
    budgets: { lifetime: { rounds: 2 } },
    artifacts: {
      item: {
        id: 'item', kind: 'json', draftPath: 'drafts/item.json', stream: 'items',
        commitMode: 'append', requiredGates: ['producer', 'artifact_drafts'],
      },
    },
    projections: [{
      id: 'recent-items', source: { kind: 'artifact_stream', stream: 'items' },
      reducer: 'builtin/artifact-view@1', mode: 'window', maxItems: 25,
    }],
  }
}

describe('Artifact projection checkpoint', () => {
  it('rebuilds once, then replays only the appended byte tail with bounded state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artifact-checkpoint-'))
    const instance = await createInstance({
      projectDir: dir, charter: checkpointCharter(), wakeStore: new WakeStore(dir),
    })
    for (let round = 1; round <= 2_000; round++) {
      const transactionId = `round:${round}`
      const proposal = makeArtifactProposal({
        proposalId: `${transactionId}:item:0`, transactionId, artifactId: 'item',
        content: { round, payload: 'x'.repeat(32) }, draftPath: 'drafts/item.json',
      })
      await instance.ledger.appendJsonl(instance.paths.artifactsJsonl, {
        type: 'artifact.transaction_committed', transactionId,
        decisions: [{ proposal, verdict: 'committed', gates: [] }], at: round,
      })
    }
    const journalBytes = (await stat(instance.paths.artifactsJsonl)).size
    const rebuilt = await refreshArtifactCheckpoint(instance)
    expect(rebuilt.rebuilt).toBe(true)
    expect(rebuilt.replayedBytes).toBe(journalBytes)
    expect(rebuilt.checkpoint.views['recent-items']).toMatchObject({ count: 2_000 })
    expect(rebuilt.checkpoint.views['recent-items']!.items).toHaveLength(25)

    const hot = await refreshArtifactCheckpoint(instance)
    expect(hot).toMatchObject({ rebuilt: false, replayedBytes: 0 })

    const transactionId = 'round:2001'
    const proposal = makeArtifactProposal({
      proposalId: `${transactionId}:item:0`, transactionId, artifactId: 'item',
      content: { round: 2_001 }, draftPath: 'drafts/item.json',
    })
    await instance.ledger.appendJsonl(instance.paths.artifactsJsonl, {
      type: 'artifact.transaction_committed', transactionId,
      decisions: [{ proposal, verdict: 'committed', gates: [] }], at: 2_001,
    })
    const incremental = await refreshArtifactCheckpoint(instance)
    expect(incremental.rebuilt).toBe(false)
    expect(incremental.replayedBytes).toBeLessThan(journalBytes / 100)
    expect(incremental.checkpoint.views['recent-items']?.count).toBe(2_001)
    expect(incremental.checkpoint.views['recent-items']?.items).toHaveLength(25)
    expect((await stat(instance.paths.artifactsCheckpointJson)).size).toBeLessThan(20_000)

    instance.charter.projections[0]!.maxItems = 5
    const configMismatch = await refreshArtifactCheckpoint(instance)
    expect(configMismatch.rebuilt).toBe(true)
    expect(configMismatch.checkpoint.views['recent-items']?.count).toBe(2_001)
    expect(configMismatch.checkpoint.views['recent-items']?.items).toHaveLength(5)
  })

  it('falls back to deterministic full replay when the checkpoint is corrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artifact-checkpoint-corrupt-'))
    const instance = await createInstance({
      projectDir: dir, charter: checkpointCharter(), wakeStore: new WakeStore(dir),
    })
    await instance.ledger.appendJsonl(instance.paths.artifactsJsonl, {
      type: 'artifact.transaction_committed', transactionId: 'round:1', decisions: [], at: 1,
    })
    await refreshArtifactCheckpoint(instance)
    await writeFile(instance.paths.artifactsCheckpointJson, '{broken', 'utf-8')
    const recovered = await refreshArtifactCheckpoint(instance)
    expect(recovered.rebuilt).toBe(true)
    expect(recovered.checkpoint.lastTransactionId).toBe('round:1')

    const tampered = JSON.parse(await readFile(instance.paths.artifactsCheckpointJson, 'utf-8'))
    tampered.stateHash = 'tampered'
    await writeFile(instance.paths.artifactsCheckpointJson, JSON.stringify(tampered), 'utf-8')
    const stateHashMismatch = await refreshArtifactCheckpoint(instance)
    expect(stateHashMismatch.rebuilt).toBe(true)
    expect(stateHashMismatch.checkpoint.stateHash).not.toBe('tampered')
  })
})
