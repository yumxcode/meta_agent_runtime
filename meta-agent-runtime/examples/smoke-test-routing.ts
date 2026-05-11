/**
 * smoke-test-routing.ts
 *
 * Deterministic unit tests for ModeDetector + SessionRouter.
 * No LLM calls — all assertions are on mode detection logic only.
 *
 * Run:
 *   cd packages/meta-agent-runtime
 *   npx tsx examples/smoke-test-routing.ts
 */

import { ModeDetector } from '../src/routing/ModeDetector.js'
import { SessionRouter } from '../src/routing/SessionRouter.js'
import { MODE_WEIGHT } from '../src/routing/types.js'
import type { SessionMode } from '../src/routing/types.js'
import { MetaAgentContextStore } from '../src/coordination/MetaAgentContextStore.js'

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✓ ${label}`); passed++ }
  else { console.error(`  ✗ FAIL: ${label}`); failed++ }
}

function assertMode(prompt: string, expected: SessionMode, label?: string): void {
  const result = ModeDetector.detectSync(prompt)
  const ok = result.mode === expected
  const desc = label ?? `"${prompt.slice(0, 60)}" → ${expected}`
  if (ok) {
    console.log(`  ✓ ${desc}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${desc} (got ${result.mode}, signals: ${result.signals.map(s => s.label).join('; ')})`)
    failed++
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ─────────────────────────────────────────`)
}

// ── Test 1: CAMPAIGN signal detection ────────────────────────────────────────

function testCampaignSignals(): void {
  section('ModeDetector — CAMPAIGN signals')

  assertMode('我们来做一个DOE，扫描一下参数空间', 'campaign', 'DOE keyword (Chinese)')
  assertMode('Run a DOE sweep over the design variables', 'campaign', 'DOE keyword (English)')
  assertMode('帮我做参数扫描，找到最优点', 'campaign', 'parameter sweep (Chinese)')
  assertMode('Set up a parameter sweep from x=0 to 10', 'campaign', 'parameter sweep (English)')
  assertMode('我需要Pareto前沿分析，两个目标函数', 'campaign', 'Pareto keyword (Chinese)')
  assertMode('Compute the Pareto front for these two objectives', 'campaign', 'Pareto keyword (English)')
  assertMode('请在后台运行评估任务', 'campaign', 'background run keyword')
  assertMode('优化这个设计空间，使用L0然后L1保真度', 'campaign', 'design space + fidelity')
  assertMode('launch a multi-objective engineering optimization campaign', 'campaign', 'campaign keyword')
  assertMode('我们做多目标优化，最小化成本同时最大化性能', 'campaign', 'multi-objective (Chinese)')
  assertMode('采样100个设计点然后并行评估', 'campaign', 'sample + parallel eval')
}

// ── Test 2: DIRECT signal detection ──────────────────────────────────────────

function testDirectSignals(): void {
  section('ModeDetector — DIRECT signals')

  assertMode('解释一下什么是Pareto最优', 'direct', '"explain" opener (Chinese)')
  assertMode('Explain what Pareto optimality means', 'direct', '"explain" opener (English)')
  assertMode('什么是设计空间？', 'direct', '"what is" question (Chinese)')
  assertMode('What is a design space?', 'direct', '"what is" question (English)')
  assertMode('帮我看看这段代码', 'direct', '"review" opener (Chinese)')
  assertMode('review this snippet', 'direct', '"review" opener (English)')
  assertMode('总结一下我们今天的讨论', 'direct', '"summarize" opener (Chinese)')
  assertMode('Summarize the key points so far', 'direct', '"summarize" opener (English)')
  assertMode('讨论一下各种采样策略的优缺点', 'direct', '"discuss" opener (Chinese)')
  assertMode('discuss the tradeoffs of LHS vs grid sampling', 'direct', '"discuss" opener (English)')
  assertMode('帮我分析下这个方案', 'direct', '"analyze" opener (Chinese)')
}

