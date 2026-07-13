import { evaluateBool, type Ast, type EvalContext } from '../expr/Expr.js'
import type { FrozenCharter, MeterSpec } from '../charter/CharterTypes.js'
import type { ObservationResult } from '../types.js'
import {
  prepareReducerInput,
  type Reducer,
  type ReducerInput,
  type ReducerManifest,
} from './ReducerContract.js'

export interface ConditionalCounterState {
  meters: Record<string, number>
  diagnostics: string[]
}

export interface ConditionalCounterEvent {
  budgetExhausted: boolean
  meters: MeterSpec[]
  meterAsts: Record<string, { incWhen?: Ast; resetWhen?: Ast }>
}

/** Build the first in-process projection reducer from a frozen Charter. */
export function conditionalCounterManifest(charter: FrozenCharter): ReducerManifest {
  const inputs = Object.entries(charter.frozen.observableObligations)
    .filter(([, obligation]) => obligation.consumers.some(consumer => consumer.kind === 'meter'))
    .map(([observable]) => ({
      observable,
      // The reducer must preserve Expr short-circuit behavior, so it receives
      // all three states and handles absent/error when an expression is reached.
      accepts: ['present', 'absent', 'error'] as const,
    }))
  return {
    id: 'builtin/conditional-counter-set',
    version: '1',
    inputs: inputs.map(input => ({ ...input, accepts: [...input.accepts] })),
  }
}

class ConditionalCounterReducer implements Reducer<ConditionalCounterState, ConditionalCounterEvent> {
  readonly manifest: ReducerManifest

  constructor(private readonly charter: FrozenCharter) {
    this.manifest = conditionalCounterManifest(charter)
  }

  reduce(
    previous: Readonly<ConditionalCounterState>,
    input: Readonly<ReducerInput<ConditionalCounterEvent>>,
  ): ConditionalCounterState {
    const meters = { ...previous.meters }
    const diagnostics = [...previous.diagnostics]
    // Legacy meter semantics evaluate every expression against the same
    // pre-METER snapshot, even though earlier counters may already be updated.
    const ctx = buildCounterContext(previous.meters, input.observations, input.event.budgetExhausted)

    for (const meter of input.event.meters) {
      const asts = input.event.meterAsts[meter.name] ?? {}
      if (meter.inc === 'every_round') {
        meters[meter.name] = (meters[meter.name] ?? 0) + 1
        continue
      }
      if (!asts.incWhen) continue
      const increment = evaluateCondition(asts.incWhen, ctx, meter.name, 'incWhen', diagnostics)
      if (increment === 'error') continue
      if (increment) {
        meters[meter.name] = (meters[meter.name] ?? 0) + 1
        continue
      }
      if (asts.resetWhen) {
        const reset = evaluateCondition(asts.resetWhen, ctx, meter.name, 'resetWhen', diagnostics)
        if (reset === true) meters[meter.name] = 0
      }
    }
    return { meters, diagnostics }
  }
}

export function runConditionalCounterProjection(
  charter: FrozenCharter,
  previousMeters: Readonly<Record<string, number>>,
  observations: Readonly<Record<string, ObservationResult>>,
  budgetExhausted: boolean,
): ConditionalCounterState {
  const reducer = new ConditionalCounterReducer(charter)
  const event: ConditionalCounterEvent = {
    budgetExhausted,
    meters: charter.meters,
    meterAsts: charter.frozen.meterAsts,
  }
  const prepared = prepareReducerInput(reducer.manifest, event, observations)
  if (prepared.kind !== 'ready') {
    const detail = prepared.kind === 'skip'
      ? `${prepared.observable}:${prepared.status}`
      : `${prepared.code}:${prepared.message}`
    throw new Error(`conditional counter reducer was not ready: ${detail}`)
  }
  return reducer.reduce(
    { meters: { ...previousMeters }, diagnostics: [] },
    prepared.input,
  )
}

function buildCounterContext(
  meters: Readonly<Record<string, number>>,
  observations: Readonly<Record<string, ObservationResult>>,
  budgetExhausted: boolean,
): EvalContext {
  const values: Record<string, number | boolean | string> = {}
  for (const [name, result] of Object.entries(observations)) {
    if (result.status === 'present' && result.value !== null) values[name] = result.value
  }
  return { ...values, ...meters, 'budget.lifetime.exhausted': budgetExhausted }
}

function evaluateCondition(
  ast: Ast,
  ctx: EvalContext,
  meter: string,
  field: 'incWhen' | 'resetWhen',
  diagnostics: string[],
): boolean | 'error' {
  try {
    return evaluateBool(ast, ctx)
  } catch (err) {
    diagnostics.push(
      `meter '${meter}'.${field} evaluation error; retained previous value: ${(err as Error).message}`,
    )
    return 'error'
  }
}
