import { describe, expect, it } from 'vitest'
import { buildExecutionPlan, gateBinding, validateExecutionPlan } from '../ExecutionPlan.js'
import { walkResearchCharter } from '../../__tests__/testCharter.js'
import type { FrozenExecutionPlan } from '../CharterTypes.js'

describe('ExecutionPlan', () => {
  it('normalizes Research into fixed roles and ordered bounded gates', () => {
    const plan = buildExecutionPlan(walkResearchCharter())
    expect(plan.seats).toEqual({
      producer: 'worker', reviewers: ['judge'], pivoter: 'pivoter',
    })
    expect(plan.gates.map(gate => gate.id)).toEqual([
      'producer', 'wait_contract', 'direction_diversity', 'schema', 'judge',
    ])
    expect(gateBinding(plan, 'direction_diversity')?.handler).toBe('scenario')
    expect(gateBinding(plan, 'judge')).toMatchObject({
      retryProducer: 1, executionRetry: 1, feedback: 'messages',
    })
    expect(gateBinding(plan, 'schema')?.gateIds).toEqual(['state_gate'])
    expect(validateExecutionPlan(plan)).toEqual([])
  })

  it('does not create arbitrary reviewer roles or a DAG when optional seats are absent', () => {
    const charter = walkResearchCharter()
    delete charter.seats.judge
    delete charter.seats.pivoter
    delete charter.gates.findings_gate
    charter.observables = []
    charter.tripwires = [{ when: 'iteration >= 1', then: { act: 'finalize' } }]
    const plan = buildExecutionPlan(charter)
    expect(plan.seats).toEqual({ producer: 'worker', reviewers: [] })
    expect(plan.gates.some(gate => gate.id === 'judge')).toBe(false)
  })

  it('rejects duplicate gates and execution retries outside judge', () => {
    const plan = buildExecutionPlan(walkResearchCharter()) as FrozenExecutionPlan
    plan.gates.push({ ...plan.gates[0]!, executionRetry: 1 })
    const errs = validateExecutionPlan(plan)
    expect(errs.some(error => error.includes('duplicated'))).toBe(true)
    expect(errs.some(error => error.includes('only supported for judge'))).toBe(true)
  })
})
