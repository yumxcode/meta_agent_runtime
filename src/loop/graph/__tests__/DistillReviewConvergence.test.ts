import { describe, expect, it } from 'vitest'
import {
  hashPointerRegions,
  lintLoopGraph,
  parseLayeredSemanticReview,
  staleVerdicts,
  summarizeDistillTraceEvents,
  validateControlFlowWitness,
  validateIntakeLedgerPreservation,
  SEMANTIC_REVIEW_LAYERS,
  type ConstraintVerdict,
  type GraphTraceabilityMap,
  type LoopConstraintLedger,
  type LoopGraphSpec,
} from '../index.js'

const graph = (): LoopGraphSpec => ({
  schemaVersion: 'graph-2.0', id: 'ratchet', version: 1, goal: 'Converge.',
  state: { rounds: { type: 'number', initial: 0 } },
  lanes: { work: { context: 'persistent', workspace: { read: [], write: [{ path: 'out/', mode: 'owned' }] } } },
  nodes: {
    work: { type: 'agent', lane: 'work', prompt: 'Do the work.', budget: { wallTimeMs: 300_000 } },
    done: { type: 'terminal', status: 'done' },
  },
  transitions: [
    { id: 'finish', from: 'work', to: 'done' },
    { id: 'retry', from: 'work', on: 'failure', to: 'work' },
  ],
  entrypoints: [{ id: 'start', node: 'work' }],
  limits: { maxTotalActivations: 5 },
} as unknown as LoopGraphSpec)

const traceability = (refs: string[] = ['/nodes/work']): GraphTraceabilityMap => ({
  schemaVersion: 'graph-traceability-2.0',
  mappings: [{ constraintId: 'C1', graphRefs: refs, rationale: 'Implemented by the worker.' }],
})

const verdict = (evidenceHash: string): ConstraintVerdict => ({
  constraintId: 'C1', verdict: 'pass', evidenceHash, decidedAtCompilerAttempt: 1,
})

describe('verdict ratchet', () => {
  it('carries a verdict whose evidence region is unchanged', () => {
    const spec = graph()
    const ledger = [verdict(hashPointerRegions(spec, ['/nodes/work']))]
    expect(staleVerdicts(ledger, traceability(), spec).size).toBe(0)
  })

  it('re-opens a verdict when the constraint\'s own pointer changes', () => {
    const before = graph()
    const ledger = [verdict(hashPointerRegions(before, ['/nodes/work']))]
    const after = graph()
    ;(after.nodes.work as { prompt: string }).prompt = 'Do the work differently.'
    expect([...staleVerdicts(ledger, traceability(), after)]).toEqual(['C1'])
  })

  it('re-opens every verdict when a distant global region changes', () => {
    // The whole reason the fingerprint reaches past the constraint's own
    // pointers: without a final full re-review, an edit to /limits or a Lane
    // contract is exactly the kind of change that would otherwise invalidate a
    // carried conclusion silently.
    const before = graph()
    const ledger = [verdict(hashPointerRegions(before, ['/nodes/work']))]

    const limitsChanged = graph()
    limitsChanged.limits = { maxTotalActivations: 500 } as LoopGraphSpec['limits']
    expect([...staleVerdicts(ledger, traceability(), limitsChanged)]).toEqual(['C1'])

    const laneChanged = graph()
    ;(laneChanged.lanes.work as { workspace: { write: unknown[] } }).workspace.write = [{ path: 'elsewhere/', mode: 'owned' }]
    expect([...staleVerdicts(ledger, traceability(), laneChanged)]).toEqual(['C1'])
  })

  it('re-opens a verdict whose traceability mapping disappeared', () => {
    const spec = graph()
    const ledger = [verdict(hashPointerRegions(spec, ['/nodes/work']))]
    const orphaned: GraphTraceabilityMap = { schemaVersion: 'graph-traceability-2.0', mappings: [] }
    expect([...staleVerdicts(ledger, orphaned, spec)]).toEqual(['C1'])
  })

  it('ignores object key order when fingerprinting', () => {
    const a = graph()
    const b = graph()
    b.nodes = { done: b.nodes.done!, work: b.nodes.work! }
    expect(hashPointerRegions(a, ['/nodes/work'])).toBe(hashPointerRegions(b, ['/nodes/work']))
  })
})

const passingLayers = (): Record<string, unknown> => Object.fromEntries(SEMANTIC_REVIEW_LAYERS.map(layer => [layer, {
  status: 'pass', findings: [],
  evidence: [{ sourceRefs: ['requirements.md:L1'], designRefs: ['intent'], graphRefs: ['/goal'], statement: 'Aligned.' }],
}]))

const envelope = (verdicts: unknown[]): Record<string, unknown> => ({
  schemaVersion: 'loop-semantic-review-2.2', accepted: true, layers: passingLayers(), verdicts, issues: [],
})

