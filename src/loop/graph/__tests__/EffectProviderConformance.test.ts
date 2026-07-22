import { describe, expect, it } from 'vitest'
import {
  assertEffectProviderConformance,
  runEffectProviderConformance,
  type EffectProvider,
  type JsonValue,
} from '../index.js'

describe('Effect Provider conformance', () => {
  it('verifies externally-observed idempotency and inspect progression', async () => {
    const operations = new Map<string, { done: boolean }>()
    let request = 0
    const provider: EffectProvider = {
      manifest: { id: 'test/conformant', version: '1', integrity: 'test:conformant-v1', pure: false },
      async submit(_input, key): Promise<JsonValue> {
        if (!operations.has(key)) operations.set(key, { done: false })
        return { key, request: ++request }
      },
      async inspect(receipt) {
        const key = (receipt as { key: string }).key
        return operations.get(key)?.done
          ? { status: 'succeeded', output: { key, artifact: 'ready' } }
          : { status: 'pending' }
      },
    }
    const report = await runEffectProviderConformance(provider, {
      input: { task: 'train' }, idempotencyKey: 'job-1',
      readSideEffectCount: () => operations.size,
      settle: receipt => { operations.get((receipt as { key: string }).key)!.done = true },
    })
    expect(report.passed).toBe(true)
    expect(report.terminalInspection?.status).toBe('succeeded')
    expect(() => assertEffectProviderConformance(report)).not.toThrow()
  })

  it('rejects a provider that repeats a side effect for the same key', async () => {
    let sideEffects = 0
    const provider: EffectProvider = {
      manifest: { id: 'test/non-idempotent', version: '1', integrity: 'test:bad-v1', pure: false },
      async submit() { sideEffects++; return { request: sideEffects } },
    }
    const report = await runEffectProviderConformance(provider, {
      input: { task: 'unsafe' }, idempotencyKey: 'same-key', readSideEffectCount: () => sideEffects,
    })
    expect(report.passed).toBe(false)
    expect(report.checks.find(check => check.id === 'same-key-idempotency')?.passed).toBe(false)
    expect(() => assertEffectProviderConformance(report)).toThrow(/same-key-idempotency/)
  })
})
