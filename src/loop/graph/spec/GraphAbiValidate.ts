import { isJsonValue } from '../runtime/GraphJson.js'

/**
 * Strictly validate the executable Graph ABI. Domain authors retain an open
 * `annotations` bag, but misspelled executable fields must never be silently
 * frozen and ignored by the Kernel.
 */
export function validateGraphAbiShape(value: unknown): string[] {
  const errors: string[] = []
  if (!record(value)) return ['graph must be an object']
  keys(value, [
    'schemaVersion', 'id', 'version', 'goal', 'capabilityPacks', 'state', 'lanes', 'nodes',
    'transitions', 'entrypoints', 'artifacts', 'artifactViews', 'evidenceViews',
    'workspaceBindings', 'dataPlanes', 'dataViews', 'limits', 'concurrency', 'annotations',
    'capabilityLock', 'graphHash', 'frozenAt', 'compiledDataPlanes', 'compiledLaneDataAccess',
  ], 'graph', errors)
  annotation(value.annotations, 'annotations', errors)

  eachRecord(value.state, 'state', errors, (item, at) => {
    keys(item, ['type', 'initial', 'description'], at, errors)
  })
  eachRecord(value.lanes, 'lanes', errors, (lane, at) => {
    keys(lane, ['context', 'workspace', 'maxConcurrency', 'description', 'agentProfile', 'dataAccess', 'annotations'], at, errors)
    annotation(lane.annotations, `${at}.annotations`, errors)
    child(lane.agentProfile, `${at}.agentProfile`, errors, profile => keys(profile, ['systemInstructions'], `${at}.agentProfile`, errors))
    child(lane.dataAccess, `${at}.dataAccess`, errors, access => {
      keys(access, ['read', 'publish', 'write'], `${at}.dataAccess`, errors)
      eachArray(access.read, `${at}.dataAccess.read`, errors, (grant, grantAt) => keys(grant, ['plane', 'views'], grantAt, errors))
    })
  })
  eachRecord(value.nodes, 'nodes', errors, (node, at) => validateNode(node, at, errors))
  eachArray(value.transitions, 'transitions', errors, (transition, at) => {
    keys(transition, ['id', 'from', 'on', 'when', 'default', 'priority', 'updates', 'to', 'annotations'], at, errors)
    annotation(transition.annotations, `${at}.annotations`, errors)
    eachArray(transition.updates, `${at}.updates`, errors, (update, updateAt) => {
      keys(update, ['target', 'reducer', 'args'], updateAt, errors)
      eachArray(update.args, `${updateAt}.args`, errors, (arg, argAt) => expression(arg, argAt, errors))
    })
    targets(transition.to, `${at}.to`, errors)
  })
  eachArray(value.entrypoints, 'entrypoints', errors, (entry, at) => {
    keys(entry, ['id', 'node', 'inputs'], at, errors)
    expressions(entry.inputs, `${at}.inputs`, errors)
  })
  eachRecord(value.artifacts, 'artifacts', errors, (channel, at) => keys(channel, ['kind', 'schema', 'admission', 'maxItems'], at, errors))
  for (const field of ['artifactViews', 'evidenceViews'] as const) eachRecord(value[field], field, errors, (view, at) => {
    keys(view, ['channels', 'statuses', 'maxItems'], at, errors)
  })
  eachRecord(value.workspaceBindings, 'workspaceBindings', errors, (binding, at) => workspaceBinding(binding, at, errors))
  eachRecord(value.dataPlanes, 'dataPlanes', errors, (plane, at) => dataPlane(plane, at, errors))
  eachRecord(value.dataViews, 'dataViews', errors, (view, at) => {
    keys(view, ['plane', 'description', 'stateKeys', 'statuses', 'eventTypes', 'maxItems'], at, errors)
  })
  child(value.limits, 'limits', errors, limits => keys(limits, ['maxActivations', 'maxWallTimeMs', 'maxCostUsd', 'maxFanOut', 'maxPendingTimers'], 'limits', errors))
  child(value.concurrency, 'concurrency', errors, concurrency => keys(concurrency, ['maxActivations', 'maxPerNode', 'stateConsistency'], 'concurrency', errors))
  eachArray(value.capabilityPacks, 'capabilityPacks', errors, (pack, at) => keys(pack, ['id', 'version', 'integrity'], at, errors))
  return errors
}

