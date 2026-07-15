import { createHash } from 'node:crypto'
import type { JsonValue } from '../spec/GraphTypes.js'
import type { ShapeSpec } from '../spec/ShapeSpec.js'
import { cloneJson, isJsonValue } from '../runtime/GraphJson.js'

export interface CapabilityManifest {
  id: string
  version: string
  integrity: string
  description?: string
  pure: boolean
  /** Optional contracts improve Freeze-time checking without restricting open LLM outputs. */
  inputSchema?: ShapeSpec
  outputSchema?: ShapeSpec
}

export interface FunctionProvider {
  manifest: CapabilityManifest
  execute(input: Readonly<Record<string, JsonValue>> | readonly JsonValue[]): JsonValue | Promise<JsonValue>
}

export interface ReducerProvider {
  manifest: CapabilityManifest
  reduce(previous: JsonValue, args: readonly JsonValue[]): JsonValue
}

export interface EffectProvider {
  manifest: CapabilityManifest
  submit(input: Readonly<Record<string, JsonValue>>, idempotencyKey: string): Promise<JsonValue>
  inspect?(receipt: JsonValue): Promise<{ status: 'pending' | 'succeeded' | 'failed'; output?: JsonValue; error?: string }>
}

export class CapabilityRegistry<T extends { manifest: CapabilityManifest }> {
  private readonly providers = new Map<string, T>()

  constructor(readonly kind: 'function' | 'reducer' | 'effect' | 'context_provider') {}

  register(provider: T): this {
    const { id, version, integrity } = provider.manifest
    if (!id || !version || !integrity) throw new Error(`${this.kind} manifest requires id, version, and integrity`)
    const key = capabilityKey(id, version)
    if (this.providers.has(key)) throw new Error(`duplicate ${this.kind} capability '${key}'`)
    this.providers.set(key, provider)
    return this
  }

  get(reference: string): T {
    const normalized = normalizeCapabilityRef(reference)
    const provider = this.providers.get(normalized)
    if (!provider) throw new Error(`unknown ${this.kind} capability '${reference}'`)
    return provider
  }

  has(reference: string): boolean {
    try { this.get(reference); return true } catch { return false }
  }

  refs(references: Iterable<string>): CapabilityManifest[] {
    return [...new Set(references)].sort().map(ref => ({ ...this.get(ref).manifest }))
  }

  manifests(): Array<T['manifest']> {
    return [...this.providers.values()].map(provider => ({ ...provider.manifest }))
      .sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`))
  }
}

export function capabilityKey(id: string, version: string): string {
  return `${id}@${version}`
}

function normalizeCapabilityRef(reference: string): string {
  const split = reference.lastIndexOf('@')
  if (split <= 0 || split === reference.length - 1) throw new Error(`capability reference '${reference}' must include @version`)
  return reference
}

function builtinManifest(id: string, version: string, description: string): CapabilityManifest {
  return {
    id,
    version,
    description,
    pure: true,
    integrity: `sha256:${createHash('sha256').update(`meta-agent:${id}@${version}:1`).digest('hex')}`,
  }
}

function expectNumber(value: JsonValue, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${at} must be a finite number`)
  return value
}

function reducer(id: string, description: string, reduce: ReducerProvider['reduce']): ReducerProvider {
  return { manifest: builtinManifest(id, '1', description), reduce }
}

