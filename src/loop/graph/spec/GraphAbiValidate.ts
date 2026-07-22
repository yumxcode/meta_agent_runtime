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
    'transitions', 'entrypoints', 'limits', 'concurrency', 'annotations',
    'capabilityLock', 'graphHash', 'frozenAt',
  ], 'graph', errors)
  required(value, {
    schemaVersion: 'string', id: 'string', version: 'number', goal: 'string',
    state: 'object', lanes: 'object', nodes: 'object', transitions: 'array',
    entrypoints: 'array', limits: 'object',
  }, 'graph', errors)
  optional(value, { capabilityPacks: 'array', concurrency: 'object', annotations: 'object' }, 'graph', errors)
  annotation(value.annotations, 'annotations', errors)

  eachRecord(value.state, 'state', errors, (item, at) => {
    keys(item, ['type', 'initial', 'description'], at, errors)
    required(item, { type: 'object', initial: 'present' }, at, errors)
  })
  eachRecord(value.lanes, 'lanes', errors, (lane, at) => {
    keys(lane, ['context', 'workspace', 'maxConcurrency', 'description', 'agentProfile', 'scm', 'annotations'], at, errors)
    required(lane, { context: 'string', workspace: 'object' }, at, errors)
    annotation(lane.annotations, `${at}.annotations`, errors)
    child(lane.agentProfile, `${at}.agentProfile`, errors, profile => keys(profile, ['systemInstructions'], `${at}.agentProfile`, errors))
    child(lane.workspace, `${at}.workspace`, errors, workspace => {
      keys(workspace, ['read', 'write', 'deny'], `${at}.workspace`, errors)
      optional(workspace, { read: 'array', write: 'array', deny: 'array' }, `${at}.workspace`, errors)
      eachArray(workspace.write, `${at}.workspace.write`, errors, (rule, ruleAt) => {
        keys(rule, ['path', 'mode', 'schema', 'description'], ruleAt, errors)
        required(rule, { path: 'string', mode: 'string' }, ruleAt, errors)
      })
    })
  })
  eachRecord(value.nodes, 'nodes', errors, (node, at) => validateNode(node, at, errors))
  eachArray(value.transitions, 'transitions', errors, (transition, at) => {
    keys(transition, ['id', 'from', 'on', 'when', 'default', 'priority', 'updates', 'to', 'annotations'], at, errors)
    required(transition, { id: 'string', from: 'string', to: 'present' }, at, errors)
    optional(transition, { updates: 'array' }, at, errors)
    annotation(transition.annotations, `${at}.annotations`, errors)
    eachArray(transition.updates, `${at}.updates`, errors, (update, updateAt) => {
      keys(update, ['target', 'reducer', 'args'], updateAt, errors)
      eachArray(update.args, `${updateAt}.args`, errors, (arg, argAt) => expression(arg, argAt, errors))
    })
    targets(transition.to, `${at}.to`, errors)
  })
  eachArray(value.entrypoints, 'entrypoints', errors, (entry, at) => {
    keys(entry, ['id', 'node', 'inputs'], at, errors)
    required(entry, { id: 'string', node: 'string' }, at, errors)
    expressions(entry.inputs, `${at}.inputs`, errors)
  })
  child(value.limits, 'limits', errors, limits => {
    keys(limits, ['maxActivations', 'maxTotalActivations', 'maxLiveActivations', 'maxWallTimeMs', 'maxCostUsd', 'maxFanOut', 'maxPendingTimers'], 'limits', errors)
  })
  child(value.concurrency, 'concurrency', errors, concurrency => keys(concurrency, ['maxActivations', 'maxPerNode', 'stateConsistency'], 'concurrency', errors))
  eachArray(value.capabilityPacks, 'capabilityPacks', errors, (pack, at) => keys(pack, ['id', 'version', 'integrity'], at, errors))
  return errors
}

