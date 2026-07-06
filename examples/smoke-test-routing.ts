/**
 * smoke-test-routing.ts
 *
 * Deterministic smoke tests for explicit SessionRouter mode selection.
 * No LLM calls — all assertions use primeMode() without initialising backends.
 *
 * Run:
 *   npx tsx examples/smoke-test-routing.ts
 */

import { SessionRouter } from '../src/routing/SessionRouter.js'
import { MODE_WEIGHT } from '../src/routing/types.js'
import type { SessionMode } from '../src/routing/types.js'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ─────────────────────────────────────────`)
}

async function testDefaultMode(): Promise<void> {
  section('SessionRouter — default mode')

  const router = new SessionRouter()
  assert(router.mode === null, 'mode is null before primeMode()')
  assert(!router.ready, 'ready is false before backend init')

  const selected = await router.primeMode('帮我开发四足机器人的自主导航算法 ROS2')
  assert(selected === 'agentic', 'prompt text does not auto-select robotics')
  assert(router.mode === 'agentic', 'default mode is agentic')
}

async function testExplicitModes(): Promise<void> {
  section('SessionRouter — explicit modes')

  const modes: SessionMode[] = ['agentic', 'auto', 'simple_auto', 'campaign', 'robotics']
  for (const mode of modes) {
    const router = new SessionRouter({ mode })
    const selected = await router.primeMode('prompt wording should not affect explicit mode')
    assert(selected === mode, `explicit mode=${mode} is preserved`)
  }
}

function testRegisterToolBeforeInit(): void {
  section('SessionRouter — registerTool before backend init')

  const router = new SessionRouter()
  router.registerTool({
    name: 'test_tool',
    description: 'A test tool',
    inputSchema: { type: 'object', properties: {} },
    call: async () => ({ content: 'ok', isError: false }),
  })

  assert(router.mode === 'agentic', 'registerTool selects the default agentic mode')
  assert(!router.ready, 'registerTool does not initialise backend')
  assert(router.getMessages().length === 0, 'getMessages() returns [] before submit')
  assert(router.getUsage().inputTokens === 0, 'getUsage().inputTokens = 0 before submit')
  assert(router.getEstimatedCost() === 0, 'getEstimatedCost() = 0 before submit')
  assert(router.getSessionId() === '', 'getSessionId() = "" before submit')
  router.interrupt()
  assert(true, 'interrupt() before submit does not throw')
}

function testModeWeights(): void {
  section('MODE_WEIGHT ordering')

  assert(MODE_WEIGHT.auto === MODE_WEIGHT.agentic, 'auto has same weight as agentic')
  assert(MODE_WEIGHT.simple_auto === MODE_WEIGHT.agentic, 'simple_auto has same weight as agentic')
  assert(MODE_WEIGHT.campaign > MODE_WEIGHT.agentic, 'campaign outranks agentic')
  assert(MODE_WEIGHT.robotics > MODE_WEIGHT.campaign, 'robotics outranks campaign')
}

async function main(): Promise<void> {
  console.log('=== meta-agent routing smoke test ===')

  try {
    await testDefaultMode()
    await testExplicitModes()
    testRegisterToolBeforeInit()
    testModeWeights()
  } catch (err) {
    console.error('\nUnexpected error during smoke test:', err)
    process.exit(1)
  }

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)

  if (failed > 0) {
    process.exit(1)
  }
}

main()
