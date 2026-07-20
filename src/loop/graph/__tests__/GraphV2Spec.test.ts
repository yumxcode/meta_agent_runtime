import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  createBuiltinFunctionRegistry,
  createBuiltinReducerRegistry,
  freezeLoopGraph,
  validateLoopGraph,
  verifyFrozenGraphIntegrity,
  type EffectProvider,
  type LoopGraphSpec,
} from '../index.js'

function catalog() {
  return {
    functions: createBuiltinFunctionRegistry(), reducers: createBuiltinReducerRegistry(),
    effects: new CapabilityRegistry<EffectProvider>('effect'),
    agentTools: new Set(['read_file', 'write_file', 'append_file', 'bash']),
  }
}

function graph(): LoopGraphSpec {
  return {
    schemaVersion: 'graph-2.0', id: 'bounded_loop', version: 1, goal: 'Work until complete.',
    state: { iteration: { type: { type: 'integer', minimum: 0 }, initial: 0 } },
    lanes: {
      work: {
        context: 'persistent', maxConcurrency: 1,
        workspace: {
          read: ['requirements.md', 'state'],
          write: [
            { path: 'state/progress.json', mode: 'atomic_replace' },
            { path: 'state/history.jsonl', mode: 'append_only' },
          ],
          deny: ['.git'],
        },
      },
    },
    nodes: {
      work: {
        type: 'agent', lane: 'work', prompt: 'Perform one complete iteration.',
        tools: ['read_file', 'write_file', 'append_file'],
        outputSchema: { type: 'object', required: ['done'], properties: { done: { type: 'boolean' } }, additionalProperties: false },
      },
      done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
    },
    transitions: [
      { id: 'complete', from: 'work', when: '$output.done == true', priority: 10, to: 'done' },
      { id: 'again', from: 'work', default: true, updates: [{ target: 'iteration', reducer: 'builtin/increment@1' }], to: 'work' },
      { id: 'failure', from: 'work', on: 'failure', to: 'failed' },
    ],
    entrypoints: [{ id: 'start', node: 'work' }], limits: { maxActivations: 20 },
  }
}