function validateNode(node: Record<string, unknown>, at: string, errors: string[]): void {
  const base = ['type', 'description', 'timeoutMs', 'annotations']
  const byType: Record<string, string[]> = {
    agent: ['lane', 'prompt', 'systemInstructions', 'inputs', 'outputSchema', 'tools', 'skills', 'maxAttempts', 'budget', 'lifetimeBudget', 'timerPolicy'],
    function: ['function', 'inputs', 'outputSchema'],
    effect: ['effect', 'inputs', 'idempotencyKey'],
    wait: ['wait'],
    join: ['mode', 'expects'],
    terminal: ['status', 'result'],
  }
  keys(node, [...base, ...(byType[String(node.type)] ?? [])], at, errors)
  required(node, { type: 'string' }, at, errors)
  annotation(node.annotations, `${at}.annotations`, errors)
  expressions(node.inputs, `${at}.inputs`, errors)
  if (node.type === 'agent') {
    required(node, { lane: 'string', prompt: 'string' }, at, errors)
    optional(node, { tools: 'array', skills: 'array' }, at, errors)
    strings(node.tools, `${at}.tools`, errors)
    strings(node.skills, `${at}.skills`, errors)
    child(node.budget, `${at}.budget`, errors, budget => keys(budget, ['turns', 'usd', 'wallTimeMs'], `${at}.budget`, errors))
    child(node.lifetimeBudget, `${at}.lifetimeBudget`, errors, budget => keys(budget, ['turns', 'usd', 'elapsedMs'], `${at}.lifetimeBudget`, errors))
    child(node.timerPolicy, `${at}.timerPolicy`, errors, policy => keys(policy, ['allowHardPark', 'maxDelayMs', 'maxParks'], `${at}.timerPolicy`, errors))
  } else if (node.type === 'effect' && node.idempotencyKey !== undefined) {
    required(node, { effect: 'string' }, at, errors)
    expression(node.idempotencyKey, `${at}.idempotencyKey`, errors)
  } else if (node.type === 'effect') {
    required(node, { effect: 'string' }, at, errors)
  } else if (node.type === 'function') {
    required(node, { function: 'string' }, at, errors)
  } else if (node.type === 'wait') {
    required(node, { wait: 'object' }, at, errors)
    child(node.wait, `${at}.wait`, errors, wait => {
      required(wait, { kind: 'string' }, `${at}.wait`, errors)
      keys(wait, wait.kind === 'timer' ? ['kind', 'delayMs', 'maxDelayMs'] : ['kind', 'event', 'correlation', 'timeoutMs'], `${at}.wait`, errors)
      if (wait.delayMs !== undefined) expression(wait.delayMs, `${at}.wait.delayMs`, errors)
      if (wait.correlation !== undefined) expression(wait.correlation, `${at}.wait.correlation`, errors)
    })
  } else if (node.type === 'terminal' && node.result !== undefined) {
    required(node, { status: 'string' }, at, errors)
    expression(node.result, `${at}.result`, errors)
  } else if (node.type === 'terminal') {
    required(node, { status: 'string' }, at, errors)
  } else if (node.type === 'join') {
    required(node, { mode: 'string', expects: 'array' }, at, errors)
    strings(node.expects, `${at}.expects`, errors)
  }
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

type RuntimeKind = 'string' | 'number' | 'object' | 'array' | 'present'

function required(value: Record<string, unknown>, fields: Record<string, RuntimeKind>, at: string, errors: string[]): void {
  for (const [name, kind] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) {
      errors.push(`${at}.${name} is required`)
      continue
    }
    if (kind !== 'present' && !kindMatches(value[name], kind)) errors.push(`${at}.${name} must be ${article(kind)}${kind}`)
  }
}

function optional(value: Record<string, unknown>, fields: Record<string, RuntimeKind>, at: string, errors: string[]): void {
  for (const [name, kind] of Object.entries(fields)) {
    if (value[name] !== undefined && kind !== 'present' && !kindMatches(value[name], kind)) errors.push(`${at}.${name} must be ${article(kind)}${kind}`)
  }
}

function kindMatches(value: unknown, kind: RuntimeKind): boolean {
  if (kind === 'array') return Array.isArray(value)
  if (kind === 'object') return record(value)
  return typeof value === kind
}

function article(kind: RuntimeKind): string { return kind === 'object' || kind === 'array' ? 'an ' : 'a ' }

function strings(value: unknown, at: string, errors: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) return
  value.forEach((item, index) => { if (typeof item !== 'string') errors.push(`${at}[${index}] must be a string`) })
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