export function createBuiltinReducerRegistry(): CapabilityRegistry<ReducerProvider> {
  const registry = new CapabilityRegistry<ReducerProvider>('reducer')
  registry.register(reducer('builtin/set', 'Replace the previous value.', (_previous, args) => {
    if (args.length !== 1) throw new Error('builtin/set@1 expects one argument')
    return cloneJson(args[0]!)
  }))
  registry.register(reducer('builtin/add', 'Add a number.', (previous, args) => expectNumber(previous, 'previous') + expectNumber(args[0]!, 'args[0]')))
  registry.register(reducer('builtin/subtract', 'Subtract a number.', (previous, args) => expectNumber(previous, 'previous') - expectNumber(args[0]!, 'args[0]')))
  registry.register(reducer('builtin/increment', 'Increment by one or a supplied amount.', (previous, args) => expectNumber(previous, 'previous') + (args.length ? expectNumber(args[0]!, 'args[0]') : 1)))
  registry.register(reducer('builtin/decrement', 'Decrement by one or a supplied amount.', (previous, args) => expectNumber(previous, 'previous') - (args.length ? expectNumber(args[0]!, 'args[0]') : 1)))
  registry.register(reducer('builtin/min', 'Retain the smaller number.', (previous, args) => Math.min(expectNumber(previous, 'previous'), expectNumber(args[0]!, 'args[0]'))))
  registry.register(reducer('builtin/max', 'Retain the larger number.', (previous, args) => Math.max(expectNumber(previous, 'previous'), expectNumber(args[0]!, 'args[0]'))))
  registry.register(reducer('builtin/toggle', 'Toggle a boolean.', previous => {
    if (typeof previous !== 'boolean') throw new Error('previous must be a boolean')
    return !previous
  }))
  registry.register(reducer('builtin/bounded-append', 'Append and retain the newest N items.', (previous, args) => {
    if (!Array.isArray(previous)) throw new Error('previous must be an array')
    const limit = expectNumber(args[1]!, 'args[1]')
    if (!Number.isInteger(limit) || limit < 0) throw new Error('args[1] must be a non-negative integer')
    return [...previous, cloneJson(args[0]!)].slice(-limit)
  }))
  registry.register(reducer('builtin/set-union', 'Append values not already present.', (previous, args) => {
    if (!Array.isArray(previous)) throw new Error('previous must be an array')
    const incoming = Array.isArray(args[0]) ? args[0] : [args[0]!]
    const seen = new Set(previous.map(value => JSON.stringify(value)))
    const result = previous.map(cloneJson)
    for (const value of incoming) {
      const key = JSON.stringify(value)
      if (!seen.has(key)) { seen.add(key); result.push(cloneJson(value)) }
    }
    return result
  }))
  registry.register(reducer('builtin/remove', 'Remove structurally equal array values.', (previous, args) => {
    if (!Array.isArray(previous)) throw new Error('previous must be an array')
    const removed = new Set((Array.isArray(args[0]) ? args[0] : [args[0]!]).map(value => JSON.stringify(value)))
    return previous.filter(value => !removed.has(JSON.stringify(value))).map(cloneJson)
  }))
  registry.register(reducer('builtin/ema', 'Update an exponential moving average.', (previous, args) => {
    const next = expectNumber(args[0]!, 'args[0]')
    const alpha = expectNumber(args[1]!, 'args[1]')
    if (alpha < 0 || alpha > 1) throw new Error('args[1] alpha must be between 0 and 1')
    return alpha * next + (1 - alpha) * expectNumber(previous, 'previous')
  }))
  registry.register(reducer('builtin/object-merge', 'Shallow merge a JSON object.', (previous, args) => {
    if (!isObject(previous) || !isObject(args[0])) throw new Error('previous and args[0] must be objects')
    return { ...cloneJson(previous), ...cloneJson(args[0]) }
  }))
  return registry
}

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createBuiltinFunctionRegistry(): CapabilityRegistry<FunctionProvider> {
  const registry = new CapabilityRegistry<FunctionProvider>('function')
  const add = (id: string, description: string, execute: FunctionProvider['execute']): void => {
    registry.register({ manifest: builtinManifest(id, '1', description), execute })
  }
  add('builtin/identity', 'Return the input object.', input => cloneJson(input as Record<string, JsonValue>))
  add('builtin/length', 'Return the length of input.value.', input => {
    const value = Array.isArray(input) ? input[0] : (input as Readonly<Record<string, JsonValue>>).value
    if (!Array.isArray(value) && typeof value !== 'string') throw new Error('input.value must be an array or string')
    return value.length
  })
  add('builtin/sum', 'Sum input.values.', input => {
    const values = Array.isArray(input) ? input : (input as Readonly<Record<string, JsonValue>>).values
    if (!Array.isArray(values)) throw new Error('input.values must be an array')
    return values.reduce<number>((sum, value, i) => sum + expectNumber(value, `input.values[${i}]`), 0)
  })
  return registry
}