// ── Test 3: Short question heuristic ─────────────────────────────────────────

function testShortQuestionHeuristic(): void {
  section('ModeDetector — short question heuristic')

  assertMode('拉丁超立方采样和网格采样哪个好？', 'direct', 'short question < 120 chars')
  assertMode('LHS vs grid — which is better?', 'direct', 'short English question')
  // Long prompt without explicit signals → agentic (safe default)
  const longPrompt = `我有一个工程问题需要解决，涉及到多个参数的组合，
  每个参数的范围都比较广，我想了解一下不同的策略。
  这个问题在工程实践中很常见，需要综合考虑多个因素。`
  assertMode(longPrompt, 'agentic', 'long multi-line prompt → agentic default')
}

// ── Test 4: Priority rules ────────────────────────────────────────────────────

function testPriorityRules(): void {
  section('ModeDetector — priority rules')

  // Campaign wins over direct opener
  assertMode('解释一下DOE参数扫描的过程并帮我启动一个', 'campaign',
    'campaign signal beats "explain" opener')

  // Tools flag forces minimum AGENTIC even for a short question
  const result = ModeDetector.detectSync('LHS还是网格采样好？', 'auto', true)
  assert(result.mode !== 'direct', 'hasTools=true prevents DIRECT mode')
  assert(result.mode === 'agentic' || result.mode === 'campaign',
    'hasTools=true → minimum AGENTIC')

  // Explicit hint overrides everything
  const explicitCampaign = ModeDetector.detectSync(
    '解释一下什么是Pareto最优',  // would be DIRECT without hint
    'campaign',
  )
  assert(explicitCampaign.mode === 'campaign', 'explicit hint=campaign overrides heuristic')
  assert(explicitCampaign.confidence === 'explicit', 'confidence=explicit when hint provided')

  const explicitDirect = ModeDetector.detectSync(
    '启动DOE并行评估 campaign',  // would be CAMPAIGN without hint
    'direct',
  )
  assert(explicitDirect.mode === 'direct', 'explicit hint=direct overrides campaign signal')
}

// ── Test 5: MODE_WEIGHT ordering ─────────────────────────────────────────────

function testModeWeights(): void {
  section('MODE_WEIGHT ordering')

  assert(MODE_WEIGHT.direct < MODE_WEIGHT.agentic, 'direct < agentic')
  assert(MODE_WEIGHT.agentic < MODE_WEIGHT.campaign, 'agentic < campaign')
  assert(MODE_WEIGHT.direct < MODE_WEIGHT.campaign, 'direct < campaign (transitive)')
}

// ── Test 6: SessionRouter construction and registerTool upgrade ───────────────

function testSessionRouterConstruction(): void {
  section('SessionRouter — construction and mode upgrade')

  // Before first submit, mode is null
  const router = new SessionRouter({ apiKey: 'test-key' })
  assert(router.mode === null, 'mode is null before first submit')
  assert(!router.ready, 'ready is false before first submit')

  // registerTool raises mode
  const router2 = new SessionRouter({ apiKey: 'test-key' })
  assert(router2.mode === null, 'mode starts as null')

  // After registerTool, the pending tool buffer has 1 item.
  // Mode won't be set until submit(), but the hint will be at minimum 'agentic'.
  // We verify this by checking that the internal state is consistent.
  // (We can't directly access private fields, so we verify via the public API
  // that calling registerTool doesn't throw and router remains usable.)
  router2.registerTool({
    name: 'test_tool',
    description: 'A test tool',
    inputSchema: { type: 'object', properties: {} },
    call: async () => ({ content: 'ok', isError: false }),
  })
  assert(true, 'registerTool() before first submit does not throw')

  // getMessages returns [] before first submit
  assert(router.getMessages().length === 0, 'getMessages() returns [] before submit')

  // getUsage returns empty before first submit
  const usage = router.getUsage()
  assert(usage.inputTokens === 0, 'getUsage().inputTokens = 0 before submit')

  // getEstimatedCost returns 0 before first submit
  assert(router.getEstimatedCost() === 0, 'getEstimatedCost() = 0 before submit')

  // getSessionId returns '' before first submit
  assert(router.getSessionId() === '', 'getSessionId() = "" before submit')

  // interrupt() is safe to call before first submit (no-op)
  router.interrupt()
  assert(true, 'interrupt() before first submit does not throw')
}

