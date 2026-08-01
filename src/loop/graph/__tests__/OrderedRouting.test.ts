import { describe, expect, it } from 'vitest'
import {
  createDefaultGraphRuntimeCatalog,
  buildGraphDistillerSystem,
  freezeLoopGraph,
  graphReference,
  lintLoopGraph,
  validateLoopGraph,
  type LoopGraphSpec,
} from '../index.js'
import { decideTransition } from '../runtime/TransitionEngine.js'
import { applyGraphPatchForTest } from '../distill/GraphDistillTools.js'

/**
 * A measured graph produced from a real requirement had 18 conditional edges
 * carrying 76 pairwise mutual-exclusion obligations, of which 66 (87%) were
 * between conditions that can never both hold. They existed only because the
 * validator required a unique `priority` per conditional edge and the runtime
 * broke ties alphabetically — so every branch had to be ranked against every
 * other, including branches in different, mutually exclusive phases.
 */
const orderedGraph = (): LoopGraphSpec => ({
  schemaVersion: 'graph-2.0', id: 'ordered', version: 1, goal: 'Route by declaration order.',
  state: { count: { type: { type: 'integer', minimum: 0 }, initial: 0 } },
  lanes: { work: { context: 'persistent', workspace: { read: [], write: [{ path: 'out/notes.md', mode: 'append_only' }] } } },
  nodes: {
    work: {
      type: 'agent', lane: 'work', prompt: 'Do the work.', budget: { wallTimeMs: 300_000 },
      outputSchema: { type: 'object', required: ['trend'], properties: { trend: { type: 'string' } }, additionalProperties: false },
    },
    done: { type: 'terminal', status: 'done' },
    failed: { type: 'terminal', status: 'failed' },
  },
  // No priorities anywhere: the list IS the order. Stop first, then the broader
  // continue case — the exact shape the old validator made impossible.
  transitions: [
    { id: 'stop_at_bound', from: 'work', on: 'success', when: '$state.count >= 3', to: 'done' },
    { id: 'keep_going', from: 'work', on: 'success', when: "$output.trend == 'up'", to: 'work', updates: [{ target: 'count', reducer: 'builtin/increment@1' }] },
    { id: 'otherwise', from: 'work', on: 'success', default: true, to: 'done' },
    { id: 'boom', from: 'work', on: 'failure', to: 'failed' },
  ],
  entrypoints: [{ id: 'start', node: 'work' }],
  limits: { maxTotalActivations: 20, maxLiveActivations: 1 },
} as unknown as LoopGraphSpec)

const decide = async (spec: LoopGraphSpec, state: Record<string, unknown>, output: Record<string, unknown>) => {
  const catalog = createDefaultGraphRuntimeCatalog()
  const frozen = freezeLoopGraph(spec, catalog, 0)
  const decision = await decideTransition({
    graph: frozen,
    activation: { nodeId: 'work', input: {} } as never,
    outcome: 'success',
    output: output as never,
    state: { version: 1, values: state as never, updatedAt: 0 } as never,
    functions: catalog.functions,
    reducers: catalog.reducers,
    now: 0,
  })
  return decision.transition.id
}

describe('ordered first-match routing', () => {
  it('accepts conditional edges that share a priority', () => {
    // The old rule ("duplicate priority N") is what forced 155/160/165/... to be
    // invented; with declaration order authoritative a tie is well-defined.
    const spec = orderedGraph()
    expect(validateLoopGraph(spec, createDefaultGraphRuntimeCatalog())).toEqual([])

    const explicitTies = orderedGraph()
    explicitTies.transitions[0]!.priority = 50
    explicitTies.transitions[1]!.priority = 50
    expect(validateLoopGraph(explicitTies, createDefaultGraphRuntimeCatalog())).toEqual([])
  })

  it('takes the first matching edge in array order', async () => {
    const spec = orderedGraph()
    // Both branches hold. Earlier wins — the bound stops the loop.
    expect(await decide(spec, { count: 3 }, { trend: 'up' })).toBe('stop_at_bound')
    expect(await decide(spec, { count: 1 }, { trend: 'up' })).toBe('keep_going')
    expect(await decide(spec, { count: 1 }, { trend: 'flat' })).toBe('otherwise')
  })

  it('lets an explicit priority override array order', async () => {
    const spec = orderedGraph()
    spec.transitions[1]!.priority = 10
    expect(await decide(spec, { count: 3 }, { trend: 'up' })).toBe('keep_going')
  })

  it('does not need mutually exclusive branches, so no restated negations', () => {
    // `keep_going` says nothing about `count`; under the old flat-set model it
    // would have had to carry `&& $state.count < 3` to avoid being flagged.
    const spec = orderedGraph()
    expect(spec.transitions[1]!.when).not.toContain('count')
    const blocking = lintLoopGraph(spec).filter(finding => finding.level === 'error')
    expect(blocking).toEqual([])
  })

  it('still reports a branch that can never fire', () => {
    // Ordering removes the obligation to be exclusive; it does not license dead
    // edges. A later branch subsumed by an earlier one is still unreachable.
    const spec = orderedGraph()
    spec.transitions.splice(1, 0, { id: 'broad', from: 'work', on: 'success', when: '$state.count >= 1', to: 'done' })
    spec.transitions.splice(2, 0, { id: 'narrow', from: 'work', on: 'success', when: "$state.count >= 1 && $output.trend == 'up'", to: 'done' })
    const shadowed = lintLoopGraph(spec).filter(finding => finding.rule === 'shadowed-route')
    expect(shadowed).toHaveLength(1)
    expect(shadowed[0]!.at).toBe("transitions 'narrow'.when")
    expect(shadowed[0]!.message).toContain('declaration order')
  })

  it('no longer reports partitions that fall through to the default', () => {
    // Falling through to the default is how an ordered list is defined, so the
    // old truth-table gap rule was reporting the construct working correctly.
    const spec = orderedGraph()
    expect(lintLoopGraph(spec).map(finding => finding.rule)).not.toContain('route-partition-gap')
  })
})

