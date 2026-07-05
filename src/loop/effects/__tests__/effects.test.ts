import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { instancePaths } from '../../types.js'
import { Ledger } from '../../ledger/LedgerApi.js'
import { EffectLedger } from '../EffectLedger.js'

async function freshEffects() {
  const dir = await mkdtemp(join(tmpdir(), 'loop-eff-'))
  const paths = instancePaths(dir, 'i1')
  return { dir, paths, effects: new EffectLedger(new Ledger(paths), paths) }
}

describe('EffectLedger (event-sourced fold)', () => {
  it('walks submitted → concluded → harvested', async () => {
    const { effects } = await freshEffects()
    await effects.submit({ effectKey: 'e1', kind: 'event', waitName: 'event' })
    expect((await effects.get('e1'))!.status).toBe('submitted')
    expect(await effects.conclude('e1', 'done', 'event', { final: 1 })).toBe(true)
    expect((await effects.get('e1'))!.outcome).toMatchObject({ verdict: 'done', via: 'event' })
    await effects.markHarvested('e1')
    expect((await effects.get('e1'))!.status).toBe('harvested')
    expect(await effects.pending()).toHaveLength(0)
  })

  it('conclude is first-wins (event dedup point)', async () => {
    const { effects } = await freshEffects()
    await effects.submit({ effectKey: 'e1', kind: 'event', waitName: 'event' })
    expect(await effects.conclude('e1', 'done', 'event')).toBe(true)
    expect(await effects.conclude('e1', 'other', 'event')).toBe(false) // loser is a no-op
    expect((await effects.get('e1'))!.outcome!.verdict).toBe('done')
  })

  it('submit is idempotent (first payload wins)', async () => {
    const { effects } = await freshEffects()
    await effects.submit({ effectKey: 'e1', kind: 'event', waitName: 'event', payload: { a: 1 } })
    await effects.submit({ effectKey: 'e1', kind: 'event', waitName: 'event', payload: { a: 2 } })
    expect((await effects.get('e1'))!.payload).toEqual({ a: 1 })
  })
})
