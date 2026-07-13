/**
 * JUDGE_CONTRACT injection — the kernel is the single authority over the
 * judge's output schema. Charter-declared observable keys OUTSIDE the core
 * vocabulary must be injected into the contract, so a charter can never name
 * an observable key the judge was not told to emit (the round-12/13/14 pivot
 * bug: a made-up `results_improved` key froze fine but the judge never
 * emitted it, silently killing the dependent tripwire).
 */
import { describe, expect, it } from 'vitest'
import { JUDGE_CORE_KEYS, buildJudgeContract, extraJudgeKeys } from '../Seats.js'
import type { FrozenCharter } from '../../charter/CharterTypes.js'
import { freezeCharter } from '../../charter/CharterValidate.js'
import { walkResearchCharter } from '../../__tests__/testCharter.js'

function charterWithKeys(keys: string[]): FrozenCharter {
  return {
    observables: keys.map((k, i) => ({ name: `obs_${i}`, source: { from: 'judge' as const, key: k } })),
  } as unknown as FrozenCharter
}

describe('extraJudgeKeys', () => {
  it('core keys yield no extras', () => {
    expect(extraJudgeKeys(charterWithKeys([...JUDGE_CORE_KEYS]))).toEqual([])
  })

  it('collects charter-invented keys, deduped, in declaration order', () => {
    const charter = charterWithKeys([
      'new_findings_count', 'results_improved', 'coverage_ratio', 'results_improved', 'goal_satisfied',
    ])
    expect(extraJudgeKeys(charter)).toEqual(['results_improved', 'coverage_ratio'])
  })

  it('uses the frozen obligation graph as the output-contract authority', () => {
    const charter = walkResearchCharter()
    charter.observables.push({
      name: 'coverage', source: { from: 'judge', key: 'coverage_ratio' },
    })
    charter.health = {
      staleWhen: 'coverage < 0.5', onAbsent: 'false', onError: 'fail_stop',
    }
    const frozen = freezeCharter(charter)
    // A post-freeze mutable view cannot silently change the required output;
    // the obligation snapshot remains authoritative.
    frozen.observables = []
    expect(extraJudgeKeys(frozen)).toEqual(['coverage_ratio'])
  })
})

describe('buildJudgeContract', () => {
  it('without extras: fixed schema only, no charter clause', () => {
    const contract = buildJudgeContract([])
    for (const key of JUDGE_CORE_KEYS) expect(contract).toContain(key)
    expect(contract).not.toContain('charter 观测字段')
  })

  it('with extras: demands every charter-declared key on top of the core schema', () => {
    const contract = buildJudgeContract(['results_improved', 'coverage_ratio'])
    expect(contract).toContain('charter 观测字段')
    expect(contract).toContain('"results_improved"')
    expect(contract).toContain('"coverage_ratio"')
    // Core schema must survive untouched — extras extend it, never replace it.
    for (const key of JUDGE_CORE_KEYS) expect(contract).toContain(key)
  })
})