function validateNode(node: Record<string, unknown>, at: string, errors: string[]): void {
  const base = ['type', 'description', 'timeoutMs', 'publishes', 'annotations']
  const byType: Record<string, string[]> = {
    agent: ['lane', 'prompt', 'systemInstructions', 'context', 'inputs', 'outputSchema', 'tools', 'skills', 'writes', 'maxAttempts', 'budget', 'lifetimeBudget', 'timerPolicy'],
    function: ['function', 'inputs', 'outputSchema'],
    effect: ['effect', 'inputs', 'idempotencyKey'],
    wait: ['wait'],
    join: ['mode', 'expects'],
    terminal: ['status', 'result'],
  }
  keys(node, [...base, ...(byType[String(node.type)] ?? [])], at, errors)
  annotation(node.annotations, `${at}.annotations`, errors)
  expressions(node.inputs, `${at}.inputs`, errors)
  eachArray(node.publishes, `${at}.publishes`, errors, (publication, publicationAt) => {
    keys(publication, ['plane', 'channel', 'on', 'value', 'status', 'supersedes', 'tags'], publicationAt, errors)
    expression(publication.value, `${publicationAt}.value`, errors)
    if (publication.supersedes !== undefined) expression(publication.supersedes, `${publicationAt}.supersedes`, errors)
  })
  if (node.type === 'agent') {
    child(node.context, `${at}.context`, errors, context => {
      keys(context, ['sections'], `${at}.context`, errors)
      eachArray(context.sections, `${at}.context.sections`, errors, (section, sectionAt) => {
        keys(section, ['name', 'provider', 'refresh', 'config', 'required', 'maxBytes'], sectionAt, errors)
      })
    })
    child(node.budget, `${at}.budget`, errors, budget => keys(budget, ['turns', 'usd', 'wallTimeMs'], `${at}.budget`, errors))
    child(node.lifetimeBudget, `${at}.lifetimeBudget`, errors, budget => keys(budget, ['turns', 'usd', 'elapsedMs'], `${at}.lifetimeBudget`, errors))
    child(node.timerPolicy, `${at}.timerPolicy`, errors, policy => keys(policy, ['allowHardPark', 'maxDelayMs', 'maxParks'], `${at}.timerPolicy`, errors))
  } else if (node.type === 'effect' && node.idempotencyKey !== undefined) {
    expression(node.idempotencyKey, `${at}.idempotencyKey`, errors)
  } else if (node.type === 'wait') {
    child(node.wait, `${at}.wait`, errors, wait => {
      keys(wait, wait.kind === 'timer' ? ['kind', 'delayMs', 'maxDelayMs'] : ['kind', 'event', 'correlation', 'timeoutMs'], `${at}.wait`, errors)
      if (wait.delayMs !== undefined) expression(wait.delayMs, `${at}.wait.delayMs`, errors)
      if (wait.correlation !== undefined) expression(wait.correlation, `${at}.wait.correlation`, errors)
    })
  } else if (node.type === 'terminal' && node.result !== undefined) {
    expression(node.result, `${at}.result`, errors)
  }
}

function dataPlane(plane: Record<string, unknown>, at: string, errors: string[]): void {
  const base = ['backend', 'semanticRole', 'description', 'trust', 'annotations']
  const variants: Record<string, string[]> = {
    state: ['stateKeys'],
    record: ['recordKind', 'schema', 'mutability', 'admission', 'retention'],
    journal: ['eventTypes'],
    workspace: ['binding'],
  }
  keys(plane, [...base, ...(variants[String(plane.backend)] ?? [])], at, errors)
  annotation(plane.annotations, `${at}.annotations`, errors)
  child(plane.retention, `${at}.retention`, errors, retention => keys(retention, ['maxItems'], `${at}.retention`, errors))
  child(plane.binding, `${at}.binding`, errors, binding => workspaceBinding(binding, `${at}.binding`, errors))
}

