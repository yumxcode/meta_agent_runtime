import type { EffectProvider } from '../registry/CapabilityRegistry.js'
import { isJsonValue } from '../runtime/GraphJson.js'
import type { JsonValue } from '../spec/GraphTypes.js'

export interface EffectProviderConformanceFixture {
  input: Readonly<Record<string, JsonValue>>
  idempotencyKey: string
  /** Observe actual externally-visible operations, not submit call count. */
  readSideEffectCount(): number | Promise<number>
  /** Advance a fake/real job after the first pending inspection. */
  settle?(receipt: JsonValue): void | Promise<void>
  maxInspectAttempts?: number
  verifyDistinctKey?: boolean
  /**
   * Observation Effects may create no external operation during submit.
   * Defaults to one for mutating Effects.
   */
  expectedSideEffectsPerKey?: number
}

export interface EffectProviderConformanceCheck {
  id: 'manifest' | 'json-receipt' | 'same-key-idempotency' | 'distinct-key-independence' | 'inspect-state-machine'
  passed: boolean
  detail: string
}

export interface EffectProviderConformanceReport {
  schemaVersion: 'effect-provider-conformance-1.0'
  provider: string
  passed: boolean
  checks: EffectProviderConformanceCheck[]
  firstReceipt?: JsonValue
  terminalInspection?: { status: 'succeeded' | 'failed'; output?: JsonValue; error?: string }
}

/**
 * Black-box provider contract test. It intentionally observes real side
 * effects through a fixture callback: equal receipts do not prove idempotency.
 */
export async function runEffectProviderConformance(
  provider: EffectProvider,
  fixture: EffectProviderConformanceFixture,
): Promise<EffectProviderConformanceReport> {
  const checks: EffectProviderConformanceCheck[] = []
  const providerName = `${provider.manifest.id}@${provider.manifest.version}`
  const expectedPerKey = fixture.expectedSideEffectsPerKey ?? 1
  if (!Number.isInteger(expectedPerKey) || expectedPerKey < 0) {
    throw new Error('expectedSideEffectsPerKey must be a non-negative integer')
  }
  if (expectedPerKey === 0 && fixture.verifyDistinctKey === true) {
    throw new Error('verifyDistinctKey cannot prove independence when expectedSideEffectsPerKey is zero')
  }
  const verifyDistinctKey = fixture.verifyDistinctKey ?? expectedPerKey > 0
  checks.push({
    id: 'manifest',
    passed: provider.manifest.pure === false && !!provider.manifest.integrity,
    detail: provider.manifest.pure === false
      ? `effect manifest ${providerName} is explicitly impure and integrity-pinned`
      : 'EffectProvider manifest must declare pure:false',
  })

  const before = await fixture.readSideEffectCount()
  let firstReceipt: JsonValue | undefined
  try {
    firstReceipt = await provider.submit(fixture.input, fixture.idempotencyKey)
    checks.push({ id: 'json-receipt', passed: isJsonValue(firstReceipt), detail: 'submit returned a JSON receipt' })
  } catch (error) {
    checks.push({ id: 'json-receipt', passed: false, detail: `first submit failed: ${message(error)}` })
  }

  if (firstReceipt !== undefined) {
    try {
      const replayReceipt = await provider.submit(fixture.input, fixture.idempotencyKey)
      const afterReplay = await fixture.readSideEffectCount()
      const passed = isJsonValue(replayReceipt) && afterReplay - before === expectedPerKey
      checks.push({
        id: 'same-key-idempotency', passed,
        detail: passed
          ? `repeated submit with the same key preserved ${expectedPerKey} externally-visible operation(s)`
          : `expected ${expectedPerKey} side effect(s) after same-key replay, observed ${afterReplay - before}`,
      })
    } catch (error) {
      checks.push({ id: 'same-key-idempotency', passed: false, detail: `same-key replay failed: ${message(error)}` })
    }

    if (verifyDistinctKey) {
      try {
        await provider.submit(fixture.input, `${fixture.idempotencyKey}:distinct`)
        const afterDistinct = await fixture.readSideEffectCount()
        const passed = afterDistinct - before === expectedPerKey * 2
        checks.push({
          id: 'distinct-key-independence', passed,
          detail: passed
            ? `a distinct idempotency key produced an independent operation set (${expectedPerKey * 2} total)`
            : `expected ${expectedPerKey * 2} total side effects after a distinct key, observed ${afterDistinct - before}`,
        })
      } catch (error) {
        checks.push({ id: 'distinct-key-independence', passed: false, detail: `distinct-key submit failed: ${message(error)}` })
      }
    }
  }

  let terminalInspection: EffectProviderConformanceReport['terminalInspection']
  if (provider.inspect && firstReceipt !== undefined) {
    try {
      const attempts = fixture.maxInspectAttempts ?? 5
      let sawPending = false
      for (let attempt = 0; attempt < attempts; attempt++) {
        const inspection = await provider.inspect(firstReceipt)
        if (inspection.status === 'pending') {
          sawPending = true
          if (fixture.settle) await fixture.settle(firstReceipt)
          continue
        }
        terminalInspection = inspection.status === 'succeeded'
          ? { status: 'succeeded', ...(inspection.output !== undefined ? { output: inspection.output } : {}) }
          : { status: 'failed', ...(inspection.error !== undefined ? { error: inspection.error } : {}) }
        break
      }
      const passed = terminalInspection !== undefined &&
        (terminalInspection.status === 'failed' || terminalInspection.output === undefined || isJsonValue(terminalInspection.output))
      checks.push({
        id: 'inspect-state-machine', passed,
        detail: passed
          ? `${sawPending ? 'pending transitioned to ' : ''}${terminalInspection!.status}`
          : `inspect did not reach a valid terminal state within ${attempts} attempts`,
      })
    } catch (error) {
      checks.push({ id: 'inspect-state-machine', passed: false, detail: `inspect failed: ${message(error)}` })
    }
  } else {
    checks.push({
      id: 'inspect-state-machine', passed: true,
      detail: provider.inspect ? 'inspect skipped because submit did not return a receipt' : 'provider is synchronous; inspect is optional',
    })
  }

  return {
    schemaVersion: 'effect-provider-conformance-1.0',
    provider: providerName,
    passed: checks.every(check => check.passed),
    checks,
    ...(firstReceipt !== undefined ? { firstReceipt } : {}),
    ...(terminalInspection ? { terminalInspection } : {}),
  }
}

export function assertEffectProviderConformance(report: EffectProviderConformanceReport): void {
  const failed = report.checks.filter(check => !check.passed)
  if (!failed.length) return
  throw new Error(`EffectProvider '${report.provider}' failed conformance:\n${failed.map(check => `- ${check.id}: ${check.detail}`).join('\n')}`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
