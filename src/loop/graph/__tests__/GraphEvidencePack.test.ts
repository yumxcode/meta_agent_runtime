import { describe, expect, it } from 'vitest'
import {
  buildLoopReliabilityProfile,
  createDefaultGraphRuntimeCatalog,
  createGraphEvidenceScenarios,
  freezeLoopGraph,
  runGraphSoak,
  type EffectProvider,
  type GraphSoakSnapshot,
} from '../index.js'

describe('graph Evidence Pack', () => {
  it('freezes all three domain-shaped scenarios without extending the Graph ABI', () => {
    const runtime = createDefaultGraphRuntimeCatalog()
    const training: EffectProvider = {
      manifest: { id: 'evidence/training-submit', version: '1', integrity: 'test:evidence-training-v1', pure: false },
      async submit(_input, key) { return { jobId: key } },
    }
    runtime.effects.register(training)
    const scenarios = createGraphEvidenceScenarios()
    expect(scenarios.map(item => item.id)).toEqual([
      'bounded-research', 'continuous-operations', 'long-training-supervision',
    ])
    const frozen = scenarios.map(item => freezeLoopGraph(item.graph, runtime, 1))
    expect(frozen.every(graph => graph.schemaVersion === 'graph-2.0')).toBe(true)
    expect(frozen[0]!.nodes.research?.type).toBe('agent')
    expect(frozen[1]!.limits.maxTotalActivations).toBeUndefined()
    expect(frozen[2]!.capabilityLock.effects.map(item => item.id)).toEqual(['evidence/training-submit'])
  })

  it('runs deterministic soak and one-shot restart/skip chaos without Kernel hooks', async () => {
    let snapshot: GraphSoakSnapshot = { status: 'active', activationCount: 1, liveActivations: 1, checkpointBytes: 100 }
    let restarts = 0
    const report = await runGraphSoak({
      async tick(_now, step) {
        snapshot = {
          status: step >= 5 ? 'done' : 'active',
          activationCount: snapshot.activationCount + 1,
          liveActivations: step % 2 ? 2 : 1,
          checkpointBytes: 100 + step,
        }
        return { step }
      },
      async snapshot() { return { ...snapshot } },
      async restart() { restarts++ },
    }, {
      steps: 20,
      chaos: [
        { id: 'kill-before-2', action: 'restart-before-tick', when: ctx => ctx.phase === 'before' && ctx.step === 2 },
        { id: 'lost-wake-3', action: 'skip-tick', when: ctx => ctx.phase === 'before' && ctx.step === 3 },
      ],
      invariants: [ctx => { if (ctx.snapshot.liveActivations > 2) throw new Error('live set escaped bound') }],
    })
    expect(report.finalSnapshot.status).toBe('done')
    expect(report.stepsCompleted).toBe(6)
    expect(report.ticksExecuted).toBe(5)
    expect(report.restarts).toBe(1)
    expect(restarts).toBe(1)
    expect(report.maxLiveActivations).toBe(2)
    expect(report.chaosApplied.map(item => item.ruleId)).toEqual(['kill-before-2', 'lost-wake-3'])
  })

  it('builds facts-only Reliability Profiles for the evidence scenarios', () => {
    const runtime = createDefaultGraphRuntimeCatalog()
    runtime.effects.register({
      manifest: { id: 'evidence/training-submit', version: '1', integrity: 'test:evidence-training-v1', pure: false },
      async submit() { return { jobId: 'job-1' } },
    })
    const [research, operations, training] = createGraphEvidenceScenarios()
      .map(item => freezeLoopGraph(item.graph, runtime, 1))
    expect(buildLoopReliabilityProfile(research!, { generatedAt: 1 }).graph.class).toBe('bounded')
    const operationsProfile = buildLoopReliabilityProfile(operations!, { generatedAt: 1 })
    expect(operationsProfile.graph.class).toBe('continuous')
    expect(operationsProfile.ingress.status).toBe('unknown')
    const trainingProfile = buildLoopReliabilityProfile(training!, {
      generatedAt: 1,
      effects: {
        'evidence/training-submit@1': { provider: 'evidence/training-submit@1', status: 'passed', suiteVersion: '1.0' },
      },
      ingress: { adapter: 'github-reference', status: 'verified', deliveryId: true },
    })
    expect(trainingProfile.effects.status).toBe('verified')
    expect(trainingProfile.ingress.status).toBe('verified')
  })
})
