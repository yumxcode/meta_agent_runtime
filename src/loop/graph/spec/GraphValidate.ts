import { createHash } from 'node:crypto'
import { compileCondition } from '../runtime/GraphExpression.js'
import { isJsonValue, validateShape } from '../runtime/GraphJson.js'
import type { CapabilityRegistry, EffectProvider, FunctionProvider, ReducerProvider } from '../registry/CapabilityRegistry.js'
import type { CapabilityPackRegistry } from '../registry/CapabilityPack.js'
import type {
  FrozenCapabilityRef,
  FrozenLoopGraphSpec,
  LoopGraphSpec,
  NodeSpec,
  ShapeSpec,
  TransitionSpec,
  ValueExpression,
  WorkspaceWriteRule,
} from './GraphTypes.js'
import { validateGraphAbiShape } from './GraphAbiValidate.js'

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
const ROOT_RE = /^\$(state|input|output|clock)(\.|$)/

export interface GraphCapabilityRegistries {
  functions: CapabilityRegistry<FunctionProvider>
  reducers: CapabilityRegistry<ReducerProvider>
  effects?: CapabilityRegistry<EffectProvider>
  packs?: CapabilityPackRegistry
  agentTools?: ReadonlySet<string>
}

export function validateLoopGraph(spec: LoopGraphSpec, registries: GraphCapabilityRegistries): string[] {
  const errors: string[] = []
  if (!spec || typeof spec !== 'object') return ['graph must be an object']
  const abi = validateGraphAbiShape(spec)
  errors.push(...abi)
  if (abi.length) return errors
  if (spec.schemaVersion !== 'graph-2.0') errors.push("schemaVersion must be 'graph-2.0'")
  validateId(spec.id, 'id', errors)
  if (!Number.isInteger(spec.version) || spec.version < 1) errors.push('version must be a positive integer')
  if (typeof spec.goal !== 'string' || !spec.goal.trim()) errors.push('goal must be non-empty')
  if (!Number.isInteger(spec.limits?.maxActivations) || spec.limits.maxActivations < 1) errors.push('limits.maxActivations must be a positive integer')
  positive(spec.limits?.maxWallTimeMs, 'limits.maxWallTimeMs', errors)
  positive(spec.limits?.maxCostUsd, 'limits.maxCostUsd', errors)
  positiveInteger(spec.limits?.maxFanOut, 'limits.maxFanOut', errors)
  positiveInteger(spec.limits?.maxPendingTimers, 'limits.maxPendingTimers', errors)
  positiveInteger(spec.concurrency?.maxActivations, 'concurrency.maxActivations', errors)
  positiveInteger(spec.concurrency?.maxPerNode, 'concurrency.maxPerNode', errors)
  if (spec.concurrency?.stateConsistency !== undefined && !['commit_latest', 'serializable'].includes(spec.concurrency.stateConsistency)) {
    errors.push('concurrency.stateConsistency must be commit_latest or serializable')
  }
  for (const [index, pack] of (spec.capabilityPacks ?? []).entries()) {
    if (!registries.packs?.has(pack)) errors.push(`capabilityPacks[${index}] '${pack.id}@${pack.version}' is not loaded with matching integrity`)
  }

  for (const [name, variable] of Object.entries(spec.state ?? {})) {
    validateId(name, `state.${name}`, errors)
    const shapeErrors = validateShapeSpec(variable.type, `state.${name}.type`)
    errors.push(...shapeErrors)
    if (!isJsonValue(variable.initial)) errors.push(`state.${name}.initial must be JSON`)
    else if (!shapeErrors.length) errors.push(...validateShape(variable.initial, variable.type, `state.${name}.initial`))
  }

  let scmLane: string | undefined
  for (const [laneId, lane] of Object.entries(spec.lanes ?? {})) {
    validateId(laneId, `lanes.${laneId}`, errors)
    if (!['persistent', 'fresh_per_activation'].includes(lane.context)) errors.push(`lanes.${laneId}.context is invalid`)
    if (lane.maxConcurrency !== undefined && lane.maxConcurrency !== 1) errors.push(`lanes.${laneId}.maxConcurrency must be 1`)
    if (!plain(lane.workspace)) errors.push(`lanes.${laneId}.workspace must be an object`)
    else validateWorkspace(laneId, lane.workspace, errors)
    if (lane.agentProfile) instruction(lane.agentProfile.systemInstructions, `lanes.${laneId}.agentProfile.systemInstructions`, errors)
    if (lane.scm !== undefined) {
      if (lane.scm !== 'git') errors.push(`lanes.${laneId}.scm must be 'git' when present`)
      else if (scmLane !== undefined) errors.push(`lanes.${laneId}.scm conflicts with lane '${scmLane}'; the git index is single-writer — exactly one Lane may declare scm`)
      else scmLane = laneId
      if (lane.scm === 'git' && !(lane.workspace?.write?.length)) {
        errors.push(`lanes.${laneId}.scm requires at least one workspace write rule; a read-only Lane runs in shared_readonly mode where git cannot commit`)
      }
      if (lane.scm === 'git' && (lane.workspace?.deny ?? []).some(denied => denied === '.git' || denied.startsWith('.git/'))) {
        errors.push(`lanes.${laneId}.deny must not cover .git when scm 'git' is declared; remove the deny entry (hooks/config stay Kernel-protected regardless)`)
      }
    }
  }
  validateWorkspaceOwnership(spec, errors)

  const nodeIds = new Set(Object.keys(spec.nodes ?? {}))
  const transitionIds = new Set<string>()
  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) validateNode(nodeId, node, spec, registries, errors)
  for (const [index, transition] of (spec.transitions ?? []).entries()) {
    const at = `transitions[${index}]`
    validateId(transition.id, `${at}.id`, errors)
    if (transitionIds.has(transition.id)) errors.push(`${at}.id '${transition.id}' is duplicated`)
    transitionIds.add(transition.id)
    if (!nodeIds.has(transition.from)) errors.push(`${at}.from references unknown node '${transition.from}'`)
    for (const target of transitionTargets(transition)) {
      if (!target || typeof target.node !== 'string' || !nodeIds.has(target.node)) errors.push(`${at}.to references unknown node '${String(target?.node)}'`)
      validateBindings(target?.inputs, `${at}.to.inputs`, registries, errors)
      for (const [name, expression] of Object.entries(target?.inputs ?? {})) {
        validateStrictOutputBinding(expression, spec.nodes?.[transition.from], transition.on ?? 'success', `${at}.to.inputs.${name}`, errors)
      }
    }
    if (transition.default && transition.when) errors.push(`${at} cannot set both default and when`)
    if (transition.default && transition.priority !== undefined) errors.push(`${at}.default must not set priority`)
    if (transition.when !== undefined) {
      if (typeof transition.when !== 'string') errors.push(`${at}.when must be a string`)
      else try {
        for (const ref of compileCondition(transition.when).refs) validateConditionRef(ref, spec, transition.from, `${at}.when`, errors)
      } catch (error) { errors.push(`${at}.when: ${message(error)}`) }
    }
    for (const [updateIndex, update] of (transition.updates ?? []).entries()) {
      const updateAt = `${at}.updates[${updateIndex}]`
      if (!(update.target in (spec.state ?? {}))) errors.push(`${updateAt} targets unknown state '${update.target}'`)
      if (!registries.reducers.has(update.reducer)) errors.push(`${updateAt} references unknown reducer '${update.reducer}'`)
      for (const [argIndex, arg] of (update.args ?? []).entries()) {
        const argAt = `${updateAt}.args[${argIndex}]`
        validateValue(arg, argAt, registries, errors)
        validateStrictOutputBinding(arg, spec.nodes?.[transition.from], transition.on ?? 'success', argAt, errors)
      }
    }
  }

  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    const outgoing = (spec.transitions ?? []).filter(item => item.from === nodeId)
    if (node.type === 'terminal' && node.status !== 'paused' && outgoing.length) errors.push(`terminal node '${nodeId}' cannot have outgoing transitions`)
    if (node.type === 'terminal' && node.status === 'paused' && outgoing.some(item => item.on !== 'resume')) errors.push(`paused terminal node '${nodeId}' may only have resume transitions`)
    if (node.type !== 'terminal' && !outgoing.length) errors.push(`non-terminal node '${nodeId}' needs an outgoing transition`)
    const groups = groupBy(outgoing, item => item.on ?? 'success')
    for (const [outcome, routes] of groups) {
      const defaults = routes.filter(item => item.default || !item.when)
      if (defaults.length > 1) errors.push(`node '${nodeId}' outcome '${outcome}' has multiple default/unconditional transitions`)
      if (routes.some(item => item.when) && defaults.length !== 1) errors.push(`node '${nodeId}' outcome '${outcome}' needs exactly one default transition`)
      const priorities = new Set<number>()
      for (const route of routes.filter(item => item.when)) {
        const priority = route.priority ?? 0
        if (priorities.has(priority)) errors.push(`node '${nodeId}' outcome '${outcome}' has duplicate priority ${priority}`)
        priorities.add(priority)
      }
    }
    const always = outgoing.some(item => item.on === 'always')
    for (const outcome of requiredOutcomes(node)) if (!always && !outgoing.some(item => (item.on ?? 'success') === outcome)) {
      errors.push(`node '${nodeId}' must route outcome '${outcome}' or provide an 'always' transition`)
    }
  }

  if (!Array.isArray(spec.entrypoints) || !spec.entrypoints.length) errors.push('entrypoints must contain at least one entrypoint')
  const entryIds = new Set<string>()
  for (const [index, entry] of (spec.entrypoints ?? []).entries()) {
    validateId(entry.id, `entrypoints[${index}].id`, errors)
    if (entryIds.has(entry.id)) errors.push(`entrypoints[${index}].id '${entry.id}' is duplicated`)
    entryIds.add(entry.id)
    if (!nodeIds.has(entry.node)) errors.push(`entrypoints[${index}].node references unknown node '${entry.node}'`)
    validateBindings(entry.inputs, `entrypoints[${index}].inputs`, registries, errors)
    // Entrypoint bindings are evaluated at instance creation with only $state
    // in scope; $input/$output/$clock do not exist yet.
    const entryRoots = new Set<string>()
    for (const expression of Object.values(entry.inputs ?? {})) collectRefRoots(expression, entryRoots)
    for (const root of entryRoots) if (root !== 'state') {
      errors.push(`entrypoints[${index}].inputs may only reference $state or literals; '$${root}' is unavailable at instance creation`)
    }
  }
  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) if (node.type === 'join') {
    const incoming = new Set((spec.transitions ?? [])
      .filter(transition => transitionTargets(transition).some(target => target?.node === nodeId))
      .map(transition => transition.id))
    const expected = new Set<string>()
    for (const id of node.expects ?? []) {
      if (expected.has(id)) errors.push(`nodes.${nodeId}.expects duplicates transition '${id}'`)
      expected.add(id)
      if (!transitionIds.has(id)) errors.push(`nodes.${nodeId}.expects references unknown transition '${id}'`)
      else if (!incoming.has(id)) errors.push(`nodes.${nodeId}.expects transition '${id}' does not target this Join`)
    }
    for (const id of incoming) if (!expected.has(id)) errors.push(`nodes.${nodeId}.expects must include incoming transition '${id}'`)
  }
  if ((spec.entrypoints?.length ?? 0) > spec.limits.maxActivations) errors.push('entrypoints exceed limits.maxActivations')
  validateReachability(spec, errors)
  validateTerminalReachability(spec, errors)
  validateInputSupply(spec, errors)
  return errors
}

