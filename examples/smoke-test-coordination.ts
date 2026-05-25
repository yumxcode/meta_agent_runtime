/**
 * smoke-test-coordination.ts
 *
 * End-to-end smoke test for the Phase 3 coordination layer.
 * No LLM calls — all code paths are deterministic.
 *
 * Run:
 *   cd packages/meta-agent-runtime
 *   npx tsx examples/smoke-test-coordination.ts
 *
 * Expected: all assertions pass, process exits 0.
 */

import { CampaignStateStore } from '../src/coordination/CampaignStateStore.js'
import { MetaAgentContextStore } from '../src/coordination/MetaAgentContextStore.js'
import { CampaignMonitor } from '../src/coordination/CampaignMonitor.js'
import { ParetoAnalyzer } from '../src/coordination/ParetoAnalyzer.js'
import { buildCapsule } from '../src/coordination/CapsuleBuilder.js'
import type {
  DesignSpace, EvaluationResult, DesignPoint,
} from '../src/coordination/types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function assertApprox(a: number, b: number, label: string, tol = 1e-9): void {
  assert(Math.abs(a - b) < tol, `${label} (got ${a}, expected ≈ ${b})`)
}

function section(title: string): void {
  console.log(`\n── ${title} ─────────────────────────────────────────`)
}

// ── Sample design space (2 vars, 2 objectives, 1 constraint) ─────────────────

const DESIGN_SPACE: DesignSpace = {
  variables: [
    { name: 'x', type: 'continuous', bounds: [0, 10], unit: 'm' },
    { name: 'y', type: 'continuous', bounds: [0, 10], unit: 'm' },
  ],
  objectives: [
    { name: 'cost',   direction: 'minimize', unit: 'USD' },
    { name: 'perf',   direction: 'maximize', unit: 'W' },
  ],
  constraints: [
    { name: 'budget', type: 'inequality', expression: 'cost <= 100' },
  ],
}

function makePoint(id: string, x: number, y: number): DesignPoint {
  return { id, variables: { x, y } }
}

function makeResult(
  id: string,
  x: number,
  y: number,
  cost: number,
  perf: number,
  feasible = true,
): EvaluationResult {
  return {
    designPoint: makePoint(id, x, y),
    objectives: { cost, perf },
    constraintsSatisfied: { budget: feasible },
    feasible,
    fidelity: 0,
    provenanceId: `prov-${id}`,
    evaluatedBy: 'smoke-test',
    durationMs: 10,
  }
}

// ── Test 1: ParetoAnalyzer ────────────────────────────────────────────────────

async function testParetoAnalyzer(): Promise<void> {
  section('ParetoAnalyzer')

  const analyzer = new ParetoAnalyzer(DESIGN_SPACE.objectives)

  // Tradeoff dataset: each objective requires sacrificing the other.
  //   minimize cost, maximize perf
  //   A: (cost=10, perf=10) — cheapest but worst performance
  //   B: (cost=50, perf=50) — balanced tradeoff
  //   C: (cost=90, perf=90) — most expensive but best performance
  //   D: (cost=60, perf=40) — dominated by B (B is cheaper AND better perf)
  //   E: feasible=false     — infeasible, excluded from rank1
  const results: EvaluationResult[] = [
    makeResult('A', 1, 1, 10, 10),
    makeResult('B', 2, 2, 50, 50),
    makeResult('C', 3, 3, 90, 90),
    makeResult('D', 4, 4, 60, 40),
    makeResult('E', 5, 5, 120, 80, false),
  ]

  const front = analyzer.analyze(results)

  // A, B, C form the Pareto front (each dominates on one objective)
  // D is dominated by B (cost 50<60 AND perf 50>40)
  // E is excluded because feasible=false
  const rank1Ids = front.rank1.map(r => r.designPoint.id).sort()
  assert(rank1Ids.includes('A'), 'A is in Pareto front')
  assert(rank1Ids.includes('B'), 'B is in Pareto front')
  assert(rank1Ids.includes('C'), 'C is in Pareto front')
  assert(!rank1Ids.includes('D'), 'D is dominated (not in rank1)')
  assert(!rank1Ids.includes('E'), 'E is infeasible (not in rank1)')
  assert(front.rank1.length === 3, `rank1 size = 3 (got ${front.rank1.length})`)

  // Hypervolume should be positive (2-objective mode)
  assert(front.hypervolume !== null, 'hypervolume computed')
  assert(front.hypervolume! > 0, `hypervolume > 0 (got ${front.hypervolume})`)

  // Crowding distance: boundary points → Infinity
  const dist = analyzer.crowdingDistance(front.rank1)
  const dA = dist.get('A') ?? 0
  const dC = dist.get('C') ?? 0
  assert(dA === Infinity || dC === Infinity, 'boundary point crowding distance = Infinity')

  // Empty input
  const empty = analyzer.analyze([])
  assert(empty.rank1.length === 0, 'empty input returns empty front')

  // Single point
  const single = analyzer.analyze([makeResult('X', 1, 1, 5, 100)])
  assert(single.rank1.length === 1, 'single point → rank1 length 1')
}

