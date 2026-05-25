/**
 * V&V smoke tests — no external dependencies.
 *
 * Covers: VVHookChain registration, OOMChecker, PhysicsConstraintChecker,
 * DimensionChecker (stub), short-circuit on abort, multiple hooks, createDefaultVVChain.
 *
 * Run: cd packages/meta-agent-runtime && npx tsx examples/smoke-test-vv.ts
 */

import { VVHookChain } from '../src/validation/VVHookChain.js'
import { OOMChecker } from '../src/validation/built-in/OOMChecker.js'
import { PhysicsConstraintChecker } from '../src/validation/built-in/PhysicsConstraintChecker.js'
import { DimensionChecker } from '../src/validation/built-in/DimensionChecker.js'
import { createDefaultVVChain } from '../src/validation/index.js'
import { requiresAbort, requiresPause, failures, maxSeverity } from '../src/validation/types.js'
import type { VVHook, VVResult, VVContext } from '../src/validation/types.js'

// ── Harness ────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ⏳  ${name}`)
  try {
    await fn()
    process.stdout.write(`\r  ✅  ${name}\n`)
    passed++
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stdout.write(`\r  ❌  ${name}\n       ${msg}\n`)
    failed++
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

function ctx(overrides: Partial<VVContext> = {}): VVContext {
  return {
    phase: 'post_call',
    toolName: 'test_tool',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nV&V smoke tests\n')

  // ── 1: VVHookChain basics ─────────────────────────────────────────────────
  await test('VVHookChain: register and run a passing hook', async () => {
    const chain = new VVHookChain()
    const hook: VVHook = {
      name: 'AlwaysPass',
      phase: 'post_call',
      appliesTo: '*',
      run: async () => ({ hookName: 'AlwaysPass', passed: true, severity: 'info', message: 'ok', suggestedAction: 'continue' }),
    }
    chain.register(hook)
    const results = await chain.run(ctx())
    assert(results.length === 1, `Expected 1 result, got ${results.length}`)
    assert(results[0].passed, 'Expected hook to pass')
  })

  await test('VVHookChain: duplicate registration throws', async () => {
    const chain = new VVHookChain()
    const hook: VVHook = {
      name: 'Dup', phase: 'post_call', appliesTo: '*',
      run: async () => ({ hookName: 'Dup', passed: true, severity: 'info', message: '', suggestedAction: 'continue' }),
    }
    chain.register(hook)
    let threw = false
    try { chain.register(hook) } catch { threw = true }
    assert(threw, 'Expected duplicate registration to throw')
  })

  await test('VVHookChain: phase filtering — hook not called for wrong phase', async () => {
    const chain = new VVHookChain()
    let called = false
    const hook: VVHook = {
      name: 'PreCallOnly', phase: 'pre_call', appliesTo: '*',
      run: async () => { called = true; return { hookName: 'PreCallOnly', passed: true, severity: 'info', message: '', suggestedAction: 'continue' } },
    }
    chain.register(hook)
    const results = await chain.run(ctx({ phase: 'post_call' }))
    assert(results.length === 0, 'Hook should not run for post_call phase')
    assert(!called, 'Hook should not have been called')
  })

  await test('VVHookChain: appliesTo filtering — hook skipped for wrong tool', async () => {
    const chain = new VVHookChain()
    const hook: VVHook = {
      name: 'OnlyFEM', phase: 'post_call', appliesTo: ['fem_tool'],
      run: async () => ({ hookName: 'OnlyFEM', passed: false, severity: 'critical', message: 'bad', suggestedAction: 'abort' }),
    }
    chain.register(hook)
    const results = await chain.run(ctx({ toolName: 'other_tool' }))
    assert(results.length === 0, 'Hook should not run for other_tool')
  })

  await test('VVHookChain: short-circuit on abort stops subsequent hooks', async () => {
    const chain = new VVHookChain()
    let secondCalled = false

    chain.register({
      name: 'AbortHook', phase: 'post_call', appliesTo: '*',
      run: async () => ({ hookName: 'AbortHook', passed: false, severity: 'critical', message: 'abort!', suggestedAction: 'abort' }),
    })
    chain.register({
      name: 'AfterAbort', phase: 'post_call', appliesTo: '*',
      run: async () => { secondCalled = true; return { hookName: 'AfterAbort', passed: true, severity: 'info', message: '', suggestedAction: 'continue' } },
    })

    await chain.run(ctx())
    assert(!secondCalled, 'Second hook should not run after abort')
  })

  await test('VVHookChain: buggy hook does not crash the chain', async () => {
    const chain = new VVHookChain()
    chain.register({
      name: 'CrashHook', phase: 'post_call', appliesTo: '*',
      run: async () => { throw new Error('intentional crash') },
    })
    const results = await chain.run(ctx())
    assert(results.length === 1, 'Should get 1 result even from crashing hook')
    assert(results[0].passed, 'Crashing hook should produce a passing result (not block)')
  })

  // ── 2: OOMChecker ─────────────────────────────────────────────────────────
  await test('OOMChecker: passes for reasonable values', async () => {
    const checker = new OOMChecker()
    const result = await checker.run(ctx({
      output: { stress: 2e8, temperature: 300 },  // 200 MPa stress, 300 K
    }))
    assert(result.passed, `Expected pass, got: ${result.message}`)
  })

  await test('OOMChecker: catches absurd stress value (unit confusion)', async () => {
    const checker = new OOMChecker()
    const result = await checker.run(ctx({
      output: { yield_strength: 2.5e11 },  // 250 GPa — physically impossible for common metals
    }))
    assert(!result.passed, 'Expected OOM failure for absurd stress')
    assert(result.severity === 'error' || result.severity === 'critical', `Expected error/critical, got ${result.severity}`)
    assert(result.message.includes('yield_strength'), 'Message should mention the field')
  })

  await test('OOMChecker: catches efficiency > 1', async () => {
    const checker = new OOMChecker()
    const result = await checker.run(ctx({
      output: { efficiency: 1.5 },
    }))
    assert(!result.passed, 'Expected OOM failure for efficiency > 1')
  })

  await test('OOMChecker: passes with PhysicalQuantity-shaped object {value, unit}', async () => {
    const checker = new OOMChecker()
    const result = await checker.run(ctx({
      output: { stress: { value: 5e8, unit: 'Pa' } },
    }))
    assert(result.passed, `Expected pass for {value: 5e8, unit: 'Pa'}, got: ${result.message}`)
  })

  await test('OOMChecker: skips unknown fields (no false positives)', async () => {
    const checker = new OOMChecker()
    const result = await checker.run(ctx({
      output: { foo_bar_baz: 99999, some_string: 'hello' },
    }))
    assert(result.passed, 'Should pass for unknown fields')
  })

  await test('OOMChecker: accepts custom reference DB', async () => {
    const checker = new OOMChecker({
      '*': { custom_qty: { min: 10, max: 100, unit: 'custom' } },
    })
    const bad = await checker.run(ctx({ output: { custom_qty: 1e6 } }))
    assert(!bad.passed, 'Should fail for value way outside custom range')
    const good = await checker.run(ctx({ output: { custom_qty: 50 } }))
    assert(good.passed, 'Should pass for value inside custom range')
  })

  // ── 3: PhysicsConstraintChecker ───────────────────────────────────────────
  await test('PhysicsConstraintChecker: passes for normal output', async () => {
    const checker = new PhysicsConstraintChecker()
    const result = await checker.run(ctx({
      output: { efficiency: 0.85, temperature_k: 310 },
    }))
    assert(result.passed, `Expected pass, got: ${result.message}`)
  })

  await test('PhysicsConstraintChecker: catches efficiency > 1', async () => {
    const checker = new PhysicsConstraintChecker()
    const result = await checker.run(ctx({ output: { efficiency: 1.05 } }))
    assert(!result.passed, 'Expected failure for efficiency > 1')
    assert(result.severity === 'critical', `Expected critical, got ${result.severity}`)
    assert(result.suggestedAction === 'abort', `Expected abort, got ${result.suggestedAction}`)
  })

  await test('PhysicsConstraintChecker: catches negative temperature_k', async () => {
    const checker = new PhysicsConstraintChecker()
    const result = await checker.run(ctx({ output: { temperature_k: -10 } }))
    assert(!result.passed, 'Expected failure for T < 0 K')
    assert(result.message.includes('temperature_k'), 'Message should mention the field')
  })

  await test('PhysicsConstraintChecker: catches probability out of [0,1]', async () => {
    const checker = new PhysicsConstraintChecker()
    const r1 = await checker.run(ctx({ output: { probability: -0.1 } }))
    assert(!r1.passed, 'Should fail for probability < 0')
    const r2 = await checker.run(ctx({ output: { probability: 1.001 } }))
    assert(!r2.passed, 'Should fail for probability > 1')
    const r3 = await checker.run(ctx({ output: { probability: 0.5 } }))
    assert(r3.passed, 'Should pass for probability = 0.5')
  })

  await test('PhysicsConstraintChecker: runs on pre_call phase too', async () => {
    const checker = new PhysicsConstraintChecker()
    const result = await checker.run(ctx({
      phase: 'pre_call',
      input: { efficiency: 1.5 },
    }))
    assert(!result.passed, 'Should catch bad efficiency in pre_call input')
  })

  // ── 4: DimensionChecker (stub) ────────────────────────────────────────────
  await test('DimensionChecker: stub always passes', async () => {
    const checker = new DimensionChecker()
    const result = await checker.run(ctx({ output: { stress: 1e8 } }))
    assert(result.passed, 'Stub should always pass')
    assert(result.message.includes('stub'), 'Message should mention stub status')
  })

  // ── 5: Helper functions ───────────────────────────────────────────────────
  await test('requiresAbort() / requiresPause() / failures() / maxSeverity()', async () => {
    const results: VVResult[] = [
      { hookName: 'A', passed: true,  severity: 'info',     message: '', suggestedAction: 'continue' },
      { hookName: 'B', passed: false, severity: 'warning',  message: '', suggestedAction: 'warn_user' },
      { hookName: 'C', passed: false, severity: 'error',    message: '', suggestedAction: 'pause_and_ask' },
    ]
    assert(!requiresAbort(results), 'No abort in results')
    assert(requiresPause(results),  'pause_and_ask present')
    assert(failures(results).length === 2, 'Two failures')
    assert(maxSeverity(results) === 'error', `Expected error, got ${maxSeverity(results)}`)

    const withAbort: VVResult[] = [
      ...results,
      { hookName: 'D', passed: false, severity: 'critical', message: '', suggestedAction: 'abort' },
    ]
    assert(requiresAbort(withAbort), 'Should detect abort')
    assert(maxSeverity(withAbort) === 'critical', 'Max severity should be critical')
  })

  // ── 6: createDefaultVVChain ───────────────────────────────────────────────
  await test('createDefaultVVChain() registers 3 hooks and runs successfully', async () => {
    const chain = createDefaultVVChain()
    assert(chain.names.length === 3, `Expected 3 hooks, got ${chain.names.length}: ${chain.names}`)
    assert(chain.names.includes('OOMChecker'), 'Missing OOMChecker')
    assert(chain.names.includes('PhysicsConstraintChecker'), 'Missing PhysicsConstraintChecker')
    assert(chain.names.includes('DimensionChecker'), 'Missing DimensionChecker')

    // Run the full chain — no failures on normal output
    const results = await chain.run(ctx({ output: { temperature_k: 298, efficiency: 0.9, stress: 1e8 } }))
    const bad = failures(results)
    assert(bad.length === 0, `Expected no failures, got: ${bad.map(r => r.message).join('; ')}`)
  })

  await test('createDefaultVVChain() catches physics violation end-to-end', async () => {
    const chain = createDefaultVVChain()
    const results = await chain.run(ctx({ output: { efficiency: 1.2, temperature_k: 350 } }))
    const bad = failures(results)
    assert(bad.length >= 1, 'Expected at least 1 failure')
    assert(requiresAbort(results), 'Expected abort for efficiency > 1')
  })

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