/**
 * $input references in node-attached expressions are STRICT at runtime: a
 * missing key throws before the node executes, so the activation fails on the
 * spot. Unlike `when` conditions (missing reference = edge does not match),
 * there is no lenient fallback. This invariant is fully static: every
 * $input.<key> a node reads must be bound by EVERY incoming transition target
 * and every entrypoint that spawns the node. Optional values must be bound
 * explicitly (e.g. { "literal": null }) on the edges that do not supply them.
 * Keys starting with "__" are runtime-injected (e.g. __resume) and skipped.
 */
function validateInputSupply(spec: LoopGraphSpec, errors: string[]): void {
  const suppliers = new Map<string, Array<{ label: string; keys: Set<string> }>>()
  const supply = (node: string, label: string, inputs?: Record<string, ValueExpression>): void => {
    const list = suppliers.get(node) ?? []
    list.push({ label, keys: new Set(Object.keys(inputs ?? {})) })
    suppliers.set(node, list)
  }
  for (const entry of spec.entrypoints ?? []) if (typeof entry?.node === 'string') supply(entry.node, `entrypoint '${entry.id}'`, entry.inputs)
  for (const transition of spec.transitions ?? []) for (const target of transitionTargets(transition)) {
    if (typeof target?.node === 'string') supply(target.node, `transition '${transition.id}'`, target.inputs)
  }
  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    if (!node || typeof node !== 'object') continue
    const required = new Set<string>()
    if ('inputs' in node) for (const expression of Object.values(node.inputs ?? {})) collectInputKeyRefs(expression, required)
    if (node.type === 'effect' && node.idempotencyKey) collectInputKeyRefs(node.idempotencyKey, required)
    if (node.type === 'wait' && node.wait) collectInputKeyRefs(node.wait.kind === 'timer' ? node.wait.delayMs : node.wait.correlation, required)
    if (node.type === 'terminal' && node.result) collectInputKeyRefs(node.result, required)
    if (!required.size) continue
    for (const supplier of suppliers.get(nodeId) ?? []) {
      for (const key of required) if (!supplier.keys.has(key)) {
        errors.push(`node '${nodeId}' reads $input.${key} but ${supplier.label} does not bind it; $input references are strict — bind { "literal": null } on paths where the value is absent`)
      }
    }
  }
}