describe('routing guidance given to the Compiler', () => {
  const control = graphReference('control', createDefaultGraphRuntimeCatalog())
  const compiler = buildGraphDistillerSystem(createDefaultGraphRuntimeCatalog())

  it('teaches first-match order and tells the model not to invent priorities', () => {
    expect(control).toContain('ORDERED first-match list')
    expect(control).toContain('OMIT `priority`')
    expect(compiler).toContain('不要写 priority')
  })

  it('teaches that branches need not be mutually exclusive', () => {
    expect(control).toContain('do NOT have to be mutually exclusive')
    expect(compiler).toContain('分支之间不需要互斥')
  })

  it('forbids encoding a mutually exclusive phase as a `when` conjunct', () => {
    expect(control).toContain('mutually-exclusive phase')
    expect(compiler).toContain('绝不用 when 里的条件来表达')
  })

  it('keeps the example templates free of invented priorities', () => {
    expect(control).not.toContain('"priority": 100')
    expect(control).not.toContain('"priority": 90')
  })
})

describe('reordering repairs are expressible as a patch', () => {
  const ids = (spec: LoopGraphSpec): string[] => spec.transitions.map(t => t.id)
  const patch = (spec: LoopGraphSpec, operations: unknown[]): LoopGraphSpec => {
    const clone = structuredClone(spec) as unknown as Record<string, unknown>
    for (const operation of operations) applyGraphPatchForTest(clone, operation)
    return clone as unknown as LoopGraphSpec
  }

  it('moves a branch before another one', () => {
    // This is the repair `shadowed-route` and `terminal-route-shadowed` now ask
    // for. With only set/remove it was inexpressible — `set` on an index
    // replaces, and appending puts the edge last, the opposite of what is needed.
    const spec = orderedGraph()
    const moved = patch(spec, [{ op: 'move', path: '/transitions/@id=otherwise', before: '/transitions/@id=stop_at_bound' }])
    expect(ids(moved)).toEqual(['otherwise', 'stop_at_bound', 'keep_going', 'boom'])
  })

  it('moves a branch to the end when `before` is omitted', () => {
    const moved = patch(orderedGraph(), [{ op: 'move', path: '/transitions/@id=stop_at_bound' }])
    expect(ids(moved)).toEqual(['keep_going', 'otherwise', 'boom', 'stop_at_bound'])
  })

  it('moving a later element before an earlier one keeps every other edge in place', () => {
    const moved = patch(orderedGraph(), [{ op: 'move', path: '/transitions/@id=boom', before: '/transitions/@id=keep_going' }])
    expect(ids(moved)).toEqual(['stop_at_bound', 'boom', 'keep_going', 'otherwise'])
  })

  it('inserts a new branch before an existing one instead of appending', () => {
    const inserted = patch(orderedGraph(), [{
      op: 'insert', path: '/transitions/@id=keep_going',
      value: { id: 'early_stop', from: 'work', on: 'success', when: '$state.count >= 10', to: 'done' },
    }])
    expect(ids(inserted)).toEqual(['stop_at_bound', 'early_stop', 'keep_going', 'otherwise', 'boom'])
  })

  it('refuses a move whose `before` addresses a different array', () => {
    expect(() => patch(orderedGraph(), [{ op: 'move', path: '/transitions/@id=boom', before: '/entrypoints/0' }]))
      .toThrow(/same array/)
  })

  it('rejects an unknown op', () => {
    expect(() => patch(orderedGraph(), [{ op: 'swap', path: '/transitions/0' }])).toThrow(/op must be one of/)
  })
})
