import type { CapabilityRegistry, FunctionProvider, ReducerProvider } from '../registry/CapabilityRegistry.js'
import type {
  ActivationRecord,
  FrozenLoopGraphSpec,
  GraphStateSnapshot,
  JsonValue,
  TransitionSpec,
} from '../spec/GraphTypes.js'
import { transitionTargets } from '../spec/GraphValidate.js'
import { compileCondition, evaluateBindings, evaluateCondition, evaluateValueExpression } from './GraphExpression.js'
import { validateShape } from './GraphJson.js'
import { newActivation } from './GraphStore.js'

export interface TransitionDecision {
  transition: TransitionSpec
  state: GraphStateSnapshot
  spawned: ActivationRecord[]
}

export async function decideTransition(input: {
  graph: FrozenLoopGraphSpec
  activation: ActivationRecord
  outcome: string
  output: JsonValue
  state: GraphStateSnapshot
  functions: CapabilityRegistry<FunctionProvider>
  reducers: CapabilityRegistry<ReducerProvider>
  now: number
}): Promise<TransitionDecision> {
  const exact = input.graph.transitions.filter(transition => transition.from === input.activation.nodeId && (transition.on ?? 'success') === input.outcome)
  const candidates = exact.length
    ? exact
    : input.graph.transitions.filter(transition => transition.from === input.activation.nodeId && transition.on === 'always')
  if (candidates.length === 0) throw new Error(`no transition for node '${input.activation.nodeId}' outcome '${input.outcome}'`)
  const context = {
    state: input.state.values,
    input: input.activation.input,
    output: input.output,
    clock: { now: input.now },
  }
  const conditional = candidates
    .filter(transition => transition.when)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))
  let selected: TransitionSpec | undefined
  for (const transition of conditional) {
    if (evaluateCondition(compileCondition(transition.when!), context)) { selected = transition; break }
  }
  selected ??= candidates.find(transition => transition.default || !transition.when)
  if (!selected) throw new Error(`routing for node '${input.activation.nodeId}' outcome '${input.outcome}' is not total`)

  const values = { ...input.state.values }
  for (const update of selected.updates ?? []) {
    const args: JsonValue[] = []
    for (const expression of update.args ?? []) args.push(await evaluateValueExpression(expression, { ...context, state: values }, input.functions))
    const previous = values[update.target]!
    const next = input.reducers.get(update.reducer).reduce(previous, args)
    const errors = validateShape(next, input.graph.state[update.target]!.type, `$state.${update.target}`)
    if (errors.length) throw new Error(`reducer '${update.reducer}' produced invalid state: ${errors.join('; ')}`)
    values[update.target] = next
  }
  const state: GraphStateSnapshot = {
    ...input.state,
    version: input.state.version + 1,
    values,
    updatedAt: input.now,
  }
  const targets = transitionTargets(selected)
  const maxFanOut = input.graph.limits.maxFanOut ?? Number.POSITIVE_INFINITY
  if (targets.length > maxFanOut) throw new Error(`transition '${selected.id}' fan-out ${targets.length} exceeds limit ${maxFanOut}`)
  const spawned: ActivationRecord[] = []
  const sourceNode = input.graph.nodes[input.activation.nodeId]
  // forkGroupId is a stack of fork epochs ("outer|inner"): a fan-out pushes a
  // new epoch, a Join pops one. This keeps nested fork/join groups matched --
  // a flat id would strand outer-Join members in different groups (deadlock).
  const enclosingForkGroup = sourceNode?.type === 'join'
    ? popForkGroup(input.activation.forkGroupId)
    : input.activation.forkGroupId
  const forkGroupId = targets.length > 1
    ? appendForkGroup(enclosingForkGroup, `${input.activation.id}:${selected.id}`)
    : enclosingForkGroup
  for (const target of targets) {
    const values = await evaluateBindings(target.inputs, { ...context, state: state.values }, input.functions)
    spawned.push(newActivation({
      nodeId: target.node,
      values,
      stateVersion: state.version,
      now: input.now,
      parentActivationId: input.activation.id,
      sourceTransitionId: selected.id,
      forkGroupId,
    }))
  }
  return { transition: selected, state, spawned }
}

const FORK_GROUP_SEPARATOR = '|'

function appendForkGroup(parent: string | undefined, epoch: string): string {
  return parent === undefined ? epoch : `${parent}${FORK_GROUP_SEPARATOR}${epoch}`
}

function popForkGroup(group: string | undefined): string | undefined {
  if (group === undefined) return undefined
  const separator = group.lastIndexOf(FORK_GROUP_SEPARATOR)
  return separator === -1 ? undefined : group.slice(0, separator)
}