function collectInputKeyRefs(expression: ValueExpression | undefined, output: Set<string>, depth = 0): void {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression) || depth > 20) return
  if ('ref' in expression && typeof expression.ref === 'string') {
    const match = /^\$input\.([^.]+)/.exec(expression.ref)
    if (match && !match[1]!.startsWith('__')) output.add(match[1]!)
  }
  if ('call' in expression) for (const argument of (Array.isArray(expression.args) ? expression.args : [])) collectInputKeyRefs(argument, output, depth + 1)
}

function collectRefRoots(expression: ValueExpression | undefined, output: Set<string>, depth = 0): void {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression) || depth > 20) return
  if ('ref' in expression && typeof expression.ref === 'string') {
    const match = /^\$([a-z]+)/.exec(expression.ref)
    if (match) output.add(match[1]!)
  }
  if ('call' in expression) for (const argument of (Array.isArray(expression.args) ? expression.args : [])) collectRefRoots(argument, output, depth + 1)
}

export function freezeLoopGraph(spec: LoopGraphSpec, registries: GraphCapabilityRegistries, now = Date.now()): FrozenLoopGraphSpec {
  for (const field of ['capabilityLock', 'graphHash', 'frozenAt']) if (field in spec) throw new Error(`invalid LoopGraphSpec:\n- ${field} is Freeze-owned`)
  const errors = validateLoopGraph(spec, registries)
  if (errors.length) throw new Error(`invalid LoopGraphSpec:\n- ${errors.join('\n- ')}`)
  const functions = new Set<string>()
  const reducers = new Set<string>()
  const effects = new Set<string>()
  const agentTools = new Set<string>()
  for (const node of Object.values(spec.nodes)) {
    if (node.type === 'function') functions.add(node.function)
    if (node.type === 'effect') effects.add(node.effect)
    if (node.type === 'agent') for (const tool of node.tools ?? ['read_file', 'edit_file', 'write_file', 'append_file', 'grep', 'glob', 'bash']) agentTools.add(tool)
    if ('inputs' in node) collectBindings(node.inputs, functions)
    if (node.type === 'effect' && node.idempotencyKey) collectValue(node.idempotencyKey, functions)
    if (node.type === 'wait') collectValue(node.wait.kind === 'timer' ? node.wait.delayMs : node.wait.correlation, functions)
    if (node.type === 'terminal') collectValue(node.result, functions)
  }
  for (const entry of spec.entrypoints) collectBindings(entry.inputs, functions)
  for (const transition of spec.transitions) {
    for (const target of transitionTargets(transition)) collectBindings(target?.inputs, functions)
    for (const update of transition.updates ?? []) {
      reducers.add(update.reducer)
      for (const arg of update.args ?? []) collectValue(arg, functions)
    }
  }
  const capabilityLock = {
    functions: refs(registries.functions.refs(functions)),
    reducers: refs(registries.reducers.refs(reducers)),
    effects: registries.effects ? refs(registries.effects.refs(effects)) : [],
    packs: [...(spec.capabilityPacks ?? [])].map(pack => registries.packs!.require(pack)).sort(compareRef),
    agentTools: [...agentTools].sort(),
  }
  const body = JSON.parse(JSON.stringify({ ...spec, capabilityLock })) as LoopGraphSpec & { capabilityLock: typeof capabilityLock }
  return { ...body, graphHash: createHash('sha256').update(stable(body)).digest('hex'), frozenAt: now }
}