// ── Test 7: SessionRouter with explicit mode hint ────────────────────────────

function testSessionRouterWithHint(): void {
  section('SessionRouter — explicit mode hints')

  // With mode: 'direct', the router should create a direct session
  const directRouter = new SessionRouter({ apiKey: 'test-key', mode: 'direct' })
  assert(directRouter.mode === null, 'explicit mode is applied lazily (on first submit)')

  // With mode: 'campaign', even without campaign signals
  const campaignRouter = new SessionRouter({ apiKey: 'test-key', mode: 'campaign' })
  assert(campaignRouter.mode === null, 'campaign mode also applied lazily')

  // Register tool on an explicit campaign router — doesn't break anything
  campaignRouter.registerTool({
    name: 'calc',
    description: 'Calculator',
    inputSchema: { type: 'object', properties: {} },
    call: async () => ({ content: '42', isError: false }),
  })
  assert(true, 'registerTool on campaign router does not throw')
}

// ── Test 8: ModeDetector async (no live campaigns) ───────────────────────────

async function testModeDetectorAsync(): Promise<void> {
  section('ModeDetector.detect() async — no active campaigns')

  // Ensure no active campaigns on disk
  await MetaAgentContextStore.clear()

  // Short question with no campaigns → DIRECT
  const r1 = await ModeDetector.detect('什么是Pareto最优？')
  assert(r1.mode === 'direct', 'async: short question → direct (no campaigns)')

  // Campaign prompt → CAMPAIGN
  const r2 = await ModeDetector.detect('我需要启动一个DOE campaign来优化设计空间')
  assert(r2.mode === 'campaign', 'async: campaign prompt → campaign')

  // Inject a fake active campaign and verify bump from DIRECT to AGENTIC
  await MetaAgentContextStore.write({
    schemaVersion: '1.0',
    updatedAt: new Date().toISOString(),
    activeCampaigns: [{
      campaignId: 'c_test_router',
      projectName: 'Router Test',
      phase: 'EVALUATING_L0',
      contextBlock: '### ⏳ Campaign: Router Test',
    }],
  })

  const r3 = await ModeDetector.detect('什么是Pareto最优？')
  assert(r3.mode === 'agentic', 'async: short question bumped to agentic when campaigns active')
  assert(r3.confidence === 'env', 'async: confidence=env when bumped by active campaign')
  assert(
    r3.signals.some(s => s.label.includes('active campaigns')),
    'async: env signal appears in signals list',
  )

  // Campaign prompt with active campaigns → still CAMPAIGN (no downgrade)
  const r4 = await ModeDetector.detect('我需要启动一个DOE campaign来优化设计空间')
  assert(r4.mode === 'campaign', 'async: campaign prompt stays campaign even with active campaigns')

  // Clean up
  await MetaAgentContextStore.clear()
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== meta-agent routing smoke test ===')

  try {
    testCampaignSignals()
    testDirectSignals()
    testShortQuestionHeuristic()
    testPriorityRules()
    testModeWeights()
    testSessionRouterConstruction()
    testSessionRouterWithHint()
    await testModeDetectorAsync()
  } catch (err) {
    console.error('\n❌ Unexpected error during smoke test:', err)
    process.exit(1)
  }

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)

  if (failed > 0) {
    console.error('❌ Some assertions failed.')
    process.exit(1)
  } else {
    console.log('✅ All assertions passed.')
  }
}

main()
