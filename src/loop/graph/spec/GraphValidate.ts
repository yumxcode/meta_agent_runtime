import { createHash } from 'node:crypto'
import { compileCondition } from '../runtime/GraphExpression.js'
import { isJsonValue, validateShape } from '../runtime/GraphJson.js'
import type {
  FrozenCapabilityRef,
  FrozenLoopGraphSpec,
  JsonValue,
  LoopGraphSpec,
  NodeSpec,
  TransitionSpec,
  ValueExpression,
} from './GraphTypes.js'
import type {
  CapabilityRegistry,
  EffectProvider,
  FunctionProvider,
  ReducerProvider,
} from '../registry/CapabilityRegistry.js'
import type { CapabilityPackRegistry } from '../registry/CapabilityPack.js'
import { createBuiltinContextProviderRegistry, type ContextProvider } from '../registry/ContextProvider.js'
import { compileDataPlanes, physicalPlaneId, physicalViewId } from './DataPlaneCompile.js'
import { validateGraphAbiShape } from './GraphAbiValidate.js'

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
const ROOT_RE = /^\$(state|input|output|event|effect|clock|artifacts|evidence)(\.|$)/
const JOURNAL_EVENT_TYPES = new Set([
  'graph_created', 'activation_claimed', 'activation_released', 'activation_context_cached',
  'activation_committed', 'graph_status_changed', 'external_event_recorded', 'external_event_consumed',
  'paused_terminal_resumed',
])

export interface GraphCapabilityRegistries {
  functions: CapabilityRegistry<FunctionProvider>
  reducers: CapabilityRegistry<ReducerProvider>
  effects?: CapabilityRegistry<EffectProvider>
  contextProviders?: CapabilityRegistry<ContextProvider>
  packs?: CapabilityPackRegistry
}

export function validateLoopGraph(spec: LoopGraphSpec, registries: GraphCapabilityRegistries): string[] {
  const errors: string[] = []
  if (!spec || typeof spec !== 'object') return ['graph must be an object']
  const abiErrors = validateGraphAbiShape(spec)
  errors.push(...abiErrors)
  // Do not let malformed LLM JSON crash the repair loop. Unknown fields are
  // safe to continue validating, but invalid container shapes are not.
  if (abiErrors.some(error => /must be an? (object|array)$/.test(error))) return errors
  if (spec.schemaVersion !== 'graph-1.0') errors.push("schemaVersion must be 'graph-1.0'")
  validateId(spec.id, 'id', errors)
  if (!Number.isInteger(spec.version) || spec.version < 1) errors.push('version must be a positive integer')
  if (!spec.goal?.trim()) errors.push('goal must be non-empty')
  if (!Number.isInteger(spec.limits?.maxActivations) || spec.limits.maxActivations < 1) errors.push('limits.maxActivations must be a positive integer')
  validatePositiveOptional(spec.limits?.maxWallTimeMs, 'limits.maxWallTimeMs', errors)
  validatePositiveOptional(spec.limits?.maxCostUsd, 'limits.maxCostUsd', errors)
  validatePositiveOptional(spec.limits?.maxFanOut, 'limits.maxFanOut', errors)
  validatePositiveOptional(spec.limits?.maxPendingTimers, 'limits.maxPendingTimers', errors)
  validatePositiveIntegerOptional(spec.concurrency?.maxActivations, 'concurrency.maxActivations', errors)
  validatePositiveIntegerOptional(spec.concurrency?.maxPerNode, 'concurrency.maxPerNode', errors)
  if (spec.concurrency?.stateConsistency !== undefined && !['commit_latest', 'serializable'].includes(spec.concurrency.stateConsistency)) {
    errors.push('concurrency.stateConsistency must be commit_latest or serializable')
  }
  for (const [i, pack] of (spec.capabilityPacks ?? []).entries()) {
    if (!registries.packs?.has(pack)) errors.push(`capabilityPacks[${i}] '${pack.id}@${pack.version}' is not loaded with matching integrity`)
  }

  for (const [name, variable] of Object.entries(spec.state ?? {})) {
    validateId(name, `state.${name}`, errors)
    const shapeErrors = validateShapeSpec(variable.type, `state.${name}.type`)
    errors.push(...shapeErrors)
    if (!isJsonValue(variable.initial)) errors.push(`state.${name}.initial must be JSON`)
    else if (!shapeErrors.length) errors.push(...validateShape(variable.initial, variable.type, `state.${name}.initial`))
  }

  for (const [laneId, lane] of Object.entries(spec.lanes ?? {})) {
    validateId(laneId, `lanes.${laneId}`, errors)
    if (!['persistent', 'fresh_per_activation'].includes(lane.context)) errors.push(`lanes.${laneId}.context is invalid`)
    if (!['readonly', 'lane_overlay', 'effect_only'].includes(lane.workspace)) errors.push(`lanes.${laneId}.workspace is invalid`)
    if (lane.maxConcurrency !== undefined && (!Number.isInteger(lane.maxConcurrency) || lane.maxConcurrency !== 1)) {
      errors.push(`lanes.${laneId}.maxConcurrency must be 1; a Lane is a single-writer continuity boundary`)
    }
    if (lane.agentProfile) validateInstructionText(lane.agentProfile.systemInstructions, `lanes.${laneId}.agentProfile.systemInstructions`, errors)
  }

  validateArtifactChannels(spec, errors)
  validateViews(spec, errors)
  validateDataPlanes(spec, errors)
  validateWorkspaceBindings(spec, errors)

  const nodeIds = new Set(Object.keys(spec.nodes ?? {}))
  const transitionIds = new Set<string>()
  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) validateNode(nodeId, node, spec, registries, errors)

  for (const [i, transition] of (spec.transitions ?? []).entries()) {
    const at = `transitions[${i}]`
    validateId(transition.id, `${at}.id`, errors)
    if (transitionIds.has(transition.id)) errors.push(`${at}.id '${transition.id}' is duplicated`)
    transitionIds.add(transition.id)
    if (!nodeIds.has(transition.from)) errors.push(`${at}.from references unknown node '${transition.from}'`)
    for (const target of transitionTargets(transition)) {
      if (!nodeIds.has(target.node)) errors.push(`${at}.to references unknown node '${target.node}'`)
      validateBindings(target.inputs, `${at}.to.inputs`, registries, errors)
    }
    if (transition.default && transition.when) errors.push(`${at} cannot set both default and when`)
    if (transition.default && transition.priority !== undefined) errors.push(`${at}.default must not set priority`)
    if (transition.when) {
      try {
        const compiled = compileCondition(transition.when)
        for (const ref of compiled.refs) validateConditionRef(ref, spec, `${at}.when`, errors)
      } catch (error) {
        errors.push(`${at}.when: ${message(error)}`)
      }
    }
    for (const [u, update] of (transition.updates ?? []).entries()) {
      if (!(update.target in (spec.state ?? {}))) errors.push(`${at}.updates[${u}] targets unknown state '${update.target}'`)
      if (!registries.reducers.has(update.reducer)) errors.push(`${at}.updates[${u}] references unknown reducer '${update.reducer}'`)
      for (const [a, arg] of (update.args ?? []).entries()) validateValueExpression(arg, `${at}.updates[${u}].args[${a}]`, registries, errors)
    }
  }

  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    const outgoing = (spec.transitions ?? []).filter(t => t.from === nodeId)
    if (node.type === 'terminal' && node.status !== 'paused' && outgoing.length) errors.push(`terminal node '${nodeId}' cannot have outgoing transitions`)
    if (node.type === 'terminal' && node.status === 'paused' && outgoing.some(transition => transition.on !== 'resume')) {
      errors.push(`paused terminal node '${nodeId}' may only have resume transitions`)
    }
    if (node.type !== 'terminal' && outgoing.length === 0) errors.push(`non-terminal node '${nodeId}' needs an outgoing transition`)
    const byOutcome = groupBy(outgoing, t => t.on ?? 'success')
    for (const [outcome, transitions] of byOutcome) {
      const defaults = transitions.filter(t => t.default || !t.when)
      if (defaults.length > 1) errors.push(`node '${nodeId}' outcome '${outcome}' has multiple default/unconditional transitions`)
      if (transitions.some(t => t.when) && defaults.length !== 1) {
        errors.push(`node '${nodeId}' outcome '${outcome}' needs exactly one default transition for total routing`)
      }
      const priorities = new Set<number>()
      for (const transition of transitions.filter(t => t.when)) {
        const priority = transition.priority ?? 0
        if (priorities.has(priority)) errors.push(`node '${nodeId}' outcome '${outcome}' has conditional transitions sharing priority ${priority}`)
        priorities.add(priority)
      }
    }
    const alwaysCovered = outgoing.some(transition => transition.on === 'always')
    for (const outcome of requiredOutcomes(node)) {
      if (!alwaysCovered && !outgoing.some(transition => (transition.on ?? 'success') === outcome)) {
        errors.push(`node '${nodeId}' must route outcome '${outcome}' or provide an 'always' transition`)
      }
    }
  }

  if (!Array.isArray(spec.entrypoints) || spec.entrypoints.length === 0) errors.push('entrypoints must contain at least one entrypoint')
  const entryIds = new Set<string>()
  for (const [i, entry] of (spec.entrypoints ?? []).entries()) {
    validateId(entry.id, `entrypoints[${i}].id`, errors)
    if (entryIds.has(entry.id)) errors.push(`entrypoints[${i}].id '${entry.id}' is duplicated`)
    entryIds.add(entry.id)
    if (!nodeIds.has(entry.node)) errors.push(`entrypoints[${i}].node references unknown node '${entry.node}'`)
    validateBindings(entry.inputs, `entrypoints[${i}].inputs`, registries, errors)
  }

  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    if (node.type === 'join') for (const expected of node.expects) if (!transitionIds.has(expected)) errors.push(`nodes.${nodeId}.expects references unknown transition '${expected}'`)
  }
  validateDataflowContracts(spec, registries, errors)
  validateReachability(spec, errors)
  validateTerminalReachability(spec, errors)
  return errors
}

