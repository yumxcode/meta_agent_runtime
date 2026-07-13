import {
  collectRefs,
  evaluateBool,
  parse,
  type Ast,
  type EvalContext,
  type Value,
} from '../expr/Expr.js'
import type {
  EffectBinding,
  EffectObservationType,
  EffectRuleAction,
  FrozenEffectBinding,
} from '../charter/CharterTypes.js'

const EFFECT_ID_RE = /^[a-z][a-z0-9_-]*$/i
const ADAPTER_ID_RE = /^[a-z0-9][a-z0-9._/-]*@[1-9][0-9]*$/i
const FORBIDDEN_POINTER_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

export interface EffectRuleDecision {
  action: EffectRuleAction | null
  ruleIndex?: number
  observations: Record<string, Value>
  diagnostic?: string
}

export function validateEffectBindings(bindings: unknown): string[] {
  if (bindings === undefined) return []
  if (!isRecord(bindings)) return ['effects must be an object map']
  const errs: string[] = []
  const entries = Object.entries(bindings)
  if (entries.length > 64) errs.push('effects must contain at most 64 bindings')
  for (const [id, raw] of entries) {
    const at = `effects.${id}`
    if (!EFFECT_ID_RE.test(id)) errs.push(`${at} binding ID must match [a-z][a-z0-9_-]*`)
    if (!isRecord(raw)) { errs.push(`${at} must be an object`); continue }
    const binding = raw as unknown as EffectBinding
    if (typeof binding.adapter !== 'string' || !ADAPTER_ID_RE.test(binding.adapter)) {
      errs.push(`${at}.adapter must be a versioned ID such as vendor/task@1`)
    }
    if (!isRecord(binding.observations)) {
      errs.push(`${at}.observations must be an object map`)
      continue
    }
    const observationEntries = Object.entries(binding.observations)
    if (observationEntries.length > 64) errs.push(`${at}.observations must contain at most 64 entries`)
    const declared = new Set<string>()
    const types = new Map<string, EffectObservationType>()
    for (const [name, spec] of observationEntries) {
      if (!EFFECT_ID_RE.test(name)) errs.push(`${at}.observations.${name} name is invalid`)
      declared.add(name)
      if (!isRecord(spec)) { errs.push(`${at}.observations.${name} must be an object`); continue }
      if (!validPointer(spec.pointer)) errs.push(`${at}.observations.${name}.pointer is not a safe JSON Pointer`)
      if (!['number', 'string', 'boolean'].includes(String(spec.type))) {
        errs.push(`${at}.observations.${name}.type is unsupported`)
      } else {
        types.set(name, spec.type as EffectObservationType)
      }
    }
    if (!Array.isArray(binding.rules)) {
      errs.push(`${at}.rules must be an array`)
      continue
    }
    if (binding.rules.length > 32) errs.push(`${at}.rules must contain at most 32 rules`)
    for (const [index, rule] of binding.rules.entries()) {
      const ruleAt = `${at}.rules[${index}]`
      if (!isRecord(rule)) { errs.push(`${ruleAt} must be an object`); continue }
      try {
        const ast = parse(String(rule.when ?? ''), declared)
        inferBooleanAst(ast, types, ruleAt)
      } catch (error) {
        errs.push(`${ruleAt}.when: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!['continue_waiting', 'escalate', 'fail_stop'].includes(String(rule.onAbsent))) {
        errs.push(`${ruleAt}.onAbsent is unsupported`)
      }
      if (!['escalate', 'fail_stop'].includes(String(rule.onError))) {
        errs.push(`${ruleAt}.onError is unsupported`)
      }
      errs.push(...validateAction(rule.then, `${ruleAt}.then`))
    }
    if (binding.admission !== undefined) {
      if (!isRecord(binding.admission)) {
        errs.push(`${at}.admission must be an object`)
      } else {
        const max = binding.admission.maxConcurrentCalls
        const interval = binding.admission.minIntervalMs
        if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > 1_000) {
          errs.push(`${at}.admission.maxConcurrentCalls must be an integer in 1..1000`)
        }
        if (interval !== undefined && (!Number.isInteger(interval) || (interval as number) < 0 || (interval as number) > 60_000)) {
          errs.push(`${at}.admission.minIntervalMs must be an integer in 0..60000`)
        }
      }
    }
  }
  return errs
}

export function freezeEffectBindings(
  bindings: Record<string, EffectBinding> | undefined,
): Record<string, FrozenEffectBinding> {
  return Object.fromEntries(Object.entries(bindings ?? {}).map(([id, binding]) => [id, {
    ...binding,
    observations: structuredClone(binding.observations),
    rules: structuredClone(binding.rules),
    frozen: {
      ruleAsts: binding.rules.map(rule => parse(rule.when, new Set(Object.keys(binding.observations)))),
    },
  }]))
}

export function evaluateEffectRules(
  binding: FrozenEffectBinding,
  observation: unknown,
): EffectRuleDecision {
  const decoded: Record<string, Value> = {}
  const errors = new Map<string, string>()
  const absent = new Set<string>()
  for (const [name, spec] of Object.entries(binding.observations)) {
    const resolved = resolvePointer(observation, spec.pointer)
    if (!resolved.found) { absent.add(name); continue }
    if (typeof resolved.value !== spec.type ||
        (spec.type === 'number' && !Number.isFinite(resolved.value))) {
      errors.set(name, `expected ${spec.type} at ${spec.pointer}`)
      continue
    }
    decoded[name] = resolved.value as Value
  }
  for (const [index, rule] of binding.rules.entries()) {
    const ast = binding.frozen.ruleAsts[index]!
    try {
      if (evaluateBool(ast, decoded as EvalContext)) {
        return { action: rule.then, ruleIndex: index, observations: decoded }
      }
    } catch (error) {
      const refs = collectRefs(ast)
      const bad = refs.find(ref => errors.has(ref))
      if (bad) {
        return failureDecision(rule.onError, index, decoded, `${bad}: ${errors.get(bad)}`)
      }
      const missing = refs.find(ref => absent.has(ref) || decoded[ref] === undefined)
      if (missing) {
        return failureDecision(rule.onAbsent, index, decoded, `${missing}: pointer missing`)
      }
      return failureDecision(
        rule.onError, index, decoded,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  return { action: null, observations: decoded }
}

function failureDecision(
  policy: 'continue_waiting' | 'escalate' | 'fail_stop',
  ruleIndex: number,
  observations: Record<string, Value>,
  diagnostic: string,
): EffectRuleDecision {
  if (policy === 'continue_waiting') {
    return { action: { act: 'continue_waiting' }, ruleIndex, observations, diagnostic }
  }
  if (policy === 'escalate') {
    return {
      action: { act: 'escalate', reason: `Effect observation unavailable: ${diagnostic}` },
      ruleIndex, observations, diagnostic,
    }
  }
  return { action: null, ruleIndex, observations, diagnostic: `fail_stop: ${diagnostic}` }
}

function validateAction(value: unknown, at: string): string[] {
  if (!isRecord(value) || typeof value.act !== 'string') return [`${at} must declare an action`]
  if (!['harvest', 'cancel_and_harvest', 'continue_waiting', 'escalate'].includes(value.act)) {
    return [`${at}.act is unsupported`]
  }
  if ((value.act === 'harvest' || value.act === 'cancel_and_harvest') &&
      (typeof value.verdict !== 'string' || !value.verdict.trim() || value.verdict.length > 128)) {
    return [`${at}.verdict must be a non-empty string up to 128 characters`]
  }
  if (value.act === 'escalate' &&
      (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 512)) {
    return [`${at}.reason must be a non-empty string up to 512 characters`]
  }
  return []
}

function inferBooleanAst(ast: Ast, types: ReadonlyMap<string, EffectObservationType>, at: string): void {
  const infer = (node: Ast): EffectObservationType => {
    if (node.kind === 'lit') return typeof node.value as EffectObservationType
    if (node.kind === 'ref') return types.get(node.name) ?? 'boolean'
    if (node.kind === 'unary') {
      const operand = infer(node.operand)
      const expected = node.op === '!' ? 'boolean' : 'number'
      if (operand !== expected) throw new Error(`${at}: '${node.op}' requires ${expected}, got ${operand}`)
      return expected
    }
    const left = infer(node.left)
    const right = infer(node.right)
    if (node.op === '&&' || node.op === '||') {
      if (left !== 'boolean' || right !== 'boolean') throw new Error(`${at}: '${node.op}' requires booleans`)
      return 'boolean'
    }
    if (node.op === '==' || node.op === '!=') {
      if (left !== right) throw new Error(`${at}: '${node.op}' operands must share a type`)
      return 'boolean'
    }
    if (left !== 'number' || right !== 'number') throw new Error(`${at}: '${node.op}' requires numbers`)
    return ['<', '<=', '>', '>='].includes(node.op) ? 'boolean' : 'number'
  }
  const result = infer(ast)
  if (result !== 'boolean') throw new Error(`${at}: expression must yield boolean, got ${result}`)
}

function validPointer(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 512) return false
  try {
    return pointerSegments(value).every(segment => !FORBIDDEN_POINTER_SEGMENTS.has(segment))
  } catch {
    return false
  }
}

function resolvePointer(root: unknown, pointer: string): { found: boolean; value?: unknown } {
  let value = root
  for (const segment of pointerSegments(pointer)) {
    if (!isRecord(value) && !Array.isArray(value)) return { found: false }
    if (!Object.prototype.hasOwnProperty.call(value, segment)) return { found: false }
    value = (value as Record<string, unknown>)[segment]
  }
  return { found: true, value }
}

function pointerSegments(pointer: string): string[] {
  return pointer.slice(1).split('/').map(segment => {
    if (/~(?:[^01]|$)/.test(segment)) throw new Error('invalid JSON Pointer escape')
    return segment.replace(/~1/g, '/').replace(/~0/g, '~')
  })
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
