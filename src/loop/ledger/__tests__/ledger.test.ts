import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { instancePaths, type RoundEntry } from '../../types.js'
import { Ledger, withBuiltinSchemas, type ProgressView } from '../LedgerApi.js'

async function freshLedger() {
  const dir = await mkdtemp(join(tmpdir(), 'loop-ledger-'))
  const paths = instancePaths(dir, 'inst-1')
  return { paths, ledger: withBuiltinSchemas(new Ledger(paths), paths) }
}

const round = (n: number): RoundEntry => ({
  round: n, mode: 'normal', observables: {}, meters: { stale_count: 0 },
  route: { kind: 'continue' }, correctiveRetries: 0, costUsd: 0.5,
  seatSummaries: {}, startedAt: 1, finishedAt: 2,
  postState: {
    schemaVersion: 4,
    iteration: n, meters: { stale_count: 0 }, status: 'healthy',
    objectiveBestValue: null, totalCostUsd: n * 0.5,
  },
})

describe('Ledger', () => {
  it('appendJsonl + readJsonl round-trips with lastK', async () => {
    const { ledger, paths } = await freshLedger()
    for (let i = 1; i <= 4; i++) await ledger.appendRound(round(i))
    const all = await ledger.readJsonl<RoundEntry>(paths.roundsJsonl)
    expect(all.map(r => r.round)).toEqual([1, 2, 3, 4])
    const last2 = await ledger.readJsonl<RoundEntry>(paths.roundsJsonl, 2)
    expect(last2.map(r => r.round)).toEqual([3, 4])
  })

  it('replaceJson is atomic and schema-checked', async () => {
    const { ledger, paths } = await freshLedger()
    const good: ProgressView = {
      schemaVersion: 4,
      iteration: 1, meters: { stale_count: 0 }, status: 'healthy',
      objectiveBestValue: null, totalCostUsd: 0.5, updatedAt: Date.now(),
    }
    await ledger.writeProgress(good)
    expect((await ledger.readProgress()).iteration).toBe(1)

    await expect(
      ledger.replaceJson(paths.progressJson, { iteration: 'NaN' }),
    ).rejects.toThrow(/schema violation/)
    // Failed write must not have clobbered the good value.
    expect((await ledger.readProgress()).iteration).toBe(1)
  })

  it('rejects malformed round entries before touching disk', async () => {
    const { ledger, paths } = await freshLedger()
    await expect(
      ledger.appendJsonl(paths.roundsJsonl, { round: 'one', mode: 'normal', route: { kind: 'continue' }, costUsd: 0 }),
    ).rejects.toThrow(/round must be a number/)
    expect(await ledger.readJsonl(paths.roundsJsonl)).toEqual([])
  })

  it('validates tri-state observation results while accepting legacy rounds without them', async () => {
    const { ledger, paths } = await freshLedger()
    await ledger.appendRound(round(1))
    await expect(ledger.appendJsonl(paths.roundsJsonl, {
      ...round(2),
      observationResults: {
        score: { status: 'present', source: 'judge:score', observedAt: 1, provenance: [] },
      },
    })).rejects.toThrow(/value is required when present/)
    expect(await ledger.readJsonl<RoundEntry>(paths.roundsJsonl)).toHaveLength(1)
  })

  it('readJsonl survives a torn line without losing the rest', async () => {
    const { ledger, paths } = await freshLedger()
    await ledger.appendRound(round(1))
    // Simulate a crash mid-append.
    const { appendFile } = await import('fs/promises')
    await appendFile(paths.roundsJsonl, '{"round": 2, "mode"', 'utf-8')
    const rows = await ledger.readJsonl<RoundEntry>(paths.roundsJsonl)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.round).toBe(1)
    expect((await ledger.readJsonl<RoundEntry>(paths.roundsJsonl, 1))[0]!.round).toBe(1)
  })

  it('readView derives only generic progress and recent rounds from disk', async () => {
    const { ledger, paths } = await freshLedger()
    const committed = round(1)
    await ledger.appendRound(committed)
    const view = await ledger.readView()
    expect(view.lastRounds).toHaveLength(1)
    expect(view.progress.iteration).toBe(1) // rebuilt from the committed round
    expect(view).not.toHaveProperty('findingsCount')
    expect(view).not.toHaveProperty('directions')
  })

  it('rebuilds progress from a committed round after the progress write is lost', async () => {
    const { ledger } = await freshLedger()
    await ledger.appendRound(round(3))
    const progress = await ledger.readProgress()
    expect(progress.iteration).toBe(3)
    expect(progress.totalCostUsd).toBe(1.5)
  })

  it('normalizes a pre-v4 Research-shaped progress cache into generic v4 state', async () => {
    const { ledger, paths } = await freshLedger()
    await mkdir(paths.ledgerDir, { recursive: true })
    await writeFile(paths.progressJson, JSON.stringify({
      iteration: 0, meters: {}, status: 'healthy', bestMetric: 0.7,
      totalFindings: 99, totalCostUsd: 1, updatedAt: 1,
    }), 'utf-8')
    const progress = await ledger.readProgress()
    expect(progress).toMatchObject({
      schemaVersion: 4, objectiveBestValue: 0.7, totalCostUsd: 1,
    })
    expect(progress).not.toHaveProperty('totalFindings')
    expect(progress).not.toHaveProperty('bestMetric')
  })

  it('appendJsonl entries are one line each (audit greppability)', async () => {
    const { ledger, paths } = await freshLedger()
    const sampleJsonl = join(paths.ledgerDir, 'sample.jsonl')
    await ledger.appendJsonl(sampleJsonl, { id: 'f1', body: 'line1\nline2' })
    const raw = await readFile(sampleJsonl, 'utf-8')
    expect(raw.trim().split('\n')).toHaveLength(1)
  })
})
