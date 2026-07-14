import { describe, expect, it } from 'vitest'
import {
  MAX_SCENARIO_HOOK_OUTPUT_BYTES,
  runScenarioHook,
} from '../ScenarioHost.js'

describe('ScenarioHost', () => {
  it('bounds a cooperative async hook by deadline', async () => {
    await expect(runScenarioHook({
      scenarioId: 'test/slow@1', hook: 'slow', timeoutMs: 10,
      invoke: signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    })).rejects.toThrow(/timed out after 10ms/)
  })

  it('rejects oversized and invalid hook output', async () => {
    await expect(runScenarioHook({
      scenarioId: 'test/large@1', hook: 'large',
      invoke: async () => 'x'.repeat(MAX_SCENARIO_HOOK_OUTPUT_BYTES + 1),
    })).rejects.toThrow(/returned .* bytes/)
    await expect(runScenarioHook({
      scenarioId: 'test/invalid@1', hook: 'gate',
      invoke: async () => ({ verdict: 'maybe' }),
      validate: value => value.verdict === 'pass' ? [] : ['bad verdict'],
    })).rejects.toThrow(/bad verdict/)
  })
})