export function verifyFrozenGraphIntegrity(graph: FrozenLoopGraphSpec): void {
  const { graphHash, frozenAt: _frozenAt, ...body } = graph
  const actual = createHash('sha256').update(stable(body)).digest('hex')
  if (actual !== graphHash) throw new Error(`Frozen LoopGraphSpec integrity mismatch: expected '${graphHash}', computed '${actual}'`)
}

export function transitionTargets(transition: TransitionSpec): Array<{ node: string; inputs?: Record<string, ValueExpression> }> {
  const raw = Array.isArray(transition.to) ? transition.to : [transition.to]
  return raw.map(target => typeof target === 'string' ? { node: target } : target)
}

function validateNode(nodeId: string, node: NodeSpec, spec: LoopGraphSpec, registries: GraphCapabilityRegistries, errors: string[]): void {
  const at = `nodes.${nodeId}`
  validateId(nodeId, at, errors)
  positive(node.timeoutMs, `${at}.timeoutMs`, errors)
  if ((node.type === 'agent' || node.type === 'function') && node.outputSchema) errors.push(...validateShapeSpec(node.outputSchema, `${at}.outputSchema`))
  switch (node.type) {
    case 'agent':
      if (!spec.lanes[node.lane]) errors.push(`${at}.lane references unknown lane '${node.lane}'`)
      if (typeof node.prompt !== 'string' || !node.prompt.trim()) errors.push(`${at}.prompt must be non-empty`)
      if (node.systemInstructions !== undefined) instruction(node.systemInstructions, `${at}.systemInstructions`, errors)
      for (const [index, tool] of (node.tools ?? []).entries()) {
        if (typeof tool !== 'string' || !tool.trim()) errors.push(`${at}.tools[${index}] must be non-empty`)
        else if (registries.agentTools && !registries.agentTools.has(tool)) errors.push(`${at}.tools[${index}] references unavailable Agent tool '${tool}'`)
      }
      for (const [index, skill] of (node.skills ?? []).entries()) if (typeof skill !== 'string' || !skill.trim()) errors.push(`${at}.skills[${index}] must be non-empty`)
      positiveInteger(node.maxAttempts, `${at}.maxAttempts`, errors)
      positiveInteger(node.budget?.turns, `${at}.budget.turns`, errors)
      positive(node.budget?.usd, `${at}.budget.usd`, errors)
      positive(node.budget?.wallTimeMs, `${at}.budget.wallTimeMs`, errors)
      positiveInteger(node.lifetimeBudget?.turns, `${at}.lifetimeBudget.turns`, errors)
      positive(node.lifetimeBudget?.usd, `${at}.lifetimeBudget.usd`, errors)
      positive(node.lifetimeBudget?.elapsedMs, `${at}.lifetimeBudget.elapsedMs`, errors)
      positive(node.timerPolicy?.maxDelayMs, `${at}.timerPolicy.maxDelayMs`, errors)
      positiveInteger(node.timerPolicy?.maxParks, `${at}.timerPolicy.maxParks`, errors)
      if (node.timerPolicy?.allowHardPark) {
        if (spec.lanes[node.lane]?.context !== 'persistent') errors.push(`${at}.timerPolicy.allowHardPark requires a persistent Lane`)
        // Segment execution already has conservative runtime defaults. Only
        // the two durable-wait bounds are required; authored budget overrides
        // remain optional so Distill need not manufacture eight numbers.
        for (const [value, name] of [[node.timerPolicy.maxDelayMs, 'timerPolicy.maxDelayMs'], [node.timerPolicy.maxParks, 'timerPolicy.maxParks']] as const) {
          if (value === undefined) errors.push(`${at}.${name} is required when hard park is enabled`)
        }
      }
      validateBindings(node.inputs, `${at}.inputs`, registries, errors)
      break
    case 'function':
      if (!registries.functions.has(node.function)) errors.push(`${at}.function references unknown function '${node.function}'`)
      validateBindings(node.inputs, `${at}.inputs`, registries, errors)
      break
    case 'effect':
      if (!registries.effects?.has(node.effect)) errors.push(`${at}.effect references unknown effect '${node.effect}'`)
      if (node.timeoutMs === undefined) errors.push(`${at}.timeoutMs is required`)
      validateBindings(node.inputs, `${at}.inputs`, registries, errors)
      if (node.idempotencyKey) validateValue(node.idempotencyKey, `${at}.idempotencyKey`, registries, errors)
      break
    case 'wait':
      if (!node.wait || !['timer', 'event'].includes(node.wait.kind)) { errors.push(`${at}.wait.kind is invalid`); break }
      if (node.wait.kind === 'timer') validateValue(node.wait.delayMs, `${at}.wait.delayMs`, registries, errors)
      else {
        if (typeof node.wait.event !== 'string' || !node.wait.event.trim()) errors.push(`${at}.wait.event must be non-empty`)
        else if (node.wait.event.length > 256) errors.push(`${at}.wait.event exceeds 256 characters`)
        positive(node.wait.timeoutMs, `${at}.wait.timeoutMs`, errors)
        if (node.wait.correlation) validateValue(node.wait.correlation, `${at}.wait.correlation`, registries, errors)
      }
      if (node.wait.kind === 'timer') positive(node.wait.maxDelayMs, `${at}.wait.maxDelayMs`, errors)
      break
    case 'join':
      if (!['all', 'any'].includes(node.mode)) errors.push(`${at}.mode is invalid`)
      if (!Array.isArray(node.expects) || !node.expects.length) errors.push(`${at}.expects must be non-empty`)
      break
    case 'terminal':
      if (!['done', 'failed', 'paused'].includes(node.status)) errors.push(`${at}.status is invalid`)
      if (node.result) validateValue(node.result, `${at}.result`, registries, errors)
      break
    default: errors.push(`${at}.type '${String((node as NodeSpec).type)}' is unsupported`)
  }
}

