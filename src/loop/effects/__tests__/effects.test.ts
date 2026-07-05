import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { instancePaths } from '../../types.js'
import { Ledger } from '../../ledger/LedgerApi.js'
import { EffectLedger } from '../EffectLedger.js'
import { fileProbeAdapter, isPlateau } from '../ProbeAdapters.js'

async function freshEffects() {
  const dir = await mkdtemp(join(tmpdir(), 'loop-eff-'))
  const paths = instancePaths(dir, 'i1')
  return { dir, paths, effects: new EffectLedger(new Ledger(paths), paths) }
}

describe('EffectLedger (event-sourced fold)', () => {
  it('walks submitted → probing → concluded → harvested', async () => {
    const { effects } = await freshEffects()
    await effects.submit({ effectKey: 'e1', kind: 'file', waitName: 'training' })
    expect((await effects.get('e1'))!.status).toBe('submitted')
    await effects.recordProbe('e1', 'running', { samples: 2 })
    expect((await effects.get('e1'))!.status).toBe('probing')
    expect(await effects.conclude('e1', 'done', 'probe')).toBe(true)
    expect((await effects.get('e1'))!.outcome).toMatchObject({ verdict: 'done', via: 'probe' })
    await effects.markHarvested('e1')
    expect((await effects.get('e1'))!.status).toBe('harvested')
    expect(await effects.pending()).toHaveLength(0)
  })

  it('conclude is first-wins (probe/event dedup point)', async () => {
    const { effects } = await freshEffects()
    await effects.submit({ effectKey: 'e1', kind: 'file', waitName: 'training' })
    expect(await effects.conclude('e1', 'done', 'event')).toBe(true)
    expect(await effects.conclude('e1', 'plateau', 'probe')).toBe(false) // loser is a no-op
    expect((await effects.get('e1'))!.outcome!.via).toBe('event')
  })

  it('submit is idempotent; resubmit counts rotations and returns to probing', async () => {
    const { effects } = await freshEffects()
    await effects.submit({ effectKey: 'e1', kind: 'file', waitName: 'training', payload: { a: 1 } })
    await effects.submit({ effectKey: 'e1', kind: 'file', waitName: 'training', payload: { a: 2 } })
    expect((await effects.get('e1'))!.payload).toEqual({ a: 1 }) // first wins
    await effects.recordResubmit('e1', { account: 'second' })
    const rec = (await effects.get('e1'))!
    expect(rec.resubmits).toBe(1)
    expect(rec.status).toBe('probing')
    expect(rec.payload).toEqual({ account: 'second' })
  })
})

describe('isPlateau', () => {
  it('needs a full window and a sub-threshold slope', () => {
    expect(isPlateau([1, 1, 1], 4, 0.001)).toBe(false)              // window not full
    expect(isPlateau([1, 1.0005, 1.001, 1.0011], 4, 0.001)).toBe(true)
    expect(isPlateau([1, 1.1, 1.2, 1.35], 4, 0.001)).toBe(false)    // clearly improving
    expect(isPlateau([2, 1.9, 1.8, 1.7], 4, 0.001)).toBe(true)      // regressing = plateau'd
  })
})

describe('fileProbeAdapter', () => {
  it('maps the status file to verdicts (running/done/no_balance/plateau/error)', async () => {
    const { dir, effects } = await freshEffects()
    await effects.submit({ effectKey: 'e1', kind: 'file', waitName: 'training' })
    const effect = (await effects.get('e1'))!
    const statusFile = join(dir, 'sim.json')
    const params = { statusFile: 'sim.json', plateauWindow: 4, plateauMinSlope: 0.001 }
    const probe = (s: unknown) =>
      writeFile(statusFile, JSON.stringify(s), 'utf-8')
        .then(() => fileProbeAdapter.probe({ effect, params, projectDir: dir }))

    expect((await fileProbeAdapter.probe({ effect, params, projectDir: dir })).verdict).toBe('error') // no file yet
    expect((await probe({ state: 'running', metricHistory: [0.1, 0.3] })).verdict).toBe('running')
    expect((await probe({ state: 'running', metricHistory: [0.5, 0.5, 0.5, 0.5] })).verdict).toBe('plateau')
    expect((await probe({ state: 'running', balanceOk: false })).verdict).toBe('no_balance')
    expect((await probe({ state: 'done' })).verdict).toBe('done')
    expect((await probe({ state: 'error' })).verdict).toBe('error')
  })

  it('resubmit restores balance; terminate marks done', async () => {
    const { dir, effects } = await freshEffects()
    await effects.submit({ effectKey: 'e1', kind: 'file', waitName: 'training' })
    const effect = (await effects.get('e1'))!
    const statusFile = join(dir, 'sim.json')
    const params = { statusFile: 'sim.json' }
    await writeFile(statusFile, JSON.stringify({ state: 'running', balanceOk: false }), 'utf-8')

    await fileProbeAdapter.resubmit!({ effect, params, projectDir: dir })
    expect((await fileProbeAdapter.probe({ effect, params, projectDir: dir })).verdict).toBe('running')

    await fileProbeAdapter.terminate!({ effect, params, projectDir: dir })
    expect((await fileProbeAdapter.probe({ effect, params, projectDir: dir })).verdict).toBe('done')
  })
})