function requiredOutcomes(node: NodeSpec): string[] {
  switch (node.type) {
    case 'agent':
    case 'function':
    case 'effect':
      return ['success', 'failure']
    case 'wait':
      return node.wait.kind === 'timer'
        ? ['timer', 'failure']
        : ['event', ...(node.wait.timeoutMs !== undefined ? ['timeout'] : []), 'failure']
    case 'join': return ['success']
    case 'terminal': return node.status === 'paused' ? ['resume'] : []
  }
}

export function freezeLoopGraph(spec: LoopGraphSpec, registries: GraphCapabilityRegistries, now = Date.now()): FrozenLoopGraphSpec {
  for (const field of ['compiledDataPlanes', 'compiledLaneDataAccess', 'capabilityLock', 'graphHash', 'frozenAt']) {
    if (field in spec) throw new Error(`invalid LoopGraphSpec:\n- ${field} is Freeze-owned and cannot appear in a source graph`)
  }
  const errors = validateLoopGraph(spec, registries)
  if (errors.length) throw new Error(`invalid LoopGraphSpec:\n- ${errors.join('\n- ')}`)
  const compiled = compileDataPlanes(spec)
  const compiledErrors = validateLoopGraph(compiled, registries)
  if (compiledErrors.length) throw new Error(`invalid compiled LoopGraphSpec:\n- ${compiledErrors.join('\n- ')}`)
  const functionRefs = new Set<string>()
  const reducerRefs = new Set<string>()
  const effectRefs = new Set<string>()
  const contextProviderRefs = new Set<string>()
  for (const node of Object.values(compiled.nodes)) {
    if (node.type === 'function') functionRefs.add(node.function)
    if (node.type === 'effect') effectRefs.add(node.effect)
    if (node.type === 'agent') {
      contextProviderRefs.add('builtin/activation@1')
      for (const section of node.context?.sections ?? []) contextProviderRefs.add(section.provider)
    }
    collectBindingCalls(node.type === 'agent' || node.type === 'function' || node.type === 'effect' ? node.inputs : undefined, functionRefs)
    if (node.type === 'effect' && node.idempotencyKey) collectValueCalls(node.idempotencyKey, functionRefs)
    if (node.type === 'wait') {
      if (node.wait.kind === 'timer') collectValueCalls(node.wait.delayMs, functionRefs)
      else if (node.wait.correlation) collectValueCalls(node.wait.correlation, functionRefs)
    }
    if (node.type === 'terminal' && node.result) collectValueCalls(node.result, functionRefs)
    for (const publication of node.publishes ?? []) {
      collectValueCalls(publication.value, functionRefs)
      if (publication.supersedes) collectValueCalls(publication.supersedes, functionRefs)
    }
  }
  for (const entry of compiled.entrypoints) collectBindingCalls(entry.inputs, functionRefs)
  for (const transition of compiled.transitions) {
    for (const target of transitionTargets(transition)) collectBindingCalls(target.inputs, functionRefs)
    for (const update of transition.updates ?? []) {
      reducerRefs.add(update.reducer)
      for (const arg of update.args ?? []) collectValueCalls(arg, functionRefs)
    }
  }
  const capabilityLock = {
    functions: manifestsToRefs(registries.functions.refs(functionRefs)),
    reducers: manifestsToRefs(registries.reducers.refs(reducerRefs)),
    effects: registries.effects ? manifestsToRefs(registries.effects.refs(effectRefs)) : [],
    contextProviders: manifestsToRefs(contextRegistry(registries).refs(contextProviderRefs)),
    packs: [...(compiled.capabilityPacks ?? [])].map(pack => registries.packs!.require(pack))
      .sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`)),
  }
  const body = JSON.parse(JSON.stringify({ ...compiled, capabilityLock })) as LoopGraphSpec & { capabilityLock: typeof capabilityLock; compiledDataPlanes?: FrozenLoopGraphSpec['compiledDataPlanes'] }
  const frozen: FrozenLoopGraphSpec = {
    ...body,
    graphHash: createHash('sha256').update(stableStringify(body)).digest('hex'),
    frozenAt: now,
  }
  return frozen
}

/** Recompute the content hash of a frozen graph, excluding its hash and timestamp envelope. */
export function verifyFrozenGraphIntegrity(graph: FrozenLoopGraphSpec): void {
  const { graphHash, frozenAt: _frozenAt, ...body } = graph
  const actual = createHash('sha256').update(stableStringify(body)).digest('hex')
  if (actual !== graphHash) throw new Error(`Frozen LoopGraphSpec integrity mismatch: expected '${graphHash}', computed '${actual}'`)
}

function validateNode(nodeId: string, node: NodeSpec, spec: LoopGraphSpec, registries: GraphCapabilityRegistries, errors: string[]): void {
  const at = `nodes.${nodeId}`
  validateId(nodeId, at, errors)
  validatePositiveOptional(node.timeoutMs, `${at}.timeoutMs`, errors)
  if ((node.type === 'agent' || node.type === 'function') && node.outputSchema) {
    errors.push(...validateShapeSpec(node.outputSchema, `${at}.outputSchema`))
  }
  for (const [i, publication] of (node.publishes ?? []).entries()) {
    const refs = Number(publication.channel !== undefined) + Number(publication.plane !== undefined)
    if (refs !== 1) errors.push(`${at}.publishes[${i}] must contain exactly one of channel or plane`)
    if (publication.channel !== undefined && !(publication.channel in (spec.artifacts ?? {}))) {
      errors.push(`${at}.publishes[${i}] references unknown channel '${publication.channel}'`)
    }
    if (publication.plane !== undefined) {
      const plane = spec.dataPlanes?.[publication.plane]
      if (!plane) errors.push(`${at}.publishes[${i}] references unknown Data Plane '${publication.plane}'`)
      else if (plane.backend !== 'record') errors.push(`${at}.publishes[${i}] Data Plane '${publication.plane}' is not a record backend`)
      else if (plane.mutability === 'append_only' && publication.supersedes) errors.push(`${at}.publishes[${i}] cannot supersede on append_only Plane '${publication.plane}'`)
      if (node.type === 'agent' && !spec.lanes[node.lane]?.dataAccess?.publish?.includes(publication.plane)) {
        errors.push(`${at}.publishes[${i}] exceeds Lane '${node.lane}' publish access for Plane '${publication.plane}'`)
      }
    }
    if (publication.on !== undefined && (typeof publication.on !== 'string' || !publication.on.trim())) errors.push(`${at}.publishes[${i}].on must be non-empty`)
    validateValueExpression(publication.value, `${at}.publishes[${i}].value`, registries, errors)
    if (publication.supersedes) validateValueExpression(publication.supersedes, `${at}.publishes[${i}].supersedes`, registries, errors)
  }
  switch (node.type) {
    case 'agent':
      if (!(node.lane in (spec.lanes ?? {}))) errors.push(`${at}.lane references unknown lane '${node.lane}'`)
      else if (spec.lanes[node.lane]?.workspace === 'effect_only') errors.push(`${at}.lane '${node.lane}' is effect_only`)
      else if (node.timerPolicy?.allowHardPark && spec.lanes[node.lane]?.context !== 'persistent') {
        errors.push(`${at}.timerPolicy.allowHardPark requires a persistent Lane`)
      }
      if (!node.prompt?.trim()) errors.push(`${at}.prompt must be non-empty`)
      if (node.systemInstructions !== undefined) validateInstructionText(node.systemInstructions, `${at}.systemInstructions`, errors)
      validateContextPlan(node.context, at, spec, registries, errors)
      validateWorkspaceContextLanes(node, at, spec, errors)
      if (node.maxAttempts !== undefined && (!Number.isInteger(node.maxAttempts) || node.maxAttempts < 1)) errors.push(`${at}.maxAttempts must be a positive integer`)
      validatePositiveIntegerOptional(node.budget?.turns, `${at}.budget.turns`, errors)
      validatePositiveOptional(node.budget?.usd, `${at}.budget.usd`, errors)
      validatePositiveOptional(node.budget?.wallTimeMs, `${at}.budget.wallTimeMs`, errors)
      validatePositiveIntegerOptional(node.lifetimeBudget?.turns, `${at}.lifetimeBudget.turns`, errors)
      validatePositiveOptional(node.lifetimeBudget?.usd, `${at}.lifetimeBudget.usd`, errors)
      validatePositiveOptional(node.lifetimeBudget?.elapsedMs, `${at}.lifetimeBudget.elapsedMs`, errors)
      validatePositiveOptional(node.timerPolicy?.maxDelayMs, `${at}.timerPolicy.maxDelayMs`, errors)
      validatePositiveIntegerOptional(node.timerPolicy?.maxParks, `${at}.timerPolicy.maxParks`, errors)
      if (node.timerPolicy?.allowHardPark) {
        if (node.timerPolicy.maxDelayMs === undefined) errors.push(`${at}.timerPolicy.maxDelayMs is required when hard park is enabled`)
        if (node.timerPolicy.maxParks === undefined) errors.push(`${at}.timerPolicy.maxParks is required when hard park is enabled`)
        if (node.budget?.turns === undefined) errors.push(`${at}.budget.turns is required when hard park is enabled`)
        if (node.budget?.usd === undefined) errors.push(`${at}.budget.usd is required when hard park is enabled`)
        if (node.budget?.wallTimeMs === undefined) errors.push(`${at}.budget.wallTimeMs is required when hard park is enabled`)
        if (node.lifetimeBudget?.turns === undefined) errors.push(`${at}.lifetimeBudget.turns is required when hard park is enabled`)
        if (node.lifetimeBudget?.usd === undefined) errors.push(`${at}.lifetimeBudget.usd is required when hard park is enabled`)
        if (node.lifetimeBudget?.elapsedMs === undefined) errors.push(`${at}.lifetimeBudget.elapsedMs is required when hard park is enabled`)
      }
      validateBindings(node.inputs, `${at}.inputs`, registries, errors)
      for (const [i, path] of (node.writes ?? []).entries()) {
        if (typeof path !== 'string' || !path || path.startsWith('/') || path.startsWith('\\') || path.split(/[\\/]/).includes('..')) {
          errors.push(`${at}.writes[${i}] must be a workspace-relative path without '..'`)
        }
      }
      break
    case 'function':
      if (!registries.functions.has(node.function)) errors.push(`${at}.function references unknown function '${node.function}'`)
      validateBindings(node.inputs, `${at}.inputs`, registries, errors)
      break
    case 'effect':
      if (!registries.effects?.has(node.effect)) errors.push(`${at}.effect references unknown effect '${node.effect}'`)
      if (node.timeoutMs === undefined) errors.push(`${at}.timeoutMs is required for bounded Effect execution`)
      validateBindings(node.inputs, `${at}.inputs`, registries, errors)
      if (node.idempotencyKey) validateValueExpression(node.idempotencyKey, `${at}.idempotencyKey`, registries, errors)
      break
    case 'wait':
      if (node.wait.kind === 'timer') {
        validateValueExpression(node.wait.delayMs, `${at}.wait.delayMs`, registries, errors)
        validatePositiveOptional(node.wait.maxDelayMs, `${at}.wait.maxDelayMs`, errors)
      } else {
        if (!node.wait.event?.trim()) errors.push(`${at}.wait.event must be non-empty`)
        if (node.wait.correlation) validateValueExpression(node.wait.correlation, `${at}.wait.correlation`, registries, errors)
        validatePositiveOptional(node.wait.timeoutMs, `${at}.wait.timeoutMs`, errors)
      }
      break
    case 'join':
      if (!['all', 'any'].includes(node.mode)) errors.push(`${at}.mode is invalid`)
      if (!Array.isArray(node.expects) || node.expects.length === 0) errors.push(`${at}.expects must be non-empty`)
      break
    case 'terminal':
      if (!['done', 'failed', 'paused'].includes(node.status)) errors.push(`${at}.status is invalid`)
      if (node.result) validateValueExpression(node.result, `${at}.result`, registries, errors)
      break
    default:
      errors.push(`${at}.type '${(node as NodeSpec).type}' is unsupported`)
  }
}

function validateContextPlan(
  plan: Extract<NodeSpec, { type: 'agent' }>['context'],
  at: string,
  spec: LoopGraphSpec,
  registries: GraphCapabilityRegistries,
  errors: string[],
): void {
  if (!plan) return
  if (!Array.isArray(plan.sections)) { errors.push(`${at}.context.sections must be an array`); return }
  if (plan.sections.length > 32) errors.push(`${at}.context.sections cannot contain more than 32 sections`)
  const names = new Set<string>()
  for (const [index, section] of plan.sections.entries()) {
    const sectionAt = `${at}.context.sections[${index}]`
    validateId(section.name, `${sectionAt}.name`, errors)
    if (section.name.startsWith('kernel_')) errors.push(`${sectionAt}.name uses reserved 'kernel_' prefix`)
    if (names.has(section.name)) errors.push(`${sectionAt}.name '${section.name}' is duplicated`)
    names.add(section.name)
    if (!['activation_start', 'every_segment', 'continuation_only'].includes(section.refresh)) {
      errors.push(`${sectionAt}.refresh is invalid`)
    }
    if (section.config !== undefined && !isJsonValue(section.config)) errors.push(`${sectionAt}.config must be JSON`)
    if (section.maxBytes !== undefined && (!Number.isInteger(section.maxBytes) || section.maxBytes < 256 || section.maxBytes > 262_144)) {
      errors.push(`${sectionAt}.maxBytes must be an integer in 256..262144`)
    }
    if (section.required !== undefined && typeof section.required !== 'boolean') errors.push(`${sectionAt}.required must be boolean`)
    const contexts = contextRegistry(registries)
    if (!contexts.has(section.provider)) {
      errors.push(`${sectionAt}.provider references unknown Context Provider '${section.provider}'`)
      continue
    }
    const provider = contexts.get(section.provider)
    if (!['trusted_runtime', 'trusted_graph', 'untrusted_data'].includes(provider.manifest.trust)) {
      errors.push(`${sectionAt}.provider '${section.provider}' declares invalid trust '${provider.manifest.trust}'`)
    }
    try {
      for (const problem of provider.validate?.(section, spec) ?? []) errors.push(`${sectionAt}: ${problem}`)
    } catch (error) {
      errors.push(`${sectionAt}.provider validation failed: ${message(error)}`)
    }
  }
}

function validateWorkspaceContextLanes(
  node: Extract<NodeSpec, { type: 'agent' }>,
  at: string,
  spec: LoopGraphSpec,
  errors: string[],
): void {
  for (const [index, section] of (node.context?.sections ?? []).entries()) {
    if (section.provider !== 'builtin/workspace-binding@1') continue
    const config = section.config
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue
    const name = config['binding']
    if (typeof name !== 'string') continue
    const binding = spec.workspaceBindings?.[name]
    if (binding?.lane && binding.lane !== node.lane) {
      errors.push(`${at}.context.sections[${index}] binding '${name}' belongs to Lane '${binding.lane}', not '${node.lane}'`)
    }
  }
}

function validateViews(spec: LoopGraphSpec, errors: string[]): void {
  for (const [kind, views] of [['evidence', spec.evidenceViews], ['artifact', spec.artifactViews]] as const) {
    for (const [name, view] of Object.entries(views ?? {})) {
      validateId(name, `${kind}Views.${name}`, errors)
      if (!Array.isArray(view.channels) || view.channels.length === 0) errors.push(`${kind}Views.${name}.channels must be non-empty`)
      for (const channel of view.channels ?? []) {
        const declaration = spec.artifacts?.[channel]
        if (!declaration) errors.push(`${kind}Views.${name}.channels references unknown channel '${channel}'`)
        else if ((declaration.kind ?? 'artifact') !== kind) errors.push(`${kind}Views.${name}.channels '${channel}' is not kind '${kind}'`)
      }
      if (view.maxItems !== undefined && (!Number.isInteger(view.maxItems) || view.maxItems < 1 || view.maxItems > 10_000)) {
        errors.push(`${kind}Views.${name}.maxItems must be an integer in 1..10000`)
      }
      for (const status of view.statuses ?? []) if (!['proposed', 'admitted', 'rejected', 'superseded'].includes(status)) {
        errors.push(`${kind}Views.${name}.statuses contains invalid status '${status}'`)
      }
    }
  }
}

function validateArtifactChannels(spec: LoopGraphSpec, errors: string[]): void {
  for (const [name, channel] of Object.entries(spec.artifacts ?? {})) {
    const at = `artifacts.${name}`
    validateId(name, at, errors)
    if (channel.kind !== undefined && !['artifact', 'evidence'].includes(channel.kind)) errors.push(`${at}.kind is invalid`)
    if (channel.admission !== undefined && !['automatic', 'judge'].includes(channel.admission)) errors.push(`${at}.admission is invalid`)
    if (channel.maxItems !== undefined && (!Number.isInteger(channel.maxItems) || channel.maxItems < 1 || channel.maxItems > 100_000)) {
      errors.push(`${at}.maxItems must be an integer in 1..100000`)
    }
    if (channel.schema) errors.push(...validateShapeSpec(channel.schema, `${at}.schema`))
  }
}

function validateDataPlanes(spec: LoopGraphSpec, errors: string[]): void {
  const planes = spec.dataPlanes ?? {}
  const views = spec.dataViews ?? {}
  const alreadyCompiled = Boolean((spec as LoopGraphSpec & { compiledDataPlanes?: unknown }).compiledDataPlanes)
  if (!alreadyCompiled && Object.keys(planes).length) {
    for (const [field, declarations] of [
      ['artifacts', spec.artifacts], ['artifactViews', spec.artifactViews],
      ['evidenceViews', spec.evidenceViews], ['workspaceBindings', spec.workspaceBindings],
    ] as const) {
      if (Object.keys(declarations ?? {}).length) errors.push(`${field} is a physical Freeze output and cannot be mixed with logical dataPlanes`)
    }
    const physicalProviders = new Set([
      'builtin/state@1', 'builtin/evidence-view@1', 'builtin/artifact-view@1',
      'builtin/journal-view@1', 'builtin/workspace-binding@1',
    ])
    for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
      if (node.type === 'agent') for (const [index, section] of (node.context?.sections ?? []).entries()) {
        if (physicalProviders.has(section.provider)) errors.push(`nodes.${nodeId}.context.sections[${index}] uses physical Provider '${section.provider}' in logical Data Plane mode`)
      }
      for (const [index, publication] of (node.publishes ?? []).entries()) {
        if (publication.channel) errors.push(`nodes.${nodeId}.publishes[${index}].channel is a physical Freeze output in logical Data Plane mode`)
      }
    }
  }
  for (const [planeId, plane] of Object.entries(planes)) {
    const at = `dataPlanes.${planeId}`
    validateId(planeId, at, errors)
    if (!isPlainRecord(plane)) { errors.push(`${at} must be an object`); continue }
    if (!plane.semanticRole?.trim()) errors.push(`${at}.semanticRole must be non-empty`)
    if (!['state', 'record', 'journal', 'workspace'].includes(plane.backend)) errors.push(`${at}.backend is invalid`)
    const expectedTrust = plane.backend === 'state' ? 'trusted_runtime' : 'untrusted_data'
    if (plane.trust !== expectedTrust) errors.push(`${at}.trust must be '${expectedTrust}' for backend '${plane.backend}'`)
    if (plane.backend === 'state') {
      if (!Array.isArray(plane.stateKeys) || plane.stateKeys.length === 0) errors.push(`${at}.stateKeys must be non-empty`)
      for (const key of Array.isArray(plane.stateKeys) ? plane.stateKeys : []) {
        if (typeof key !== 'string' || !key) errors.push(`${at}.stateKeys must contain non-empty strings`)
        else if (!(key in (spec.state ?? {}))) errors.push(`${at}.stateKeys references unknown State '${key}'`)
      }
    } else if (plane.backend === 'record') {
      if (!['evidence', 'artifact'].includes(plane.recordKind)) errors.push(`${at}.recordKind is invalid`)
      if (!['append_only', 'superseding'].includes(plane.mutability)) errors.push(`${at}.mutability is invalid`)
      if (!['automatic', 'judge'].includes(plane.admission)) errors.push(`${at}.admission is invalid`)
      if (plane.retention !== undefined && !isPlainRecord(plane.retention)) errors.push(`${at}.retention must be an object`)
      else if (plane.retention?.maxItems !== undefined && (!Number.isInteger(plane.retention.maxItems) || plane.retention.maxItems < 1 || plane.retention.maxItems > 100_000)) {
          errors.push(`${at}.retention.maxItems must be an integer in 1..100000`)
      }
      if (plane.schema) errors.push(...validateShapeSpec(plane.schema, `${at}.schema`))
      if (!alreadyCompiled && physicalPlaneId(planeId) in (spec.artifacts ?? {})) errors.push(`${at} compiled channel '${physicalPlaneId(planeId)}' conflicts with a physical channel`)
    } else if (plane.backend === 'journal') {
      if (plane.eventTypes !== undefined && !Array.isArray(plane.eventTypes)) errors.push(`${at}.eventTypes must be an array`)
      for (const eventType of Array.isArray(plane.eventTypes) ? plane.eventTypes : []) if (!JOURNAL_EVENT_TYPES.has(eventType)) errors.push(`${at}.eventTypes contains invalid event type '${eventType}'`)
    } else if (plane.backend === 'workspace') {
      if (!isPlainRecord(plane.binding)) { errors.push(`${at}.binding must be an object`); continue }
      if (!alreadyCompiled && physicalPlaneId(planeId) in (spec.workspaceBindings ?? {})) errors.push(`${at} compiled binding '${physicalPlaneId(planeId)}' conflicts with a physical binding`)
      if (plane.binding.projection?.kind === 'data_view') {
        const source = views[plane.binding.projection.view]
        if (!source) errors.push(`${at}.binding.projection references unknown Data View '${plane.binding.projection.view}'`)
        else if (planes[source.plane]?.backend === 'workspace') errors.push(`${at}.binding.projection cannot materialize another workspace Plane`)
      }
    }
  }

  for (const [viewId, view] of Object.entries(views)) {
    const at = `dataViews.${viewId}`
    validateId(viewId, at, errors)
    if (!isPlainRecord(view)) { errors.push(`${at} must be an object`); continue }
    const plane = planes[view.plane]
    if (!plane) { errors.push(`${at}.plane references unknown Data Plane '${view.plane}'`); continue }
    if (view.maxItems !== undefined && (!Number.isInteger(view.maxItems) || view.maxItems < 1 || view.maxItems > 10_000)) {
      errors.push(`${at}.maxItems must be an integer in 1..10000`)
    }
    if (plane.backend === 'state') {
      if (view.statuses || view.eventTypes || view.maxItems !== undefined) errors.push(`${at} contains selectors unsupported by state backend`)
      if (view.stateKeys !== undefined && !Array.isArray(view.stateKeys)) errors.push(`${at}.stateKeys must be an array`)
      for (const key of Array.isArray(view.stateKeys) ? view.stateKeys : plane.stateKeys) if (!plane.stateKeys.includes(key)) errors.push(`${at}.stateKeys '${key}' is outside Plane '${view.plane}'`)
    } else if (plane.backend === 'record') {
      if (view.stateKeys || view.eventTypes) errors.push(`${at} contains selectors unsupported by record backend`)
      if (view.statuses !== undefined && !Array.isArray(view.statuses)) errors.push(`${at}.statuses must be an array`)
      for (const status of Array.isArray(view.statuses) ? view.statuses : []) if (!['proposed', 'admitted', 'rejected', 'superseded'].includes(status)) errors.push(`${at}.statuses contains invalid status '${status}'`)
      if (!alreadyCompiled && physicalViewId(viewId) in (plane.recordKind === 'evidence' ? (spec.evidenceViews ?? {}) : (spec.artifactViews ?? {}))) {
        errors.push(`${at} compiled View '${physicalViewId(viewId)}' conflicts with a physical View`)
      }
    } else if (plane.backend === 'journal') {
      if (view.stateKeys || view.statuses) errors.push(`${at} contains selectors unsupported by journal backend`)
      if (view.eventTypes !== undefined && !Array.isArray(view.eventTypes)) errors.push(`${at}.eventTypes must be an array`)
      for (const eventType of Array.isArray(view.eventTypes) ? view.eventTypes : []) if (!JOURNAL_EVENT_TYPES.has(eventType)) errors.push(`${at}.eventTypes contains invalid event type '${eventType}'`)
    } else if (view.stateKeys || view.statuses || view.eventTypes || view.maxItems !== undefined) {
      errors.push(`${at} workspace backend does not support selectors`)
    }
  }

  for (const [laneId, lane] of Object.entries(spec.lanes ?? {})) {
    if (lane.dataAccess !== undefined && !isPlainRecord(lane.dataAccess)) {
      errors.push(`lanes.${laneId}.dataAccess must be an object`)
      continue
    }
    if (lane.dataAccess?.read !== undefined && !Array.isArray(lane.dataAccess.read)) errors.push(`lanes.${laneId}.dataAccess.read must be an array`)
    if (lane.dataAccess?.publish !== undefined && !Array.isArray(lane.dataAccess.publish)) errors.push(`lanes.${laneId}.dataAccess.publish must be an array`)
    if (lane.dataAccess?.write !== undefined && !Array.isArray(lane.dataAccess.write)) errors.push(`lanes.${laneId}.dataAccess.write must be an array`)
    const seenRead = new Set<string>()
    for (const [index, grant] of (Array.isArray(lane.dataAccess?.read) ? lane.dataAccess.read : []).entries()) {
      const at = `lanes.${laneId}.dataAccess.read[${index}]`
      if (!isPlainRecord(grant)) { errors.push(`${at} must be an object`); continue }
      const planeId = grant['plane']
      const grantViews = grant['views']
      if (typeof planeId !== 'string' || !planeId) { errors.push(`${at}.plane must be a non-empty string`); continue }
      if (seenRead.has(planeId)) errors.push(`${at}.plane '${planeId}' is duplicated`)
      seenRead.add(planeId)
      if (!planes[planeId]) errors.push(`${at}.plane references unknown Data Plane '${planeId}'`)
      if (grantViews !== undefined && !Array.isArray(grantViews)) errors.push(`${at}.views must be an array`)
      const viewList = Array.isArray(grantViews) ? grantViews : []
      if (new Set(viewList).size !== viewList.length) errors.push(`${at}.views must not contain duplicates`)
      for (const viewId of viewList) {
        if (typeof viewId !== 'string' || !viewId) { errors.push(`${at}.views must contain non-empty strings`); continue }
        if (!views[viewId]) errors.push(`${at}.views references unknown Data View '${viewId}'`)
        else if (views[viewId]!.plane !== planeId) errors.push(`${at}.views '${viewId}' belongs to Plane '${views[viewId]!.plane}'`)
      }
    }
    for (const [kind, planeIds] of [['publish', lane.dataAccess?.publish], ['write', lane.dataAccess?.write]] as const) {
      const list = Array.isArray(planeIds) ? planeIds : []
      if (new Set(list).size !== list.length) errors.push(`lanes.${laneId}.dataAccess.${kind} must not contain duplicates`)
      for (const [index, planeId] of list.entries()) {
        const plane = planes[planeId]
        const at = `lanes.${laneId}.dataAccess.${kind}[${index}]`
        if (!plane) errors.push(`${at} references unknown Data Plane '${planeId}'`)
        else if (kind === 'publish' && plane.backend !== 'record') errors.push(`${at} Plane '${planeId}' is not a record backend`)
        else if (kind === 'write' && plane.backend !== 'workspace') errors.push(`${at} Plane '${planeId}' is not a workspace backend`)
        else if (kind === 'write' && plane.backend === 'workspace' && plane.binding.lane !== laneId) errors.push(`${at} workspace Plane '${planeId}' does not belong to Lane '${laneId}'`)
        else if (kind === 'write' && spec.lanes[laneId]?.workspace !== 'lane_overlay') errors.push(`${at} requires Lane '${laneId}' to use lane_overlay`)
        else if (kind === 'write' && plane.backend === 'workspace' && plane.binding.plane !== 'observability' && plane.binding.direction !== 'bidirectional') {
          errors.push(`${at} workspace Plane '${planeId}' is Kernel/input-owned; direct Lane writes require observability or bidirectional ownership`)
        }
      }
    }
  }

  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    if (node.type !== 'agent') continue
    for (const [index, section] of (node.context?.sections ?? []).entries()) {
      if (section.provider !== 'builtin/data-plane-view@1') continue
      const config = section.config
      const viewId = config && typeof config === 'object' && !Array.isArray(config) ? config['view'] : undefined
      if (typeof viewId !== 'string' || !views[viewId]) continue
      const view = views[viewId]!
      const allowed = spec.lanes[node.lane]?.dataAccess?.read?.some(grant =>
        grant.plane === view.plane && (!grant.views || grant.views.includes(viewId)))
      if (!allowed) errors.push(`nodes.${nodeId}.context.sections[${index}] exceeds Lane '${node.lane}' read access for View '${viewId}'`)
    }
  }
}

function validateWorkspaceBindings(spec: LoopGraphSpec, errors: string[]): void {
  const destinations = new Set<string>()
  const initializedStateKeys = new Set<string>()
  for (const [name, binding] of Object.entries(spec.workspaceBindings ?? {})) {
    const at = `workspaceBindings.${name}`
    validateId(name, at, errors)
    if (!['input', 'state_projection', 'evidence', 'artifact', 'audit', 'observability'].includes(binding.plane)) {
      errors.push(`${at}.plane is invalid`)
    }
    if (!['json', 'jsonl', 'text', 'markdown'].includes(binding.format)) errors.push(`${at}.format is invalid`)
    if (!['ingest', 'materialize', 'bidirectional'].includes(binding.direction)) errors.push(`${at}.direction is invalid`)
    if (!isSafeWorkspacePath(binding.path)) errors.push(`${at}.path must be workspace-relative, non-reserved, and contain no '..'`)
    if (binding.required !== undefined && typeof binding.required !== 'boolean') errors.push(`${at}.required must be boolean`)
    if (binding.appendOnly !== undefined && typeof binding.appendOnly !== 'boolean') errors.push(`${at}.appendOnly must be boolean`)
    if (binding.appendOnly && binding.format !== 'jsonl') errors.push(`${at}.appendOnly requires format 'jsonl'`)
    if (binding.lane !== undefined) {
      const lane = spec.lanes?.[binding.lane]
      if (!lane) errors.push(`${at}.lane references unknown Lane '${binding.lane}'`)
      else if (binding.direction !== 'ingest' && lane.workspace !== 'lane_overlay') {
        errors.push(`${at}.lane '${binding.lane}' must use lane_overlay for materialization`)
      }
    }
    const destination = `${binding.lane ?? '$project'}:${binding.path}`
    if (destinations.has(destination)) errors.push(`${at}.path conflicts with another binding in the same workspace`)
    destinations.add(destination)

    const materializes = binding.direction !== 'ingest'
    if (materializes && !binding.projection) errors.push(`${at}.projection is required for ${binding.direction}`)
    if (!materializes && binding.projection) errors.push(`${at}.projection is only valid when direction includes materialization`)
    if (binding.direction === 'bidirectional' && binding.format !== 'jsonl') {
      errors.push(`${at}.bidirectional currently requires format 'jsonl'`)
    }
    if (binding.plane === 'input' || binding.plane === 'observability') {
      if (binding.direction !== 'ingest') errors.push(`${at}.${binding.plane} bindings are ingest-only`)
    }
    if (binding.plane === 'state_projection') {
      if (binding.direction !== 'materialize') errors.push(`${at}.state_projection must use direction 'materialize'`)
      if (binding.format !== 'json') errors.push(`${at}.state_projection must use format 'json'`)
      if (binding.projection?.kind !== 'state') errors.push(`${at}.state_projection requires a state projection`)
    }
    if (binding.plane === 'audit' && binding.projection?.kind !== 'journal') {
      errors.push(`${at}.audit requires a journal projection`)
    }
    if (binding.plane === 'evidence' && binding.projection && binding.projection.kind !== 'evidence_view') {
      errors.push(`${at}.evidence materialization requires an evidence_view projection`)
    }
    if (binding.plane === 'artifact' && binding.projection && binding.projection.kind !== 'artifact_view') {
      errors.push(`${at}.artifact materialization requires an artifact_view projection`)
    }

    const projection = binding.projection
    if (projection?.kind === 'state') {
      for (const key of projection.keys ?? Object.keys(spec.state ?? {})) {
        if (!(key in (spec.state ?? {}))) errors.push(`${at}.projection.keys references unknown State '${key}'`)
      }
    } else if (projection?.kind === 'evidence_view') {
      if (!(projection.view in (spec.evidenceViews ?? {}))) errors.push(`${at}.projection.view references unknown Evidence View '${projection.view}'`)
      if (projection.flattenArrays !== undefined && typeof projection.flattenArrays !== 'boolean') errors.push(`${at}.projection.flattenArrays must be boolean`)
      if (projection.flattenArrays && projection.record !== 'content') errors.push(`${at}.projection.flattenArrays requires record 'content'`)
    } else if (projection?.kind === 'artifact_view') {
      if (!(projection.view in (spec.artifactViews ?? {}))) errors.push(`${at}.projection.view references unknown Artifact View '${projection.view}'`)
      if (projection.flattenArrays !== undefined && typeof projection.flattenArrays !== 'boolean') errors.push(`${at}.projection.flattenArrays must be boolean`)
      if (projection.flattenArrays && projection.record !== 'content') errors.push(`${at}.projection.flattenArrays requires record 'content'`)
    } else if (projection?.kind === 'journal') {
      for (const eventType of projection.eventTypes ?? []) if (!JOURNAL_EVENT_TYPES.has(eventType)) {
        errors.push(`${at}.projection.eventTypes contains invalid event type '${eventType}'`)
      }
    } else if (projection?.kind === 'data_view') {
      errors.push(`${at}.projection.data_view is only valid inside a logical workspace Data Plane`)
    }

    if (binding.initializeState !== undefined) {
      if (binding.plane !== 'state_projection' || projection?.kind !== 'state') {
        errors.push(`${at}.initializeState is only valid for state_projection bindings`)
      }
      if (!['graph_defaults', 'workspace_if_present', 'workspace_required'].includes(binding.initializeState)) {
        errors.push(`${at}.initializeState is invalid`)
      }
      if (binding.lane !== undefined) errors.push(`${at}.initializeState must read from the project workspace before Lane creation`)
      if (binding.initializeState !== 'graph_defaults') {
        for (const key of projection?.kind === 'state' ? (projection.keys ?? Object.keys(spec.state ?? {})) : []) {
          if (initializedStateKeys.has(key)) errors.push(`${at}.initializeState overlaps State '${key}' with another binding`)
          initializedStateKeys.add(key)
        }
      }
    }
  }
}

function isSafeWorkspacePath(path: string): boolean {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.startsWith('\\')) return false
  const parts = path.split(/[\\/]/)
  if (parts.includes('..') || parts.includes('') || parts.includes('.')) return false
  return !['.loop', '.git', '.meta-agent'].includes(parts[0]!)
}

function validateInstructionText(value: string, at: string, errors: string[]): void {
  if (typeof value !== 'string' || !value.trim()) errors.push(`${at} must be non-empty`)
  else if (Buffer.byteLength(value, 'utf8') > 32_768) errors.push(`${at} exceeds 32768 bytes`)
}

function contextRegistry(registries: GraphCapabilityRegistries): CapabilityRegistry<ContextProvider> {
  return registries.contextProviders ?? createBuiltinContextProviderRegistry()
}

function validateBindings(bindings: Record<string, ValueExpression> | undefined, at: string, registries: GraphCapabilityRegistries, errors: string[]): void {
  for (const [name, expression] of Object.entries(bindings ?? {})) validateValueExpression(expression, `${at}.${name}`, registries, errors)
}

function validateValueExpression(expression: ValueExpression, at: string, registries: GraphCapabilityRegistries, errors: string[], depth = 0): void {
  if (depth > 20) { errors.push(`${at} nesting exceeds 20`); return }
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) { errors.push(`${at} must be a value expression`); return }
  const keys = ['literal', 'ref', 'call'].filter(key => key in expression)
  if (keys.length !== 1) { errors.push(`${at} must contain exactly one of literal, ref, or call`); return }
  if ('literal' in expression && !isJsonValue(expression.literal)) errors.push(`${at}.literal must be JSON`)
  if ('ref' in expression && (typeof expression.ref !== 'string' || !ROOT_RE.test(expression.ref))) errors.push(`${at}.ref '${String(expression.ref)}' has an unsupported root`)
  if ('call' in expression) {
    if (!registries.functions.has(expression.call)) errors.push(`${at}.call references unknown function '${expression.call}'`)
    for (const [i, arg] of (expression.args ?? []).entries()) validateValueExpression(arg, `${at}.args[${i}]`, registries, errors, depth + 1)
  }
}

function validateConditionRef(ref: string, spec: LoopGraphSpec, at: string, errors: string[]): void {
  const root = ref.split('.')[0]
  if (!['state', 'input', 'output', 'event', 'effect', 'clock', 'artifacts', 'evidence'].includes(root!)) {
    errors.push(`${at} uses unsupported root '${root}'`)
  }
  if (root === 'state') {
    const variable = ref.split('.')[1]
    if (!variable || !(variable in (spec.state ?? {}))) errors.push(`${at} references undeclared state '$${ref}'`)
  }
}

/**
 * Conservative dataflow checking: reject references proven impossible by a
 * declared contract, but allow open/dynamic outputs when no schema exists.
 * This keeps Agent creativity while turning schema-backed typos into Freeze
 * errors instead of late runtime failures.
 */
function validateDataflowContracts(spec: LoopGraphSpec, registries: GraphCapabilityRegistries, errors: string[]): void {
  for (const [index, transition] of (spec.transitions ?? []).entries()) {
    const at = `transitions[${index}]`
    if (transition.when) {
      try {
        for (const ref of compileCondition(transition.when).refs) validateContractRef(ref, transition.from, spec, registries, `${at}.when`, errors)
      } catch { /* syntax errors are reported by the primary expression validator */ }
    }
    for (const [updateIndex, update] of (transition.updates ?? []).entries()) {
      for (const [argIndex, arg] of (update.args ?? []).entries()) {
        walkExpressionRefs(arg, ref => validateContractRef(ref, transition.from, spec, registries, `${at}.updates[${updateIndex}].args[${argIndex}]`, errors))
      }
    }
    for (const target of transitionTargets(transition)) for (const [name, expression] of Object.entries(target.inputs ?? {})) {
      walkExpressionRefs(expression, ref => validateContractRef(ref, transition.from, spec, registries, `${at}.to.inputs.${name}`, errors))
    }
  }
  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    for (const [index, publication] of (node.publishes ?? []).entries()) {
      walkExpressionRefs(publication.value, ref => validateContractRef(ref, nodeId, spec, registries, `nodes.${nodeId}.publishes[${index}].value`, errors))
      if (publication.supersedes) walkExpressionRefs(publication.supersedes, ref => validateContractRef(ref, nodeId, spec, registries, `nodes.${nodeId}.publishes[${index}].supersedes`, errors))
    }
    if ((node.type === 'function' || node.type === 'effect') && node.inputs) {
      const manifest = node.type === 'function'
        ? (registries.functions.has(node.function) ? registries.functions.get(node.function).manifest : undefined)
        : (registries.effects?.has(node.effect) ? registries.effects.get(node.effect).manifest : undefined)
      if (manifest?.inputSchema) {
        const literal = literalBindings(node.inputs)
        if (literal) errors.push(...validateShape(literal, manifest.inputSchema, `nodes.${nodeId}.inputs`))
      }
    }
  }
}

function validateContractRef(
  ref: string,
  sourceNodeId: string,
  spec: LoopGraphSpec,
  registries: GraphCapabilityRegistries,
  at: string,
  errors: string[],
): void {
  const [root, ...path] = ref.split('.')
  if (path.some(segment => /^\d+$/.test(segment))) {
    errors.push(`${at} uses array indexing in '$${ref}'; expose a named scalar or registered Function result instead`)
    return
  }
  let shape
  if (root === 'state') {
    const variable = path.shift()
    shape = variable ? spec.state?.[variable]?.type : undefined
  } else if (root === 'output') {
    const node = spec.nodes?.[sourceNodeId]
    if (node?.type === 'agent' || node?.type === 'function') shape = node.outputSchema
    if (!shape && node?.type === 'function' && registries.functions.has(node.function)) shape = registries.functions.get(node.function).manifest.outputSchema
    if (!shape && node?.type === 'effect' && registries.effects?.has(node.effect)) shape = registries.effects.get(node.effect).manifest.outputSchema
  } else return
  if (!shape || path.length === 0) return
  let current = shape
  for (const segment of path) {
    if (current.type !== 'object') {
      errors.push(`${at} references '$${ref}', but '${segment}' is below non-object schema type '${current.type}'`)
      return
    }
    const next = current.properties?.[segment]
    if (!next) {
      if (current.additionalProperties === false) errors.push(`${at} references '$${ref}', but '${segment}' is absent from the closed output/state schema`)
      return
    }
    current = next
  }
}

function walkExpressionRefs(expression: ValueExpression, visit: (ref: string) => void): void {
  if ('ref' in expression) visit(expression.ref.replace(/^\$/, ''))
  if ('call' in expression) for (const arg of expression.args ?? []) walkExpressionRefs(arg, visit)
}

function literalBindings(bindings: Record<string, ValueExpression>): Record<string, JsonValue> | undefined {
  const output: Record<string, JsonValue> = {}
  for (const [name, expression] of Object.entries(bindings)) {
    if (!('literal' in expression)) return undefined
    output[name] = expression.literal
  }
  return output
}

/** Every reachable node must have some topological path to done/failed. */
function validateTerminalReachability(spec: LoopGraphSpec, errors: string[]): void {
  const finalNodes = new Set(Object.entries(spec.nodes ?? {})
    .filter(([, node]) => node.type === 'terminal' && node.status !== 'paused')
    .map(([nodeId]) => nodeId))
  if (!finalNodes.size) {
    errors.push('graph needs at least one done or failed terminal node')
    return
  }
  const canFinish = new Set(finalNodes)
  let changed = true
  while (changed) {
    changed = false
    for (const transition of spec.transitions ?? []) {
      if (canFinish.has(transition.from)) continue
      if (transitionTargets(transition).some(target => canFinish.has(target.node))) {
        canFinish.add(transition.from)
        changed = true
      }
    }
  }
  const reachable = new Set(spec.entrypoints?.map(entry => entry.node) ?? [])
  changed = true
  while (changed) {
    changed = false
    for (const transition of spec.transitions ?? []) if (reachable.has(transition.from)) {
      for (const target of transitionTargets(transition)) if (!reachable.has(target.node)) { reachable.add(target.node); changed = true }
    }
  }
  for (const nodeId of reachable) if (!canFinish.has(nodeId)) {
    errors.push(`node '${nodeId}' is in a closed path that cannot reach a done/failed terminal`)
  }
}

function validateReachability(spec: LoopGraphSpec, errors: string[]): void {
  const reached = new Set(spec.entrypoints?.map(entry => entry.node) ?? [])
  let changed = true
  while (changed) {
    changed = false
    for (const transition of spec.transitions ?? []) if (reached.has(transition.from)) {
      for (const target of transitionTargets(transition)) if (!reached.has(target.node)) { reached.add(target.node); changed = true }
    }
  }
  for (const nodeId of Object.keys(spec.nodes ?? {})) if (!reached.has(nodeId)) errors.push(`node '${nodeId}' is unreachable from every entrypoint`)
}

export function transitionTargets(transition: TransitionSpec): Array<{ node: string; inputs?: Record<string, ValueExpression> }> {
  const raw = Array.isArray(transition.to) ? transition.to : [transition.to]
  return raw.map(target => typeof target === 'string' ? { node: target } : target)
}

function validateId(value: string, at: string, errors: string[]): void {
  if (typeof value !== 'string' || !ID_RE.test(value)) errors.push(`${at} must match ${ID_RE}`)
}

function validatePositiveOptional(value: number | undefined, at: string, errors: string[]): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) errors.push(`${at} must be positive`)
}

function validatePositiveIntegerOptional(value: number | undefined, at: string, errors: string[]): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) errors.push(`${at} must be a positive integer`)
}

function validateShapeSpec(value: unknown, at: string, depth = 0): string[] {
  if (depth > 20) return [`${at} nesting exceeds 20`]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at} must be a ShapeSpec object`]
  const shape = value as Record<string, unknown>
  const type = shape.type
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(type))) {
    return [`${at}.type is invalid`]
  }
  const errors: string[] = []
  const allowedByType: Record<string, Set<string>> = {
    object: new Set(['type', 'required', 'properties', 'additionalProperties']),
    array: new Set(['type', 'minItems', 'items']),
    string: new Set(['type', 'minLength', 'enum']),
    number: new Set(['type', 'minimum', 'maximum']),
    integer: new Set(['type', 'minimum', 'maximum']),
    boolean: new Set(['type']),
    null: new Set(['type']),
  }
  for (const key of Object.keys(shape)) if (!allowedByType[String(type)]!.has(key)) errors.push(`${at}.${key} is unsupported for type '${String(type)}'`)
  if (type === 'object') {
    const properties = shape.properties
    if (properties !== undefined && (!properties || typeof properties !== 'object' || Array.isArray(properties))) {
      errors.push(`${at}.properties must be an object`)
    } else {
      for (const [key, child] of Object.entries((properties ?? {}) as Record<string, unknown>)) {
        if (!key || key === '__proto__' || key === 'constructor') errors.push(`${at}.properties contains unsafe key '${key}'`)
        errors.push(...validateShapeSpec(child, `${at}.properties.${key}`, depth + 1))
      }
    }
    if (shape.required !== undefined && (!Array.isArray(shape.required) || shape.required.some(key => typeof key !== 'string' || !key))) {
      errors.push(`${at}.required must be an array of non-empty strings`)
    } else if (Array.isArray(shape.required)) {
      const required = shape.required as string[]
      if (new Set(required).size !== required.length) errors.push(`${at}.required must not contain duplicates`)
      for (const key of required) if (!properties || typeof properties !== 'object' || !(key in properties)) errors.push(`${at}.required '${key}' is missing from properties`)
    }
    if (shape.additionalProperties !== undefined && typeof shape.additionalProperties !== 'boolean') errors.push(`${at}.additionalProperties must be boolean`)
  } else if (type === 'array') {
    if (shape.minItems !== undefined && (!Number.isInteger(shape.minItems) || (shape.minItems as number) < 0)) errors.push(`${at}.minItems must be a non-negative integer`)
    if (shape.items !== undefined) errors.push(...validateShapeSpec(shape.items, `${at}.items`, depth + 1))
  } else if (type === 'string') {
    if (shape.minLength !== undefined && (!Number.isInteger(shape.minLength) || (shape.minLength as number) < 0)) errors.push(`${at}.minLength must be a non-negative integer`)
    if (shape.enum !== undefined && (!Array.isArray(shape.enum) || shape.enum.length === 0 || shape.enum.some(item => typeof item !== 'string'))) {
      errors.push(`${at}.enum must be a non-empty array of strings`)
    } else if (Array.isArray(shape.enum) && new Set(shape.enum).size !== shape.enum.length) errors.push(`${at}.enum must not contain duplicates`)
  } else if (type === 'number' || type === 'integer') {
    for (const key of ['minimum', 'maximum'] as const) {
      if (shape[key] !== undefined && (typeof shape[key] !== 'number' || !Number.isFinite(shape[key]))) errors.push(`${at}.${key} must be a finite number`)
    }
    if (typeof shape.minimum === 'number' && typeof shape.maximum === 'number' && shape.minimum > shape.maximum) errors.push(`${at}.minimum must be <= maximum`)
  }
  return errors
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function manifestsToRefs(manifests: Array<{ id: string; version: string; integrity: string }>): FrozenCapabilityRef[] {
  return manifests.map(({ id, version, integrity }) => ({ id, version, integrity }))
}

function collectBindingCalls(bindings: Record<string, ValueExpression> | undefined, output: Set<string>): void {
  for (const expression of Object.values(bindings ?? {})) collectValueCalls(expression, output)
}

function collectValueCalls(expression: ValueExpression, output: Set<string>): void {
  if ('call' in expression) {
    output.add(expression.call)
    for (const arg of expression.args ?? []) collectValueCalls(arg, output)
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function groupBy<T, K>(values: readonly T[], key: (value: T) => K): Map<K, T[]> {
  const output = new Map<K, T[]>()
  for (const value of values) output.set(key(value), [...(output.get(key(value)) ?? []), value])
  return output
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