// ── Test 2: CampaignStateStore ────────────────────────────────────────────────

async function testCampaignStateStore(): Promise<void> {
  section('CampaignStateStore')

  // Create
  const store = await CampaignStateStore.create('Smoke Test Project', DESIGN_SPACE)
  assert(store.phase === 'IDLE', 'initial phase = IDLE')
  assert(store.campaignId.startsWith('c_'), `campaignId has c_ prefix (${store.campaignId})`)
  assert(store.projectName === 'Smoke Test Project', 'projectName preserved')

  // Load by ID
  const loaded = await CampaignStateStore.load(store.campaignId)
  assert(loaded.campaignId === store.campaignId, 'load() returns same campaignId')
  assert(loaded.phase === 'IDLE', 'loaded phase = IDLE')

  // Phase transition: IDLE → SAMPLING
  await store.transitionPhase('SAMPLING')
  assert(store.phase === 'SAMPLING', 'transitioned to SAMPLING')

  // Invalid transition should throw
  let threw = false
  try {
    await store.transitionPhase('DONE')  // SAMPLING → DONE not allowed
  } catch {
    threw = true
  }
  assert(threw, 'invalid transition throws')

  // Add design points
  const points: DesignPoint[] = [
    makePoint('p1', 1, 1),
    makePoint('p2', 5, 5),
    makePoint('p3', 9, 9),
  ]
  await store.setSampledPoints(points)
  assert(store.sampledPoints.length === 3, 'sampledPoints stored (3)')

  // Register pending tasks
  await store.registerPendingTasks(['task-1', 'task-2'])
  assert(store.pendingTaskCount === 2, 'pendingTaskCount = 2')
  assert(!store.isCurrentPhaseComplete(), 'phase not complete (tasks pending)')

  // Transition to EVALUATING_L0, submit results, complete tasks
  await store.transitionPhase('EVALUATING_L0')

  const r1 = makeResult('p1', 1, 1, 10, 90)
  const r2 = makeResult('p2', 5, 5, 50, 50)
  const r3 = makeResult('p3', 9, 9, 90, 10)
  await store.submitResult(r1)
  await store.submitResult(r2)
  await store.submitResult(r3)

  await store.completeTask('task-1')
  await store.completeTask('task-2')

  assert(store.pendingTaskCount === 0, 'pendingTaskCount = 0 after completing tasks')
  assert(store.completedTaskCount === 2, 'completedTaskCount = 2')
  assert(store.isCurrentPhaseComplete(), 'phase complete')

  // getBestFidelityEvaluations
  const evals = await store.getBestFidelityEvaluations(true)
  assert(evals.length === 3, `getBestFidelityEvaluations returns 3 (got ${evals.length})`)

  // listActive
  const active = await CampaignStateStore.listActive()
  const ids = active.map(s => s.campaignId)
  assert(ids.includes(store.campaignId), 'store appears in listActive()')

  // Capsule round-trip
  const analyzer = new ParetoAnalyzer(DESIGN_SPACE.objectives)
  const front = analyzer.analyze(evals)
  const capsule = buildCapsule(store, front)
  await store.saveCapsule(capsule)

  const readBack = await store.getCapsule()
  assert(readBack !== null, 'getCapsule() returns non-null after save')
  assert(readBack!.campaignId === store.campaignId, 'capsule campaignId matches')
  assert(readBack!.contextBlock.length > 0, 'contextBlock non-empty')

  // Advance to DONE
  await store.transitionPhase('PARETO_READY_L0')
  await store.transitionPhase('DONE')
  assert(store.phase === 'DONE', 'phase = DONE')
}

// ── Test 3: MetaAgentContextStore ─────────────────────────────────────────────

