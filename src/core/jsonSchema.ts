/** Small JSON-Schema subset shared by MetaAgent tool adapters and direct tool calls. */
export function validateJsonSchemaValue(
  value: unknown,
  schema: unknown,
  path = 'value',
): string | null {
  if (!isRecord(schema)) return null
  if (schema['type'] !== undefined && !typeMatches(value, schema['type'])) {
    const expected = Array.isArray(schema['type']) ? schema['type'].join('|') : String(schema['type'])
    return `${path} must be ${expected}`
  }
  if (Array.isArray(schema['enum']) && !schema['enum'].includes(value)) {
    return `${path} must be one of ${schema['enum'].map(String).join(', ')}`
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const min = schema['minimum']
    const max = schema['maximum']
    const exMin = schema['exclusiveMinimum']
    const exMax = schema['exclusiveMaximum']
    const multiple = schema['multipleOf']
    if (typeof min === 'number' && value < min) return `${path} must be >= ${min}`
    if (typeof max === 'number' && value > max) return `${path} must be <= ${max}`
    if (typeof exMin === 'number' && value <= exMin) return `${path} must be > ${exMin}`
    if (typeof exMax === 'number' && value >= exMax) return `${path} must be < ${exMax}`
    if (typeof multiple === 'number' && multiple > 0) {
      const ratio = value / multiple
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) return `${path} must be a multiple of ${multiple}`
    }
  }
  if (typeof value === 'string') {
    const minLength = schema['minLength']
    const maxLength = schema['maxLength']
    const pattern = schema['pattern']
    if (typeof minLength === 'number' && value.length < minLength) return `${path} must be at least ${minLength} chars`
    if (typeof maxLength === 'number' && value.length > maxLength) return `${path} must be at most ${maxLength} chars`
    if (typeof pattern === 'string') {
      try {
        if (!new RegExp(pattern).test(value)) return `${path} does not match pattern ${pattern}`
      } catch { /* invalid patterns are rejected by schema authorship checks */ }
    }
  }
  if (schema['type'] === 'array' && Array.isArray(value)) {
    const minItems = schema['minItems']
    const maxItems = schema['maxItems']
    if (typeof minItems === 'number' && value.length < minItems) return `${path} must have at least ${minItems} items`
    if (typeof maxItems === 'number' && value.length > maxItems) return `${path} must have at most ${maxItems} items`
    if (schema['uniqueItems'] === true) {
      const seen = new Set<string>()
      for (let index = 0; index < value.length; index++) {
        const key = JSON.stringify(value[index])
        if (seen.has(key)) return `${path}[${index}] is a duplicate (uniqueItems)`
        seen.add(key)
      }
    }
    if (schema['items'] !== undefined) {
      for (let index = 0; index < value.length; index++) {
        const error = validateJsonSchemaValue(value[index], schema['items'], `${path}[${index}]`)
        if (error) return error
      }
    }
  }
  if (schema['type'] === 'object' && isRecord(value)) {
    const required = Array.isArray(schema['required']) ? schema['required'] : []
    for (const field of required) {
      if (typeof field === 'string' && !(field in value)) return `${path}.${field} is required`
    }
    const properties = isRecord(schema['properties']) ? schema['properties'] : {}
    for (const [field, childSchema] of Object.entries(properties)) {
      if (!(field in value)) continue
      const error = validateJsonSchemaValue(value[field], childSchema, `${path}.${field}`)
      if (error) return error
    }
    if (schema['additionalProperties'] === false) {
      for (const field of Object.keys(value)) {
        if (!(field in properties)) return `${path}.${field} is not allowed`
      }
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function typeMatches(value: unknown, expected: unknown): boolean {
  const types = Array.isArray(expected) ? expected : [expected]
  return types.some(type => {
    if (type === 'string') return typeof value === 'string'
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
    if (type === 'integer') return Number.isInteger(value)
    if (type === 'boolean') return typeof value === 'boolean'
    if (type === 'array') return Array.isArray(value)
    if (type === 'object') return isRecord(value)
    if (type === 'null') return value === null
    return true
  })
}
