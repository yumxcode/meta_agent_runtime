import type {
  Charter,
  FrozenExecutionPlan,
  FrozenGateBinding,
} from './CharterTypes.js'
import { DEFAULT_SCENARIO_ID, scenarioDefinition } from '../scenarios/ScenarioDefinitions.js'
import type { ScenarioDefinition } from '../scenarios/ScenarioPlugin.js'

/** Normalize the current Research Charter into the future fixed-role model. */
export function buildExecutionPlan(
  charter: Charter,
  definitionOverride?: ScenarioDefinition,
): FrozenExecutionPlan {
  const schemaGateIds = Object.entries(charter.gates ?? {})
    .filter(([, gate]) => gate.kind === 'schema')
    .map(([id]) => id)
  const judgeGateIds = Object.entries(charter.gates ?? {})
    .filter(([, gate]) => gate.kind === 'judge')
    .map(([id]) => id)
  const scenario = definitionOverride ?? scenarioDefinition(charter.scenario ?? DEFAULT_SCENARIO_ID)
  const gates: FrozenGateBinding[] = charter.gateBindings
    ? charter.gateBindings.map(binding => ({
        ...((binding && typeof binding === 'object') ? binding : {} as FrozenGateBinding),
        gateIds: Array.isArray(binding?.gateIds) ? [...binding.gateIds] : [],
      } as FrozenGateBinding))
    : [
    {
      id: 'producer', kind: 'contract', handler: 'kernel', gateIds: [],
      retryProducer: 0, executionRetry: 0, feedback: 'generic',
    },
    {
      id: 'wait_contract', kind: 'contract', handler: 'kernel', gateIds: [],
      retryProducer: 1, executionRetry: 0, feedback: 'generic',
    },
    ...(scenario?.gateBindings.map(binding => ({ ...binding, gateIds: [...binding.gateIds] })) ?? []),
  ]
  if (!charter.gateBindings && schemaGateIds.length > 0) {
    gates.push({
      id: 'schema', kind: 'shape', handler: 'kernel', gateIds: schemaGateIds,
      retryProducer: 1, executionRetry: 0, feedback: 'generic',
    })
  }
  if (!charter.gateBindings && (judgeGateIds.length > 0 || charter.seats.judge)) {
    gates.push({
      id: 'judge', kind: 'judge', handler: 'kernel', gateIds: judgeGateIds,
      retryProducer: 1, executionRetry: 1, feedback: 'messages',
    })
  }
  return {
    seats: {
      producer: 'worker',
      reviewers: charter.seats.judge ? ['judge'] : [],
      ...(charter.seats.pivoter ? { pivoter: 'pivoter' as const } : {}),
      ...(charter.seats.finalizer ? { finalizer: 'finalizer' as const } : {}),
    },
    gates,
  }
}

export function validateExecutionPlan(plan: FrozenExecutionPlan): string[] {
  const errs: string[] = []
  if (plan.seats.producer !== 'worker') errs.push("executionPlan.seats.producer must be 'worker'")
  if (plan.seats.reviewers.length > 3) errs.push('executionPlan allows at most three reviewers')
  if (plan.seats.reviewers.some(reviewer => reviewer !== 'judge')) {
    errs.push("legacy executionPlan reviewer must be 'judge'")
  }
  const ids = new Set<string>()
  for (const [index, gate] of plan.gates.entries()) {
    if (!gate || typeof gate !== 'object') {
      errs.push(`executionPlan.gates[${index}] must be an object`)
      continue
    }
    if (ids.has(gate.id)) errs.push(`executionPlan.gates[${index}].id '${gate.id}' is duplicated`)
    ids.add(gate.id)
    if (gate.retryProducer !== 0 && gate.retryProducer !== 1) {
      errs.push(`executionPlan.gates[${index}].retryProducer must be 0 | 1`)
    }
    if (gate.executionRetry !== 0 && gate.executionRetry !== 1) {
      errs.push(`executionPlan.gates[${index}].executionRetry must be 0 | 1`)
    }
    if (gate.id !== 'judge' && gate.executionRetry !== 0) {
      errs.push(`executionPlan.gates[${index}] executionRetry is only supported for judge`)
    }
    if (gate.handler !== 'kernel' && gate.handler !== 'scenario') {
      errs.push(`executionPlan.gates[${index}].handler must be 'kernel' | 'scenario'`)
    }
  }
  return errs
}

export function gateBinding(
  plan: FrozenExecutionPlan,
  id: string,
): FrozenGateBinding | undefined {
  return plan.gates.find(gate => gate.id === id)
}