describe('enumerated constraint verdicts', () => {
  it('voids the verdict when a required constraint has no row', () => {
    // "It did not mention C2" must stop being indistinguishable from "C2 is
    // fine" — that ambiguity is what let the reviewer report a different
    // sample of problems every round.
    expect(parseLayeredSemanticReview(
      envelope([{ constraintId: 'C1', verdict: 'satisfied', graphRefs: ['/goal'] }]),
      undefined,
      { requiredConstraintIds: ['C1', 'C2'] },
    )).toBeNull()
  })

  it('voids the verdict when the table is missing entirely', () => {
    const bare = { schemaVersion: 'loop-semantic-review-2.2', accepted: true, layers: passingLayers(), issues: [] }
    expect(parseLayeredSemanticReview(bare, undefined, { requiredConstraintIds: ['C1'] })).toBeNull()
  })

  it('accepts a complete table and keeps the rows', () => {
    const parsed = parseLayeredSemanticReview(
      envelope([{ constraintId: 'C1', verdict: 'satisfied', graphRefs: ['/goal'] }]),
      undefined,
      { requiredConstraintIds: ['C1'] },
    )
    expect(parsed?.verdicts).toEqual([{ constraintId: 'C1', verdict: 'satisfied', graphRefs: ['/goal'] }])
  })

  it('voids an out_of_scope row with no justification', () => {
    expect(parseLayeredSemanticReview(
      envelope([{ constraintId: 'C1', verdict: 'out_of_scope', graphRefs: [] }]),
      undefined,
      { requiredConstraintIds: ['C1'] },
    )).toBeNull()
    expect(parseLayeredSemanticReview(
      envelope([{ constraintId: 'C1', verdict: 'out_of_scope', graphRefs: [], justification: 'Enforced inside the Agent.' }]),
      undefined,
      { requiredConstraintIds: ['C1'] },
    )?.verdicts[0]?.verdict).toBe('out_of_scope')
  })

  it('refuses a `satisfied` row whose pointer does not resolve', () => {
    // The pointer obligation is the one cost a batch "everything is fine"
    // answer cannot pay.
    expect(parseLayeredSemanticReview(
      envelope([{ constraintId: 'C1', verdict: 'satisfied', graphRefs: ['/nodes/imaginary'] }]),
      undefined,
      { graph: graph(), requiredConstraintIds: ['C1'] },
    )).toBeNull()
    expect(parseLayeredSemanticReview(
      envelope([{ constraintId: 'C1', verdict: 'satisfied', graphRefs: [] }]),
      undefined,
      { requiredConstraintIds: ['C1'] },
    )).toBeNull()
  })
})

const withFinding = (ruleClass: string, witness?: unknown): Record<string, unknown> => {
  const layers = passingLayers()
  layers.control_flow = {
    status: 'fail',
    findings: [{
      ruleClass, statement: 'The bound is not implemented.',
      sourceRefs: ['requirements.md:L1'], designRefs: ['control'], graphRefs: ['/limits'],
      ...(witness ? { witness } : {}),
    }],
    evidence: [{ sourceRefs: ['requirements.md:L1'], designRefs: ['control'], graphRefs: ['/limits'], statement: 'Checked.' }],
  }
  return { schemaVersion: 'loop-semantic-review-2.2', accepted: false, layers, verdicts: [], issues: [] }
}

describe('control-flow witness obligation', () => {
  it('accepts a structurally valid witness and keeps the finding blocking', () => {
    const parsed = parseLayeredSemanticReview(
      withFinding('missing-source-bound', { state: { rounds: 5 }, path: ['retry', 'finish'], outcome: 'bound_exceeded' }),
      undefined,
      { graph: graph() },
    )
    expect(parsed?.accepted).toBe(false)
    expect(parsed?.issues[0]).toContain('missing-source-bound')
  })

  it('demotes a blocking control-flow claim that carries no witness', () => {
    const parsed = parseLayeredSemanticReview(withFinding('missing-source-bound'), undefined, { graph: graph() })
    expect(parsed?.accepted).toBe(true)
    expect(parsed?.issues).toEqual([])
    expect(parsed?.advisories[0]).toContain('unwitnessed-control-flow')
    expect(parsed?.advisories[0]).toContain('missing-source-bound')
    // The layer no longer describes a blocking defect, so reporting `fail`
    // would contradict the graph the host is about to accept.
    expect(parsed?.layers.control_flow.status).toBe('pass')
  })

  it('demotes a witness that cites a state field or transition that does not exist', () => {
    const unknownField = parseLayeredSemanticReview(
      withFinding('state-routing-divergence', { state: { nonexistent: 1 }, path: ['finish'], outcome: 'stale_state_read' }),
      undefined, { graph: graph() },
    )
    expect(unknownField?.accepted).toBe(true)
    expect(unknownField?.advisories[0]).toContain('unknown State field')

    const unknownTransition = parseLayeredSemanticReview(
      withFinding('unbounded-or-unreachable-control', { state: {}, path: ['no-such-edge'], outcome: 'terminal_unreachable' }),
      undefined, { graph: graph() },
    )
    expect(unknownTransition?.accepted).toBe(true)
    expect(unknownTransition?.advisories[0]).toContain('unknown Transition')
  })

  it('rejects a disconnected witness path', () => {
    const spec = graph()
    const errors = validateControlFlowWitness(
      { state: {}, path: ['finish', 'retry'], outcome: 'terminal_unreachable' }, spec)
    expect(errors.join('\n')).toContain('which the previous Transition does not reach')
  })

  it('leaves non-control-flow blocking classes untouched', () => {
    const parsed = parseLayeredSemanticReview(withFinding('writer-boundary-bypass'), undefined, { graph: graph() })
    expect(parsed?.accepted).toBe(false)
  })
})

