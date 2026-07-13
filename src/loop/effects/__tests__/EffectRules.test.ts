import { describe, expect, it } from 'vitest'
import type { EffectBinding } from '../../charter/CharterTypes.js'
import { freezeEffectBindings, evaluateEffectRules, validateEffectBindings } from '../EffectRules.js'

function binding(overrides: Partial<EffectBinding> = {}): EffectBinding {
  return {
    adapter: 'vendor/training@2',
    observations: {
      status: { pointer: '/state', type: 'string' },
      balance: { pointer: '/data/balance', type: 'number' },
      quotaExhausted: { pointer: '/data/quotaExhausted', type: 'boolean' },
    },
    rules: [
      {
        when: "status == 'succeeded'", then: { act: 'harvest', verdict: 'completed' },
        onAbsent: 'fail_stop', onError: 'fail_stop',
      },
      {
        when: 'balance <= 0 || quotaExhausted',
        then: { act: 'cancel_and_harvest', verdict: 'quota_exhausted' },
        onAbsent: 'continue_waiting', onError: 'fail_stop',
      },
    ],
    admission: { maxConcurrentCalls: 2, minIntervalMs: 10 },
    ...overrides,
  }
}

describe('Effect Rule freeze and evaluation', () => {
  it('freezes typed rule ASTs and evaluates ordered first-match actions', () => {
    const frozen = freezeEffectBindings({ training: binding() }).training!
    expect(frozen.frozen.ruleAsts).toHaveLength(2)
    expect(evaluateEffectRules(frozen, {
      state: 'pending', data: { balance: 0, quotaExhausted: false },
    })).toMatchObject({
      ruleIndex: 1,
      action: { act: 'cancel_and_harvest', verdict: 'quota_exhausted' },
      observations: { status: 'pending', balance: 0, quotaExhausted: false },
    })
  })

  it('applies explicit absent and type-error policies without coercion', () => {
    const frozen = freezeEffectBindings({ training: binding() }).training!
    expect(evaluateEffectRules(frozen, { state: 'pending', data: {} })).toMatchObject({
      ruleIndex: 1, action: { act: 'continue_waiting' },
      diagnostic: expect.stringContaining('pointer missing'),
    })
    expect(evaluateEffectRules(frozen, {
      state: 'pending', data: { balance: '0', quotaExhausted: false },
    })).toMatchObject({
      ruleIndex: 1, action: null,
      diagnostic: expect.stringContaining('fail_stop'),
    })
  })

  it('rejects undeclared identifiers, unsafe pointers and statically invalid types', () => {
    const invalid = binding({
      observations: {
        status: { pointer: '/__proto__/polluted', type: 'string' },
        balance: { pointer: '/data/balance', type: 'number' },
      },
      rules: [{
        when: "balance && missing == 'x'", then: { act: 'harvest', verdict: 'x' },
        onAbsent: 'continue_waiting', onError: 'fail_stop',
      }],
    })
    const errors = validateEffectBindings({ training: invalid })
    expect(errors.some(error => error.includes('safe JSON Pointer'))).toBe(true)
    expect(errors.some(error => error.includes('undeclared identifier'))).toBe(true)
  })
})
