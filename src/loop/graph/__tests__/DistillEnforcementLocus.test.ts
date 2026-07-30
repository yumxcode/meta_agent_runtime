import { describe, expect, it } from 'vitest'
import {
  CANONICAL_GRAPH_DISTILL_EXAMPLE,
  deriveEnforcementLocus,
  enforcementLocusIndex,
  formatEnforcementLoci,
  validateGraphTraceability,
  type LoopConstraintKind,
  type LoopConstraintLedger,
} from '../index.js'

function ledger(...kinds: Array<[string, LoopConstraintKind]>): LoopConstraintLedger {
  return {
    schemaVersion: 'loop-constraints-2.0',
    goal: 'g',
    constraints: kinds.map(([id, kind]) => ({
      id, kind, statement: `${id} statement`, strength: 'hard' as const,
      sources: [{ path: 'req.md', locator: 'L1' }],
    })),
  }
}

function traceability(mappings: Array<{ constraintId: string; graphRefs: string[] }>): never {
  return { schemaVersion: 'graph-traceability-2.0', mappings: mappings.map(m => ({ ...m, rationale: 'because' })) } as never
}

describe('constraint enforcement locus', () => {
  it('keeps governance in graph, domain procedure in worker, and completion in an independent reviewer', () => {
    for (const kind of ['deterministic_rule', 'workspace_protocol', 'ownership', 'terminal_obligation',
      'failure_boundary', 'budget', 'timer', 'event'] as LoopConstraintKind[]) {
      expect(deriveEnforcementLocus(kind)).toBe('graph')
    }
    expect(deriveEnforcementLocus('goal')).toBe('agent')
    expect(deriveEnforcementLocus('recovery')).toBe('agent')
    expect(deriveEnforcementLocus('other')).toBe('agent')
    expect(deriveEnforcementLocus('success_criteria')).toBe('reviewer')
    expect(deriveEnforcementLocus('capability')).toBe('human')
  })

  it('defaults unknown prose obligations to the thick agent instead of manufacturing control structure', () => {
    expect(deriveEnforcementLocus('not_a_kind' as LoopConstraintKind)).toBe('agent')
  })

  it('indexes and formats loci for the reviewer contract', () => {
    const l = ledger(['C1', 'deterministic_rule'], ['C2', 'goal'], ['C3', 'success_criteria'], ['C4', 'capability'])
    expect(enforcementLocusIndex(l)).toEqual(new Map([
      ['C1', 'graph'], ['C2', 'agent'], ['C3', 'reviewer'], ['C4', 'human'],
    ]))
    expect(formatEnforcementLoci(l)).toBe('C1=graph(deterministic_rule) · C2=agent(goal) · C3=reviewer(success_criteria) · C4=human(capability)')
  })

  it('rejects a graph-locus constraint traced only to node prose', () => {
    // A routing/permission/bound rule parked in a prompt is exactly the shape
    // that used to pass mechanical traceability and then get rejected
    // downstream with no way to fix it.
    const errors = validateGraphTraceability(
      traceability([{ constraintId: 'C1', graphRefs: ['/nodes/work/prompt'] }]),
      ledger(['C1', 'deterministic_rule']),
      CANONICAL_GRAPH_DISTILL_EXAMPLE,
    )
    expect(errors.join('\n')).toContain('only to node prose')
  })

  it('accepts an agent-locus constraint traced to node prose', () => {
    // Delegating intent to a briefed Agent is the intended design, so it must
    // not be reported as a defect.
    const errors = validateGraphTraceability(
      traceability([{ constraintId: 'C1', graphRefs: ['/nodes/work/prompt'] }]),
      ledger(['C1', 'goal']),
      CANONICAL_GRAPH_DISTILL_EXAMPLE,
    )
    expect(errors).toEqual([])
  })

  it('accepts a completion criterion traced to the independent reviewer prompt', () => {
    const errors = validateGraphTraceability(
      traceability([{ constraintId: 'C1', graphRefs: ['/nodes/review/prompt'] }]),
      ledger(['C1', 'success_criteria']),
      CANONICAL_GRAPH_DISTILL_EXAMPLE,
    )
    expect(errors).toEqual([])
  })

  it('still rejects annotations for either locus', () => {
    for (const kind of ['deterministic_rule', 'goal'] as LoopConstraintKind[]) {
      const errors = validateGraphTraceability(
        traceability([{ constraintId: 'C1', graphRefs: ['/annotations/notes'] }]),
        ledger(['C1', kind]),
        { ...CANONICAL_GRAPH_DISTILL_EXAMPLE, annotations: { notes: 'x' } } as never,
      )
      expect(errors.join('\n')).toContain('non-executable annotations')
    }
  })

  it('accepts a graph-locus constraint traced to a real executable element', () => {
    const errors = validateGraphTraceability(
      traceability([{ constraintId: 'C1', graphRefs: ['/transitions/1/updates/0'] }]),
      ledger(['C1', 'deterministic_rule']),
      CANONICAL_GRAPH_DISTILL_EXAMPLE,
    )
    expect(errors).toEqual([])
  })
})