describe('terminal reachability lint', () => {
  const findingsFor = (spec: LoopGraphSpec): string[] =>
    lintLoopGraph(spec).filter(item => item.rule === 'terminal-unreachable').map(item => item.at)

  it('stays silent when every terminal is reachable', () => {
    expect(findingsFor(graph())).toEqual([])
  })

  it('reports a terminal no transition sequence can reach', () => {
    const spec = graph()
    spec.nodes.orphan = { type: 'terminal', status: 'failed' } as unknown as LoopGraphSpec['nodes'][string]
    expect(findingsFor(spec)).toEqual(['nodes.orphan'])
  })

  it('ignores `when` conditions, so a conditionally-routed terminal is never flagged', () => {
    // The closure is an upper bound on purpose: a terminal outside it is
    // unreachable under every condition assignment, which is what lets the
    // reviewer stop checking reachability at all.
    const spec = graph()
    spec.transitions = [
      { id: 'maybe', from: 'work', when: "$state.rounds >= 99", to: 'done' },
    ] as unknown as LoopGraphSpec['transitions']
    expect(findingsFor(spec)).toEqual([])
  })

  it('says nothing when the graph has no entrypoints at all', () => {
    const spec = graph()
    spec.entrypoints = []
    expect(findingsFor(spec)).toEqual([])
  })
})

describe('intake ledger immutability', () => {
  const confirmed: LoopConstraintLedger = {
    schemaVersion: 'loop-constraints-2.0', goal: 'Converge.',
    constraints: [
      { id: 'C1', kind: 'budget', statement: 'At most 20 effective rounds.', strength: 'hard', origin: 'intake', sources: [{ path: 'loop.md', locator: 'L12' }] },
      { id: 'C2', kind: 'goal', statement: 'Find the best hypothesis.', strength: 'soft', origin: 'intake', sources: [{ path: 'loop.md', locator: 'L20' }] },
    ],
  }
  const intake = { constraints: confirmed, approvedConstraintIds: ['C1'] }

  it('permits appended architect constraints', () => {
    const candidate: LoopConstraintLedger = {
      ...confirmed,
      constraints: [
        ...confirmed.constraints,
        { id: 'C3', kind: 'workspace_protocol', statement: 'out/ must exist.', strength: 'hard', origin: 'architect', sources: [{ path: 'project', locator: 'scan' }] },
      ],
    }
    expect(validateIntakeLedgerPreservation(candidate, intake)).toEqual([])
  })

  it('rejects a reclassified or removed confirmed constraint', () => {
    const reclassified: LoopConstraintLedger = {
      ...confirmed,
      constraints: [{ ...confirmed.constraints[0]!, kind: 'other' }, confirmed.constraints[1]!],
    }
    expect(validateIntakeLedgerPreservation(reclassified, intake).join('\n')).toContain("'C1'.kind")

    const removed: LoopConstraintLedger = { ...confirmed, constraints: [confirmed.constraints[1]!] }
    expect(validateIntakeLedgerPreservation(removed, intake).join('\n')).toContain('must not be removed')
  })

  it('leaves unconfirmed intake entries editable', () => {
    const edited: LoopConstraintLedger = {
      ...confirmed,
      constraints: [confirmed.constraints[0]!, { ...confirmed.constraints[1]!, strength: 'hard' }],
    }
    expect(validateIntakeLedgerPreservation(edited, intake)).toEqual([])
  })
})

describe('convergence trace statistics', () => {
  it('counts the compound blind spot separately from ordinary carries', () => {
    // Two decisions traded strictness for throughput on the condition that this
    // number stays visible; a carried out-of-scope verdict is a constraint that
    // was never actually verified and never will be.
    const stats = summarizeDistillTraceEvents([
      { phase: 'semantic_review', outcome: 'verdict_carried', constraintId: 'C1' },
      { phase: 'semantic_review', outcome: 'verdict_carried', constraintId: 'C2', outOfScope: true },
      { phase: 'semantic_review', outcome: 'out_of_scope_escape', constraintId: 'C2' },
      { phase: 'semantic_review', outcome: 'rejected', issues: ['[unwitnessed-control-flow] demoted'] },
      { phase: 'semantic_review', outcome: 'accepted' },
      { phase: 'compiler', outcome: 'frozen' },
    ])
    expect(stats.carried).toBe(2)
    expect(stats.oosCarried).toBe(1)
    expect(stats.outOfScopeEscapes).toBe(1)
    expect(stats.unwitnessedDemotions).toBe(1)
    expect(stats.reviewRounds).toBe(2)
  })
})
