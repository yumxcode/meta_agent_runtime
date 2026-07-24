import { describe, expect, it } from 'vitest'
import {
  classifyExecutionFailure,
  serializeExecutionError,
} from '../ExecutionFailure.js'
import { translateKernelEvent } from '../../../modes/eventAdapter.js'

describe('structured execution failures', () => {
  it('classifies subscription/auth failures as provider-blocked without losing details', () => {
    const errors = serializeExecutionError(Object.assign(
      new Error('coding plan subscription expired'),
      { status: 402, code: 'subscription_expired' },
    ))
    const failure = classifyExecutionFailure({
      subtype: 'error_during_execution',
      errors,
      providerId: 'zhipu',
    })
    expect(failure).toMatchObject({
      category: 'provider_blocked',
      providerId: 'zhipu',
      status: 402,
      code: 'subscription_expired',
      retryable: false,
    })
    expect(failure.details).toContain('coding plan subscription expired')
  })

  it('keeps structured Kernel failures through the MetaAgent event adapter', () => {
    const failure = classifyExecutionFailure({
      subtype: 'error_during_execution',
      errors: ['status=429 rate limit'],
      providerId: 'anthropic',
    })
    const [translated] = translateKernelEvent({
      type: 'result',
      subtype: 'error_during_execution',
      sessionId: 'kernel',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      numTurns: 0,
      stopReason: null,
      resultText: '',
      errors: ['status=429 rate limit'],
      failure,
    }, {
      sessionId: 'meta',
      startMs: Date.now(),
      turnCount: 0,
      totalCostUsd: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    })
    expect(translated).toMatchObject({
      type: 'result',
      errors: ['status=429 rate limit'],
      failure: { category: 'provider_transient', status: 429 },
    })
  })

  it('does not mistake deterministic orchestration stops for provider outages', () => {
    expect(classifyExecutionFailure({
      subtype: 'error_during_execution',
      stopReason: 'verify_exhausted',
      resultText: 'completion verification did not pass',
    }).category).toBe('task_failure')
  })

  it('does not treat an ordinary required-field runtime error as a subscription failure', () => {
    expect(classifyExecutionFailure({
      subtype: 'error_during_execution',
      errors: ['required output field was missing'],
    }).category).toBe('runtime_transient')
  })
})