function workspaceBinding(binding: Record<string, unknown>, at: string, errors: string[]): void {
  keys(binding, ['plane', 'path', 'format', 'direction', 'lane', 'required', 'appendOnly', 'projection', 'initializeState'], at, errors)
  child(binding.projection, `${at}.projection`, errors, projection => {
    const variants: Record<string, string[]> = {
      state: ['keys'], evidence_view: ['view', 'record', 'flattenArrays'], artifact_view: ['view', 'record', 'flattenArrays'],
      journal: ['eventTypes', 'record'], data_view: ['view', 'record', 'flattenArrays'],
    }
    keys(projection, ['kind', ...(variants[String(projection.kind)] ?? [])], `${at}.projection`, errors)
  })
}

function targets(value: unknown, at: string, errors: string[]): void {
  for (const [index, target] of (Array.isArray(value) ? value : [value]).entries()) {
    if (typeof target === 'string') continue
    if (!record(target)) { errors.push(`${at}${Array.isArray(value) ? `[${index}]` : ''} must be a node id or target object`); continue }
    const targetAt = `${at}${Array.isArray(value) ? `[${index}]` : ''}`
    keys(target, ['node', 'inputs'], targetAt, errors)
    expressions(target.inputs, `${targetAt}.inputs`, errors)
  }
}

function expressions(value: unknown, at: string, errors: string[]): void {
  if (value === undefined) return
  if (!record(value)) { errors.push(`${at} must be an object`); return }
  for (const [name, item] of Object.entries(value)) expression(item, `${at}.${name}`, errors)
}

function expression(value: unknown, at: string, errors: string[]): void {
  if (!record(value)) { errors.push(`${at} must be a value expression object`); return }
  const forms = ['literal', 'ref', 'call'].filter(key => key in value)
  keys(value, forms[0] === 'call' ? ['call', 'args'] : forms.length === 1 ? [forms[0]!] : ['literal', 'ref', 'call', 'args'], at, errors)
  if (Array.isArray(value.args)) value.args.forEach((arg, index) => expression(arg, `${at}.args[${index}]`, errors))
}

function annotation(value: unknown, at: string, errors: string[]): void {
  if (value === undefined) return
  if (!record(value) || !isJsonValue(value)) errors.push(`${at} must be a JSON object`)
}

function keys(value: Record<string, unknown>, allowed: string[], at: string, errors: string[]): void {
  const set = new Set(allowed)
  for (const key of Object.keys(value)) if (!set.has(key)) errors.push(`${at}.${key} is not part of the executable Graph ABI; put non-executable domain metadata under annotations`)
}

function eachRecord(value: unknown, at: string, errors: string[], fn: (item: Record<string, unknown>, itemAt: string) => void): void {
  if (value === undefined) return
  if (!record(value)) { errors.push(`${at} must be an object`); return }
  for (const [name, item] of Object.entries(value)) {
    if (!record(item)) errors.push(`${at}.${name} must be an object`)
    else fn(item, `${at}.${name}`)
  }
}

function eachArray(value: unknown, at: string, errors: string[], fn: (item: Record<string, unknown>, itemAt: string) => void): void {
  if (value === undefined) return
  if (!Array.isArray(value)) { errors.push(`${at} must be an array`); return }
  value.forEach((item, index) => {
    if (!record(item)) errors.push(`${at}[${index}] must be an object`)
    else fn(item, `${at}[${index}]`)
  })
}

function child(value: unknown, at: string, errors: string[], fn: (item: Record<string, unknown>) => void): void {
  if (value === undefined) return
  if (!record(value)) errors.push(`${at} must be an object`)
  else fn(value)
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
