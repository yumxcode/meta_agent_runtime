import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  createBuiltinFunctionRegistry,
  createBuiltinReducerRegistry,
  freezeLoopGraph,
  verifyFrozenGraphIntegrity,
  validateLoopGraph,
  type EffectProvider,
  type LoopGraphSpec,
} from '../index.js'

function registries() {
  const effects = new CapabilityRegistry<EffectProvider>('effect')
  effects.register({
    manifest: { id: 'test/effect', version: '1', integrity: 'test', pure: false },
    async submit() { return { receipt: 'ok' } },
  })
  return { functions: createBuiltinFunctionRegistry(), reducers: createBuiltinReducerRegistry(), effects }
}

function graph(): LoopGraphSpec {
  return {
    schemaVersion: 'graph-1.0', id: 'retry-loop', version: 1, goal: 'Retry deterministically',
    state: { retry_count: { type: { type: 'integer', minimum: 0 }, initial: 0 } },
    lanes: { work: { context: 'persistent', workspace: 'lane_overlay' } },
    nodes: {
      work: { type: 'agent', lane: 'work', prompt: 'Do the work.' },
      fast: { type: 'terminal', status: 'done' },
      slow: { type: 'terminal', status: 'failed' },
    },
    transitions: [
      { id: 'to-slow', from: 'work', when: '$state.retry_count >= 8', priority: 20, to: 'slow' },
      { id: 'to-fast', from: 'work', when: '$state.retry_count >= 2', priority: 10, to: 'fast' },
      { id: 'fallback', from: 'work', default: true, updates: [{ target: 'retry_count', reducer: 'builtin/increment@1' }], to: 'work' },
      { id: 'work-failed', from: 'work', on: 'failure', to: 'slow' },
    ],
    entrypoints: [{ id: 'start', node: 'work' }],
    limits: { maxActivations: 100 },
  }
}

describe('LoopGraphSpec', () => {
  it('validates deterministic $state routing and freezes capability versions', () => {
    const spec = graph()
    expect(validateLoopGraph(spec, registries())).toEqual([])
    const frozen = freezeLoopGraph(spec, registries(), 123)
    expect(frozen.capabilityLock.reducers[0]?.id).toBe('builtin/increment')
    expect(frozen.graphHash).toMatch(/^[a-f0-9]{64}$/)
    expect(freezeLoopGraph(spec, registries(), 456).graphHash).toBe(frozen.graphHash)
    expect(() => verifyFrozenGraphIntegrity(frozen)).not.toThrow()
    const tampered = structuredClone(frozen)
    tampered.goal = 'tampered after Freeze'
    expect(() => verifyFrozenGraphIntegrity(tampered)).toThrow(/integrity mismatch/)
  })

  it('rejects ambiguous conditional routing and missing total fallback', () => {
    const spec = graph()
    spec.transitions = spec.transitions.filter(transition => transition.id !== 'fallback')
    spec.transitions[1]!.priority = 20
    const errors = validateLoopGraph(spec, registries())
    expect(errors).toContain("node 'work' outcome 'success' needs exactly one default transition for total routing")
    expect(errors).toContain("node 'work' outcome 'success' has conditional transitions sharing priority 20")
  })

  it('rejects invalid initial state before freezing', () => {
    const spec = graph()
    spec.state.retry_count!.initial = -1
    expect(validateLoopGraph(spec, registries())).toContain('state.retry_count.initial must be >= 0')
  })

  it('requires bounded hard parks on a persistent Lane', () => {
    const spec = graph()
    const work = spec.nodes.work!
    if (work.type !== 'agent') throw new Error('test graph work node must be an Agent')
    work.timerPolicy = { allowHardPark: true, maxDelayMs: 60_000 }
    spec.lanes.work!.context = 'fresh_per_activation'
    const errors = validateLoopGraph(spec, registries())
    expect(errors).toContain('nodes.work.timerPolicy.allowHardPark requires a persistent Lane')
    expect(errors).toContain('nodes.work.timerPolicy.maxParks is required when hard park is enabled')
    expect(errors).toContain('nodes.work.budget.turns is required when hard park is enabled')
    expect(errors).toContain('nodes.work.lifetimeBudget.elapsedMs is required when hard park is enabled')
  })

  it('requires failure routing for nodes that can produce failure', () => {
    const spec = graph()
    spec.transitions = spec.transitions.filter(transition => transition.on !== 'failure')
    expect(validateLoopGraph(spec, registries())).toContain(
      "node 'work' must route outcome 'failure' or provide an 'always' transition",
    )
  })

  it('rejects silent executable-field typos while preserving open annotations', () => {
    const spec = graph() as LoopGraphSpec & { scenarioRole?: string }
    spec.scenarioRole = 'research'
    spec.annotations = { scenarioRole: 'research', arbitraryDomainShape: { score: 0.7 } }
    const errors = validateLoopGraph(spec, registries())
    expect(errors).toContain('graph.scenarioRole is not part of the executable Graph ABI; put non-executable domain metadata under annotations')
    delete spec.scenarioRole
    expect(validateLoopGraph(spec, registries())).toEqual([])
  })

  it('rejects closed reachable cycles but does not attempt to prove semantic exit conditions', () => {
    const spec = graph()
    spec.transitions = [
      spec.transitions.find(transition => transition.id === 'fallback')!,
      { id: 'failure-loop', from: 'work', on: 'failure', to: 'work' },
    ]
    const errors = validateLoopGraph(spec, registries())
    expect(errors.some(error => error.includes("node 'work' is in a closed path"))).toBe(true)

    const open = graph()
    expect(validateLoopGraph(open, registries()).some(error => error.includes('closed path'))).toBe(false)
  })

  it('validates concurrency bounds and schema-backed output paths conservatively', () => {
    const spec = graph()
    spec.concurrency = { maxActivations: 0, maxPerNode: -1, stateConsistency: 'serializable' }
    const work = spec.nodes.work!
    if (work.type !== 'agent') throw new Error('expected Agent')
    work.outputSchema = {
      type: 'object', additionalProperties: false,
      properties: { decision: { type: 'string' } }, required: ['decision'],
    }
    spec.transitions[0]!.when = '$output.typo == true'
    const errors = validateLoopGraph(spec, registries())
    expect(errors).toContain('concurrency.maxActivations must be a positive integer')
    expect(errors).toContain('concurrency.maxPerNode must be a positive integer')
    expect(errors.some(error => error.includes("'typo' is absent from the closed output/state schema"))).toBe(true)

    delete work.outputSchema
    expect(validateLoopGraph(spec, registries()).some(error => error.includes("'typo' is absent"))).toBe(false)
  })

  it('uses optional capability contracts when present without requiring every capability to be typed', () => {
    const caps = registries()
    caps.functions.register({
      manifest: {
        id: 'test/typed', version: '1', integrity: 'typed-v1', pure: true,
        inputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } }, additionalProperties: false },
        outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false },
      },
      execute: () => ({ ok: true }),
    })
    const spec = graph()
    spec.nodes.work = { type: 'function', function: 'test/typed@1', inputs: { count: { literal: 'not-an-integer' } } }
    spec.transitions[0]!.when = '$output.missing == true'
    const errors = validateLoopGraph(spec, caps)
    expect(errors).toContain('nodes.work.inputs.count must be an integer')
    expect(errors.some(error => error.includes("'missing' is absent from the closed output/state schema"))).toBe(true)
  })
})
