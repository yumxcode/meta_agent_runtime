import type { ShapeSpec } from '../spec/ShapeSpec.js'
import type { JsonValue } from '../spec/GraphTypes.js'

export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>)
    .every(([key, child]) => key !== '__proto__' && key !== 'constructor' && isJsonValue(child))
}

export function validateShape(value: unknown, spec: ShapeSpec, at = 'value'): string[] {
  const errs: string[] = []
  switch (spec.type) {
    case 'null':
      if (value !== null) errs.push(`${at} must be null`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') errs.push(`${at} must be a boolean`)
      break
    case 'string':
      if (typeof value !== 'string') errs.push(`${at} must be a string`)
      else {
        if (spec.minLength !== undefined && value.length < spec.minLength) errs.push(`${at} is shorter than ${spec.minLength}`)
        if (spec.enum && !spec.enum.includes(value)) errs.push(`${at} must be one of ${spec.enum.join(', ')}`)
      }
      break
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || (spec.type === 'integer' && !Number.isInteger(value))) {
        errs.push(`${at} must be ${spec.type === 'integer' ? 'an integer' : 'a finite number'}`)
      } else {
        if (spec.minimum !== undefined && value < spec.minimum) errs.push(`${at} must be >= ${spec.minimum}`)
        if (spec.maximum !== undefined && value > spec.maximum) errs.push(`${at} must be <= ${spec.maximum}`)
      }
      break
    case 'array':
      if (!Array.isArray(value)) errs.push(`${at} must be an array`)
      else {
        if (spec.minItems !== undefined && value.length < spec.minItems) errs.push(`${at} must contain at least ${spec.minItems} items`)
        if (spec.items) value.forEach((item, i) => errs.push(...validateShape(item, spec.items!, `${at}[${i}]`)))
      }
      break
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) errs.push(`${at} must be an object`)
      else {
        const record = value as Record<string, unknown>
        for (const key of spec.required ?? []) if (!(key in record)) errs.push(`${at}.${key} is required`)
        for (const [key, child] of Object.entries(spec.properties ?? {})) {
          if (key in record) errs.push(...validateShape(record[key], child, `${at}.${key}`))
        }
        if (spec.additionalProperties === false) {
          const known = new Set(Object.keys(spec.properties ?? {}))
          for (const key of Object.keys(record)) if (!known.has(key)) errs.push(`${at}.${key} is not allowed`)
        }
      }
      break
  }
  return errs
}

export function readPath(root: unknown, path: string): JsonValue {
  const parts = path.split('.').filter(Boolean)
  let value: unknown = root
  for (const part of parts) {
    if (value === null || typeof value !== 'object' || !(part in value)) throw new Error(`reference '${path}' is missing at '${part}'`)
    value = (value as Record<string, unknown>)[part]
  }
  if (!isJsonValue(value)) throw new Error(`reference '${path}' does not resolve to JSON`)
  return cloneJson(value)
}
