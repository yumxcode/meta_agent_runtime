import { describe, expect, it } from 'vitest'
import { freezeCharter } from '../../charter/CharterValidate.js'
import type { ObservationResult } from '../../types.js'
import { walkResearchCharter } from '../../__tests__/testCharter.js'
import {
  conditionalCounterManifest,
  runConditionalCounterProjection,
} from '../ConditionalCounterReducer.js'

const at = 1
const present = (value: number | boolean): ObservationResult => ({
  status: 'present', value, source: 'test', observedAt: at, provenance: [],
})
const absent: ObservationResult = {
  status: 'absent', source: 'test', observedAt: at,
  reason: 'not_produced', provenance: [],
}

describe('ConditionalCounterReducer', () => {
  it('declares exactly the observation inputs consumed by meter ASTs', () => {
    const charter = freezeCharter(walkResearchCharter())
    expect(conditionalCounterManifest(charter).inputs.map(input => input.observable)).toEqual([
      'producer_ok', 'new_findings', 'metric_delta',
    ])
  })

  it('reproduces producer failure and successful-missing-judge compatibility', () => {
    const charter = freezeCharter(walkResearchCharter())
    const previous = { iteration: 0, stale_count: 0 }
    const failed = runConditionalCounterProjection(charter, previous, {
      producer_ok: present(false), new_findings: absent, metric_delta: absent,
    }, false)
    expect(failed).toEqual({
      meters: { iteration: 1, stale_count: 1 }, diagnostics: [],
    })

    const missing = runConditionalCounterProjection(charter, previous, {
      producer_ok: present(true), new_findings: absent, metric_delta: absent,
    }, false)
    expect(missing.meters).toEqual({ iteration: 1, stale_count: 0 })
    expect(missing.diagnostics[0]).toContain('retained previous value')
  })

  it('does not force a meter-only condition true when producer fails', () => {
    const raw = walkResearchCharter()
    raw.meters.push({ name: 'meter_only', incWhen: 'iteration > 99' })
    const charter = freezeCharter(raw)
    const projected = runConditionalCounterProjection(charter, {
      iteration: 0, stale_count: 0, meter_only: 0,
    }, {
      producer_ok: present(false), new_findings: absent, metric_delta: absent,
    }, false)
    expect(projected.meters['meter_only']).toBe(0)
  })
})