async function testMetaAgentContextStore(): Promise<void> {
  section('MetaAgentContextStore')

  // Start clean
  await MetaAgentContextStore.clear()
  const initial = await MetaAgentContextStore.read()
  assert(initial === null, 'read() returns null when no file exists')

  // Write a context
  await MetaAgentContextStore.write({
    schemaVersion: '1.0',
    updatedAt: new Date().toISOString(),
    activeCampaigns: [
      {
        campaignId: 'c_abc123_test',
        projectName: 'Test Project',
        phase: 'EVALUATING_L0',
        contextBlock: '### ⏳ Campaign: Test Project [Running L0]\nProgress: 2/10 (20%)',
      },
    ],
  })

  const ctx = await MetaAgentContextStore.read()
  assert(ctx !== null, 'read() returns non-null after write()')
  assert(ctx!.schemaVersion === '1.0', 'schemaVersion = 1.0')
  assert(ctx!.activeCampaigns.length === 1, 'one active campaign')
  assert(ctx!.activeCampaigns[0]!.projectName === 'Test Project', 'projectName preserved')

  // buildInjectionBlock
  const block = await MetaAgentContextStore.buildInjectionBlock()
  assert(block.length > 0, 'buildInjectionBlock() returns non-empty string')
  assert(block.includes('Active Engineering Campaigns'), 'injection block has header')
  assert(block.includes('Test Project'), 'injection block contains campaign name')

  // refresh with empty → clear
  await MetaAgentContextStore.refresh([])
  const afterClear = await MetaAgentContextStore.read()
  assert(afterClear === null, 'refresh([]) clears the file')

  // empty injection block
  const emptyBlock = await MetaAgentContextStore.buildInjectionBlock()
  assert(emptyBlock === '', 'buildInjectionBlock() returns "" when no campaigns')
}

// ── Test 4: CapsuleBuilder ────────────────────────────────────────────────────

async function testCapsuleBuilder(): Promise<void> {
  section('CapsuleBuilder')

  // We need a store in a known phase to test the builder
  const store = await CampaignStateStore.create('Capsule Test', DESIGN_SPACE)
  await store.transitionPhase('SAMPLING')

  const pts = [makePoint('q1', 1, 1), makePoint('q2', 5, 5)]
  await store.setSampledPoints(pts)
  await store.registerPendingTasks(['t1'])
  await store.transitionPhase('EVALUATING_L0')
  await store.submitResult(makeResult('q1', 1, 1, 10, 90))
  await store.submitResult(makeResult('q2', 5, 5, 50, 50))
  await store.completeTask('t1')

  const analyzer = new ParetoAnalyzer(DESIGN_SPACE.objectives)
  const evals = await store.getBestFidelityEvaluations(true)
  const front = analyzer.analyze(evals)

  // Build capsule at EVALUATING_L0
  const capsule = buildCapsule(store, front)

  assert(capsule.schemaVersion === '1.0', 'capsule schemaVersion = 1.0')
  assert(capsule.campaignId === store.campaignId, 'capsule.campaignId matches')
  assert(capsule.projectName === 'Capsule Test', 'capsule.projectName matches')
  assert(capsule.phase === 'EVALUATING_L0', 'capsule.phase matches store phase')
  assert(capsule.contextBlock.length > 0, 'contextBlock non-empty')
  assert(capsule.contextBlock.length < 3000, 'contextBlock < 3000 chars (token budget)')
  assert(capsule.contextBlock.includes('Capsule Test'), 'contextBlock includes project name')

  // Structured data
  const sd = capsule.structuredData
  assert(sd.totalPoints === 2, 'structuredData.totalPoints = 2')
  assert(sd.completedPoints === 1, 'structuredData.completedPoints = 1')
  assert(sd.paretoFrontSize >= 1, 'structuredData.paretoFrontSize >= 1')
  assert('cost' in sd.bestResults || 'perf' in sd.bestResults, 'bestResults has objective entries')

  // Transition to PARETO_READY_L0 and verify call-to-action
  await store.transitionPhase('PARETO_READY_L0')
  const capsule2 = buildCapsule(store, front)
  assert(capsule2.contextBlock.includes('Ready for your decision'), 'CTA present at PARETO_READY_L0')
  assert(capsule2.structuredData.pendingDecision !== null, 'pendingDecision set at checkpoint phase')

  // Clean up
  await store.transitionPhase('DONE')
}

// ── Test 5: CampaignMonitor (idempotency only — no real intervals) ────────────

async function testCampaignMonitor(): Promise<void> {
  section('CampaignMonitor')

  const fakeId = 'c_monitor_test'

  // Not watching initially
  assert(!CampaignMonitor.isWatching(fakeId), 'not watching before watchAsync()')

  // Note: We don't call watchAsync() with a real campaignId here because the
  // polling interval would try to load a non-existent campaign from disk.
  // We verify the registry logic via stopAll() and isWatching().

  // Directly test stopAll() on an empty registry — should not throw
  CampaignMonitor.stopAll()
  assert(!CampaignMonitor.isWatching(fakeId), 'isWatching() = false after stopAll()')

  // Stop on non-existent campaign — should not throw
  CampaignMonitor.stop(fakeId)
  assert(true, 'stop() on unknown campaignId does not throw')
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== meta-agent coordination smoke test ===')

  try {
    await testParetoAnalyzer()
    await testCampaignStateStore()
    await testMetaAgentContextStore()
    await testCapsuleBuilder()
    await testCampaignMonitor()
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