function validateWorkspace(laneId: string, workspace: LoopGraphSpec['lanes'][string]['workspace'], errors: string[]): void {
  for (const [kind, paths] of [['read', workspace.read], ['deny', workspace.deny]] as const) {
    if (paths !== undefined && !Array.isArray(paths)) { errors.push(`lanes.${laneId}.workspace.${kind} must be an array`); continue }
    for (const [index, path] of (paths ?? []).entries()) {
      const valid = kind === 'deny' ? safeRelativePath(path) : path === '**' || safePath(path)
      if (!valid) errors.push(`lanes.${laneId}.workspace.${kind}[${index}] must be a safe relative path`)
    }
  }
  if (workspace.write !== undefined && !Array.isArray(workspace.write)) errors.push(`lanes.${laneId}.workspace.write must be an array`)
  for (const [index, rule] of (workspace.write ?? []).entries()) {
    const at = `lanes.${laneId}.workspace.write[${index}]`
    if (!plain(rule)) { errors.push(`${at} must be an object`); continue }
    if (!safePath(rule.path)) errors.push(`${at}.path must be a safe relative path`)
    if (!['owned', 'atomic_replace', 'append_only'].includes(rule.mode)) errors.push(`${at}.mode is invalid`)
    if (rule.schema) errors.push(...validateShapeSpec(rule.schema, `${at}.schema`))
    if (workspace.deny?.some(denied => overlap(rule.path, denied))) errors.push(`${at}.path overlaps deny '${workspace.deny.find(denied => overlap(rule.path, denied))}'`)
  }
}

