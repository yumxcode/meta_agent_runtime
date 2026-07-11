import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
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
    iteration: n, meters: { stale_count: 0 }, status: 'healthy',
    bestMetric: null, totalFindings: 0, totalCostUsd: n * 0.5,
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
      iteration: 1, meters: { stale_count: 0 }, status: 'healthy',
      bestMetric: null, totalFindings: 0, totalCostUsd: 0.5, updatedAt: Date.now(),
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

  it('readJsonl survives a torn line without losing the rest', async () => {
    const { ledger, paths } = await freshLedger()
    await ledger.appendRound(round(1))
    // Simulate a crash mid-append.
    const { appendFile } = await import('fs/promises')
    await appendFile(paths.roundsJsonl, '{"round": 2, "mode"', 'utf-8')
    const rows = await ledger.readJsonl<RoundEntry>(paths.roundsJsonl)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.round).toBe(1)
  })

  it('readView derives progress/lastRounds/findings/directions from disk', async () => {
    const { ledger, paths } = await freshLedger()
    await ledger.appendRound(round(1))
    await ledger.appendJsonl(paths.findingsJsonl, { id: 'f1', claim: 'works' })
    await ledger.replaceJson(paths.directionsJson, { directions: [{ key: 'd1' }] })
    const view = await ledger.readView()
    expect(view.lastRounds).toHaveLength(1)
    expect(view.findingsCount).toBe(1)
    expect(view.directions).toEqual([{ key: 'd1' }])
    expect(view.progress.iteration).toBe(1) // rebuilt from the committed round
  })

  it('rebuilds progress from a committed round after the progress write is lost', async () => {
    const { ledger } = await freshLedger()
    await ledger.appendRound(round(3))
    const progress = await ledger.readProgress()
    expect(progress.iteration).toBe(3)
    expect(progress.totalCostUsd).toBe(1.5)
  })

  it('appendJsonl entries are one line each (audit greppability)', async () => {
    const { ledger, paths } = await freshLedger()
    await ledger.appendJsonl(paths.findingsJsonl, { id: 'f1', body: 'line1\nline2' })
    const raw = await readFile(paths.findingsJsonl, 'utf-8')
    expect(raw.trim().split('\n')).toHaveLength(1)
  })
})
