import { describe, expect, it } from 'vitest'
import type { ObservationResult } from '../../types.js'
import {
  prepareReducerInput,
  validateReducerManifest,
  type ReducerManifest,
} from '../ReducerContract.js'

const at = 1
const present = (value: number): ObservationResult => ({
  status: 'present', value, source: 'judge:score', observedAt: at, provenance: [],
})
const absent: ObservationResult = {
  status: 'absent', source: 'judge:score', observedAt: at,
  reason: 'not_produced', provenance: [],
}
const error: ObservationResult = {
  status: 'error', source: 'judge:risk', observedAt: at,
  errorCode: 'judge_failed', message: 'failed', provenance: [],
}

describe('ReducerContract', () => {
  it('requires exhaustive, non-conflicting tri-state paths at freeze time', () => {
    const good: ReducerManifest = {
      id: 'builtin/research-state', version: '1',
      inputs: [
        {
          observable: 'score', accepts: ['present'],
          onAbsent: 'skip_reduction', onError: 'fail_stop',
        },
        { observable: 'risk', accepts: ['present', 'absent', 'error'] },
      ],
    }
    expect(validateReducerManifest(good, new Set(['score', 'risk']))).toEqual([])

    const bad: ReducerManifest = {
      id: 'bad', version: '1',
      inputs: [{
        observable: 'score', accepts: ['absent'],
        onAbsent: 'skip_reduction',
      }],
    }
    const errs = validateReducerManifest(bad, new Set(['score']))
    expect(errs.some(e => e.includes("must include 'present'"))).toBe(true)
    expect(errs.some(e => e.includes('conflicts'))).toBe(true)
    expect(errs.some(e => e.includes('onError is required'))).toBe(true)
  })

  it('rejects undeclared and duplicate observable bindings', () => {
    const manifest: ReducerManifest = {
      id: 'builtin/x', version: '1',
      inputs: [
        { observable: 'missing', accepts: ['present'], onAbsent: 'fail_stop', onError: 'fail_stop' },
        { observable: 'missing', accepts: ['present'], onAbsent: 'fail_stop', onError: 'fail_stop' },
      ],
    }
    const errs = validateReducerManifest(manifest, new Set(['score']))
    expect(errs.some(e => e.includes('not declared'))).toBe(true)
    expect(errs.some(e => e.includes('duplicated'))).toBe(true)
  })

  it('delivers accepted states and selects only declared observations', () => {
    const manifest: ReducerManifest = {
      id: 'builtin/x', version: '1',
      inputs: [{ observable: 'score', accepts: ['present', 'absent'], onError: 'fail_stop' }],
    }
    const ready = prepareReducerInput(manifest, { type: 'round' }, {
      score: absent,
      unrelated: present(9),
    })
    expect(ready).toMatchObject({
      kind: 'ready', input: { observations: { score: { status: 'absent' } } },
    })
    if (ready.kind === 'ready') expect(ready.input.observations).not.toHaveProperty('unrelated')
  })

  it('makes fail_stop dominate skip and fails closed on missing results', () => {
    const manifest: ReducerManifest = {
      id: 'builtin/x', version: '1',
      inputs: [
        { observable: 'score', accepts: ['present'], onAbsent: 'skip_reduction', onError: 'fail_stop' },
        { observable: 'risk', accepts: ['present'], onAbsent: 'skip_reduction', onError: 'fail_stop' },
      ],
    }
    expect(prepareReducerInput(manifest, {}, { score: absent, risk: error })).toMatchObject({
      kind: 'fail_stop', code: 'reducer_input_error',
    })
    expect(prepareReducerInput(manifest, {}, { score: present(1) })).toMatchObject({
      kind: 'fail_stop', code: 'reducer_input_missing',
    })
  })
})