function validateWorkspaceOwnership(spec: LoopGraphSpec, errors: string[]): void {
  const owners: Array<{ lane: string; rule: WorkspaceWriteRule }> = []
  for (const [lane, value] of Object.entries(spec.lanes ?? {})) for (const rule of value.workspace?.write ?? []) {
    for (const existing of owners) if (existing.lane !== lane && overlap(rule.path, existing.rule.path)) {
      errors.push(`Lane '${lane}' write '${rule.path}' conflicts with Lane '${existing.lane}' write '${existing.rule.path}'; one path needs one owning Lane`)
    }
    owners.push({ lane, rule })
  }
}

function requiredOutcomes(node: NodeSpec): string[] {
  if (node.type === 'terminal') return node.status === 'paused' ? ['resume'] : []
  if (node.type === 'wait') return node.wait.kind === 'timer' ? ['timer', 'failure'] : ['event', ...(node.wait.timeoutMs !== undefined ? ['timeout'] : []), 'failure']
  if (node.type === 'join') return ['success', ...(node.timeoutMs !== undefined ? ['timeout'] : [])]
  return ['success', 'failure']
}

function validateReachability(spec: LoopGraphSpec, errors: string[]): void {
  const reached = new Set((spec.entrypoints ?? []).map(item => item.node))
  let changed = true
  while (changed) {
    changed = false
    for (const transition of spec.transitions ?? []) if (reached.has(transition.from)) for (const target of transitionTargets(transition)) {
      if (target?.node && !reached.has(target.node)) { reached.add(target.node); changed = true }
    }
  }
  for (const nodeId of Object.keys(spec.nodes ?? {})) if (!reached.has(nodeId)) errors.push(`node '${nodeId}' is unreachable`)
}

function validateTerminalReachability(spec: LoopGraphSpec, errors: string[]): void {
  const reverse = new Map<string, Set<string>>()
  for (const transition of spec.transitions ?? []) for (const target of transitionTargets(transition)) {
    if (!target?.node) continue
    const incoming = reverse.get(target.node) ?? new Set<string>()
    incoming.add(transition.from); reverse.set(target.node, incoming)
  }
  const closed = new Set(Object.entries(spec.nodes ?? {}).filter(([, node]) => node.type === 'terminal' && node.status !== 'paused').map(([id]) => id))
  const queue = [...closed]
  while (queue.length) for (const parent of reverse.get(queue.shift()!) ?? []) if (!closed.has(parent)) { closed.add(parent); queue.push(parent) }
  for (const nodeId of Object.keys(spec.nodes ?? {})) if (!closed.has(nodeId)) errors.push(`node '${nodeId}' is in a closed path that cannot reach a done/failed terminal`)
}

function validateBindings(value: Record<string, ValueExpression> | undefined, at: string, registries: GraphCapabilityRegistries, errors: string[]): void {
  if (value !== undefined && !plain(value)) { errors.push(`${at} must be an object`); return }
  for (const [name, expression] of Object.entries(value ?? {})) validateValue(expression, `${at}.${name}`, registries, errors)
}

