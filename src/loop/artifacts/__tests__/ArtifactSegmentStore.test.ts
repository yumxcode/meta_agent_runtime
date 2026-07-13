import { describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Charter } from '../../charter/CharterTypes.js'
import { createInstance } from '../../instance/InstanceStore.js'
import { refreshArtifactCheckpoint } from '../../projection/ArtifactCheckpoint.js'
import { WakeStore } from '../../wake/WakeStore.js'
import { GENERIC_SCENARIO_ID } from '../../scenarios/ScenarioDefinitions.js'
import {
  ArtifactJournalCorruptionError,
  loadArtifactSegmentManifest,
} from '../ArtifactSegmentStore.js'

function charter(): Charter {
  return {
    id: 'segment-test', version: 1, scenario: GENERIC_SCENARIO_ID, goal: 'test',
    observables: [], meters: [{ name: 'iteration', inc: 'every_round' }],
    tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }], gates: {},
    seats: { worker: { context: 'isolated', prompt: 'test' } }, budgets: { lifetime: { rounds: 2 } },
    artifacts: {}, projections: [],
  }
}

describe('ArtifactSegmentStore', () => {
  it('seals only after checkpointing and replays just the new active tail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artifact-segments-'))
    const instance = await createInstance({ projectDir: dir, charter: charter(), wakeStore: new WakeStore(dir) })
    for (let round = 1; round <= 3; round++) {
      await instance.ledger.appendJsonl(instance.paths.artifactsJsonl, {
        type: 'artifact.transaction_committed', transactionId: `round:${round}`, decisions: [], at: round,
      })
    }
    const sealed = await refreshArtifactCheckpoint(instance, { maxActiveEvents: 3, maxActiveBytes: 1e9 })
    expect(sealed.checkpoint.cursor).toMatchObject({ sealedSegments: 1, activeByteOffset: 0 })
    const manifest = await loadArtifactSegmentManifest(instance)
    expect(manifest).toMatchObject({ totalEvents: 3, headHash: manifest.segments[0]!.hash })
    await expect(readFile(instance.paths.artifactsJsonl, 'utf-8')).rejects.toThrow()

    await instance.ledger.appendJsonl(instance.paths.artifactsJsonl, {
      type: 'artifact.transaction_committed', transactionId: 'round:4', decisions: [], at: 4,
    })
    const hot = await refreshArtifactCheckpoint(instance, { maxActiveEvents: 3, maxActiveBytes: 1e9 })
    expect(hot.rebuilt).toBe(false)
    expect(hot.checkpoint).toMatchObject({ eventCount: 4, lastTransactionId: 'round:4' })
    expect(hot.replayedBytes).toBeLessThan(manifest.segments[0]!.bytes)
  })

  it('recovers rename-before-manifest and fails closed on sealed-byte corruption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artifact-segment-recovery-'))
    const instance = await createInstance({ projectDir: dir, charter: charter(), wakeStore: new WakeStore(dir) })
    await instance.ledger.appendJsonl(instance.paths.artifactsJsonl, {
      type: 'artifact.transaction_committed', transactionId: 'round:1', decisions: [], at: 1,
    })
    await refreshArtifactCheckpoint(instance, { maxActiveEvents: 1, maxActiveBytes: 1e9 })
    await rm(instance.paths.artifactsSegmentsManifestJson, { force: true })
    const recovered = await loadArtifactSegmentManifest(instance)
    expect(recovered.totalEvents).toBe(1)

    const segmentPath = join(instance.paths.artifactsSegmentsDir, recovered.segments[0]!.file)
    await appendFile(segmentPath, 'x')
    await rm(instance.paths.artifactsCheckpointJson, { force: true })
    await expect(refreshArtifactCheckpoint(instance)).rejects.toBeInstanceOf(ArtifactJournalCorruptionError)
    const raw = await readFile(segmentPath)
    await writeFile(segmentPath, raw.subarray(0, -1))
  })

  it('pages segment metadata so the mutable root stays bounded and migrates a v1 root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artifact-segment-pages-'))
    const instance = await createInstance({ projectDir: dir, charter: charter(), wakeStore: new WakeStore(dir) })
    for (let round = 1; round <= 65; round++) {
      await instance.ledger.appendJsonl(instance.paths.artifactsJsonl, {
        type: 'artifact.transaction_committed', transactionId: `round:${round}`, decisions: [], at: round,
      })
      await refreshArtifactCheckpoint(instance, { maxActiveEvents: 1, maxActiveBytes: 1e9 })
    }
    const paged = await loadArtifactSegmentManifest(instance)
    expect(paged).toMatchObject({ schemaVersion: '2.0', segmentCount: 65, pageCount: 1 })
    expect(paged.segments).toHaveLength(65)
    expect((await stat(instance.paths.artifactsSegmentsManifestJson)).size).toBeLessThan(5_000)

    // A small legacy root is upgraded in place without changing authority.
    const legacy = {
      schemaVersion: '1.0', segments: paged.segments, headHash: paged.headHash,
      totalEvents: paged.totalEvents, updatedAt: Date.now(),
    }
    await rm(instance.paths.artifactsSegmentPagesDir, { recursive: true, force: true })
    await writeFile(instance.paths.artifactsSegmentsManifestJson, JSON.stringify(legacy), 'utf-8')
    const migrated = await loadArtifactSegmentManifest(instance)
    expect(migrated).toMatchObject({ schemaVersion: '2.0', segmentCount: 65, pageCount: 1 })
    expect(JSON.parse(await readFile(instance.paths.artifactsSegmentsManifestJson, 'utf-8')).schemaVersion).toBe('2.0')
    const pagePath = join(instance.paths.artifactsSegmentPagesDir, '00000001.json')
    const page = JSON.parse(await readFile(pagePath, 'utf-8'))
    page.segments[0].hash = 'tampered'
    await writeFile(pagePath, JSON.stringify(page), 'utf-8')
    await expect(loadArtifactSegmentManifest(instance)).rejects.toBeInstanceOf(ArtifactJournalCorruptionError)
  })
})