describe('durable-graph-v2 ABI', () => {
  it('validates and freezes the small control + Lane + Workspace contract', () => {
    const spec = graph()
    expect(validateLoopGraph(spec, catalog())).toEqual([])
    const frozen = freezeLoopGraph(spec, catalog(), 123)
    expect(frozen.graphHash).toMatch(/^[a-f0-9]{64}$/)
    expect(frozen.capabilityLock.reducers.map(item => item.id)).toEqual(['builtin/increment'])
    expect(frozen.capabilityLock.agentTools).toEqual(['append_file', 'read_file', 'write_file'])
    expect(() => verifyFrozenGraphIntegrity(frozen)).not.toThrow()
    const tampered = structuredClone(frozen)
    tampered.goal = 'changed'
    expect(() => verifyFrozenGraphIntegrity(tampered)).toThrow(/integrity mismatch/)
  })

  it('rejects removed architecture fields instead of silently accepting them', () => {
    const spec = graph() as LoopGraphSpec & Record<string, unknown>
    spec.legacyStorageLayer = {}
    expect(validateLoopGraph(spec, catalog()).join('\n')).toContain('is not part of the executable Graph ABI')
  })

  it('rejects overlapping writers across Lanes', () => {
    const spec = graph()
    spec.lanes.audit = { context: 'fresh_per_activation', workspace: { write: [{ path: 'state', mode: 'owned' }] } }
    expect(validateLoopGraph(spec, catalog()).join('\n')).toContain('one path needs one owning Lane')
  })

  it('checks declared Agent tools against the runtime catalog', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected Agent')
    work.tools = ['invented_platform_tool']
    expect(validateLoopGraph(spec, catalog())).toContain("nodes.work.tools[0] references unavailable Agent tool 'invented_platform_tool'")
  })

  it('requires complete bounds for a hard-park Agent', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected Agent')
    work.timerPolicy = { allowHardPark: true, maxDelayMs: 60_000 }
    const errors = validateLoopGraph(spec, catalog())
    expect(errors).toContain('nodes.work.timerPolicy.maxParks is required when hard park is enabled')
    expect(errors).toContain('nodes.work.lifetimeBudget.elapsedMs is required when hard park is enabled')
  })

  it('rejects a $input reference that some incoming path does not bind', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected Agent')
    // work is reached by the entrypoint AND the self-loop 'again'; neither binds pivot.
    work.inputs = { pivot: { ref: '$input.pivot' } }
    const errors = validateLoopGraph(spec, catalog())
    expect(errors.join('\n')).toContain("node 'work' reads $input.pivot but entrypoint 'start' does not bind it")
    expect(errors.join('\n')).toContain("node 'work' reads $input.pivot but transition 'again' does not bind it")
  })

  it('accepts an optional input bound { literal: null } on paths that lack it', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected Agent')
    work.inputs = { pivot: { ref: '$input.pivot' } }
    spec.entrypoints[0]!.inputs = { pivot: { literal: null } }
    const again = spec.transitions.find(transition => transition.id === 'again')!
    again.to = { node: 'work', inputs: { pivot: { literal: null } } }
    expect(validateLoopGraph(spec, catalog())).toEqual([])
  })

  it('ignores runtime-injected __ keys in the input-supply invariant', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected Agent')
    work.inputs = { resume: { ref: '$input.__resume' } }
    expect(validateLoopGraph(spec, catalog())).toEqual([])
  })

  it('requires terminal result inputs to be bound by every incoming transition', () => {
    const spec = graph()
    spec.nodes.done = { type: 'terminal', status: 'done', result: { ref: '$input.result' } }
    const errors = validateLoopGraph(spec, catalog())
    expect(errors.join('\n')).toContain("node 'done' reads $input.result but transition 'complete' does not bind it")
    const complete = spec.transitions.find(transition => transition.id === 'complete')!
    complete.to = { node: 'done', inputs: { result: { ref: '$output' } } }
    expect(validateLoopGraph(spec, catalog())).toEqual([])
  })

  it('restricts entrypoint inputs to $state and literals', () => {
    const spec = graph()
    spec.entrypoints[0]!.inputs = { seed: { ref: '$output.value' } }
    expect(validateLoopGraph(spec, catalog()).join('\n'))
      .toContain("entrypoints[0].inputs may only reference $state or literals; '$output' is unavailable at instance creation")
  })

  it('accepts exactly one git scm lane and rejects duplicates or invalid values', () => {
    const spec = graph()
    spec.lanes.work.scm = 'git'
    spec.lanes.work.workspace.deny = []
    expect(validateLoopGraph(spec, catalog())).toEqual([])
    expect(() => freezeLoopGraph(spec, catalog(), 1)).not.toThrow()

    const denied = graph()
    denied.lanes.work.scm = 'git'
    expect(validateLoopGraph(denied, catalog()).join('\n')).toContain("deny must not cover .git when scm 'git' is declared")

    const duplicated = graph()
    duplicated.lanes.work.scm = 'git'
    duplicated.lanes.work.workspace.deny = []
    duplicated.lanes.mirror = { context: 'fresh_per_activation', scm: 'git', workspace: { write: [{ path: 'mirror', mode: 'owned' }] } }
    expect(validateLoopGraph(duplicated, catalog()).join('\n')).toContain('the git index is single-writer')

    const invalid = graph()
    ;(invalid.lanes.work as Record<string, unknown>).scm = 'svn'
    expect(validateLoopGraph(invalid, catalog()).join('\n')).toContain("lanes.work.scm must be 'git'")
  })

  it('rejects scm on a read-only lane where git could never commit', () => {
    const spec = graph()
    spec.lanes.audit = { context: 'fresh_per_activation', scm: 'git', workspace: { read: ['state'], write: [] } }
    expect(validateLoopGraph(spec, catalog()).join('\n')).toContain('scm requires at least one workspace write rule')
  })
})