function validateValue(value: ValueExpression | undefined, at: string, registries: GraphCapabilityRegistries, errors: string[], depth = 0): void {
  if (depth > 20) { errors.push(`${at} nesting exceeds 20`); return }
  if (!plain(value)) { errors.push(`${at} must be a value expression`); return }
  const forms = ['literal', 'ref', 'call'].filter(key => key in value)
  if (forms.length !== 1) { errors.push(`${at} must contain exactly one of literal, ref, or call`); return }
  if ('literal' in value && !isJsonValue(value.literal)) errors.push(`${at}.literal must be JSON`)
  if ('ref' in value && (typeof value.ref !== 'string' || !ROOT_RE.test(value.ref))) errors.push(`${at}.ref has an unsupported root`)
  if ('call' in value) {
    if (typeof value.call !== 'string' || !registries.functions.has(value.call)) errors.push(`${at}.call references unknown function '${String(value.call)}'`)
    if (value.args !== undefined && !Array.isArray(value.args)) errors.push(`${at}.args must be an array`)
    for (const [index, arg] of (Array.isArray(value.args) ? value.args : []).entries()) validateValue(arg, `${at}.args[${index}]`, registries, errors, depth + 1)
  }
}

/** Conditions deliberately treat a missing optional field as a non-match, but
 * transition bindings are strict: resolveReference throws when a path is
 * absent. Require every nested $output binding to be guaranteed by the source
 * success schema so an ABI-valid graph cannot fail between routing and target
 * activation. Failure/always payloads have no declared structured schema; only
 * the whole $output value is safe there. */
function validateStrictOutputBinding(
  value: ValueExpression | undefined,
  source: NodeSpec | undefined,
  outcome: string,
  at: string,
  errors: string[],
  depth = 0,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 20) return
  if ('ref' in value && typeof value.ref === 'string' && value.ref.startsWith('$output.')) {
    if (outcome !== 'success') {
      errors.push(`${at}.ref '${value.ref}' is not guaranteed for '${outcome}' output; bind the whole $output or a literal`)
    } else {
      const shape = source && (source.type === 'agent' || source.type === 'function') ? source.outputSchema : undefined
      const path = value.ref.slice('$output.'.length).split('.')
      if (!shape || !shapeRequiresPath(shape, path)) {
        errors.push(`${at}.ref '${value.ref}' is strict but the source outputSchema does not require that path`)
      }
    }
  }
  if ('call' in value) for (const [index, argument] of (Array.isArray(value.args) ? value.args : []).entries()) {
    validateStrictOutputBinding(argument, source, outcome, `${at}.args[${index}]`, errors, depth + 1)
  }
}

function validateConditionRef(ref: string, spec: LoopGraphSpec, sourceNodeId: string, at: string, errors: string[]): void {
  const root = ref.split('.')[0]
  if (!['state', 'input', 'output', 'clock'].includes(root!)) errors.push(`${at} uses unsupported root '${root}'`)
  if (root === 'state') {
    const name = ref.split('.')[1]
    if (!name || !(name in (spec.state ?? {}))) errors.push(`${at} references undeclared state '$${ref}'`)
  }
  if (root === 'output') {
    const node = spec.nodes?.[sourceNodeId]
    const shape = node && (node.type === 'agent' || node.type === 'function') ? node.outputSchema : undefined
    const path = ref.split('.').slice(1)
    if (shape?.type === 'object' && shape.additionalProperties === false && path.length && !shapeContainsPath(shape, path)) {
      errors.push(`${at} references undeclared closed output '$${ref}'`)
    }
  }
}

function shapeContainsPath(shape: ShapeSpec, path: string[]): boolean {
  if (!path.length) return true
  if (shape.type !== 'object') return false
  const child = shape.properties?.[path[0]!]
  return child !== undefined && shapeContainsPath(child, path.slice(1))
}

function shapeRequiresPath(shape: ShapeSpec, path: string[]): boolean {
  if (!path.length) return true
  if (shape.type !== 'object') return false
  const name = path[0]!
  const child = shape.properties?.[name]
  return child !== undefined && (shape.required ?? []).includes(name) && shapeRequiresPath(child, path.slice(1))
}

function validateShapeSpec(value: unknown, at: string, depth = 0): string[] {
  if (depth > 20) return [`${at} nesting exceeds 20`]
  if (!plain(value)) return [`${at} must be a ShapeSpec object`]
  const type = value.type
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(type))) return [`${at}.type is invalid`]
  const errors: string[] = []
  const allowed: Record<string, string[]> = {
    object: ['type', 'required', 'properties', 'additionalProperties'],
    array: ['type', 'minItems', 'items'],
    string: ['type', 'minLength', 'enum'],
    number: ['type', 'minimum', 'maximum'],
    integer: ['type', 'minimum', 'maximum'],
    boolean: ['type'], null: ['type'],
  }
  for (const key of Object.keys(value)) if (!allowed[String(type)]!.includes(key)) errors.push(`${at}.${key} is not part of ShapeSpec type '${String(type)}'`)
  if (type === 'object') {
    if (value.properties !== undefined && !plain(value.properties)) errors.push(`${at}.properties must be an object`)
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(item => typeof item !== 'string'))) errors.push(`${at}.required must be a string array`)
    if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') errors.push(`${at}.additionalProperties must be a boolean`)
    const required = Array.isArray(value.required) ? value.required.filter(item => typeof item === 'string') : []
    if (new Set(required).size !== required.length) errors.push(`${at}.required must not contain duplicates`)
    for (const name of required) if (!plain(value.properties) || !(name in value.properties)) errors.push(`${at}.required references missing property '${name}'`)
    for (const [key, child] of Object.entries(plain(value.properties) ? value.properties : {})) errors.push(...validateShapeSpec(child, `${at}.properties.${key}`, depth + 1))
  }
  if (type === 'array') {
    nonNegativeInteger(value.minItems, `${at}.minItems`, errors)
    if (value.items !== undefined) errors.push(...validateShapeSpec(value.items, `${at}.items`, depth + 1))
  }
  if (type === 'string') {
    nonNegativeInteger(value.minLength, `${at}.minLength`, errors)
    if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.some(item => typeof item !== 'string'))) errors.push(`${at}.enum must be a string array`)
  }
  if (type === 'number' || type === 'integer') {
    finite(value.minimum, `${at}.minimum`, errors)
    finite(value.maximum, `${at}.maximum`, errors)
    if (typeof value.minimum === 'number' && typeof value.maximum === 'number' && value.minimum > value.maximum) errors.push(`${at}.minimum must be <= maximum`)
  }
  return errors
}

function collectBindings(bindings: Record<string, ValueExpression> | undefined, output: Set<string>): void { for (const value of Object.values(bindings ?? {})) collectValue(value, output) }
function collectValue(value: ValueExpression | undefined, output: Set<string>): void { if (value && 'call' in value) { output.add(value.call); for (const arg of value.args ?? []) collectValue(arg, output) } }
function refs(values: Array<{ id: string; version: string; integrity: string }>): FrozenCapabilityRef[] { return values.map(value => ({ id: value.id, version: value.version, integrity: value.integrity })).sort(compareRef) }
function compareRef(a: FrozenCapabilityRef, b: FrozenCapabilityRef): number { return `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`) }
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value) }
function validateId(value: unknown, at: string, errors: string[]): void { if (typeof value !== 'string' || !ID_RE.test(value)) errors.push(`${at} must match ${ID_RE}`) }
function positive(value: unknown, at: string, errors: string[]): void { if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) errors.push(`${at} must be positive`) }
function positiveInteger(value: unknown, at: string, errors: string[]): void { if (value !== undefined && (!Number.isInteger(value) || Number(value) <= 0)) errors.push(`${at} must be a positive integer`) }
function nonNegativeInteger(value: unknown, at: string, errors: string[]): void { if (value !== undefined && (!Number.isInteger(value) || Number(value) < 0)) errors.push(`${at} must be a non-negative integer`) }
function finite(value: unknown, at: string, errors: string[]): void { if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) errors.push(`${at} must be a finite number`) }
function instruction(value: unknown, at: string, errors: string[]): void { if (typeof value !== 'string' || !value.trim()) errors.push(`${at} must be non-empty`); else if (Buffer.byteLength(value, 'utf8') > 32768) errors.push(`${at} exceeds 32768 bytes`) }
function safeRelativePath(path: unknown): path is string { return typeof path === 'string' && Boolean(path) && !path.startsWith('/') && !path.startsWith('\\') && !path.split(/[\\/]/).some(part => !part || part === '.' || part === '..') }
function safePath(path: unknown): path is string { return safeRelativePath(path) && !['.loop', '.git', '.meta-agent'].includes(path.split(/[\\/]/)[0]!) }
function overlap(left: string, right: string): boolean { const a = left.replace(/[\\/]+$/, ''); const b = right.replace(/[\\/]+$/, ''); return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) }
function plain(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> { const map = new Map<string, T[]>(); for (const value of values) { const id = key(value); map.set(id, [...(map.get(id) ?? []), value]) } return map }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
