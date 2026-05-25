/**
 * toolAdapter — MetaAgentTool → KernelTool bridge.
 *
 * This is the only place that knows about both type worlds.
 * All other modes/ files import from here.
 */
import type { MetaAgentTool, ToolCallContext } from '../core/types.js'
import type { ToolDescriptionContext as MetaToolDescriptionContext } from '../core/types.js'
import type {
  KernelTool,
  KernelToolContext,
  KernelToolResult,
  ZodCompatSchema,
  ToolInputJSONSchema,
} from '../kernel/index.js'

const DEFAULT_MAX_RESULT_SIZE_CHARS = 200 * 1024

/**
 * Lazy getter — reads META_AGENT_MAX_TOOL_RESULT_CHARS at call time, not at
 * module-load time, so tests can override the env var after importing this module.
 */
function getMaxResultSizeChars(): number {
  const raw = process.env['META_AGENT_MAX_TOOL_RESULT_CHARS']
  if (raw === undefined) return DEFAULT_MAX_RESULT_SIZE_CHARS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_RESULT_SIZE_CHARS
  return Math.min(1024 * 1024, Math.max(1024, parsed))
}

// ── JSON Schema → Zod-compatible safeParse ────────────────────────────────────
//
// The kernel only needs safeParse() to decide concurrency safety.
// We implement a simple object-level check rather than full JSON Schema eval.

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

function validateValue(value: unknown, schema: unknown, path: string): string | null {
  if (!isRecord(schema)) return null
  if (schema['type'] !== undefined && !typeMatches(value, schema['type'])) {
    const expected = Array.isArray(schema['type']) ? schema['type'].join('|') : String(schema['type'])
    return `${path} must be ${expected}`
  }
  if (Array.isArray(schema['enum']) && !schema['enum'].includes(value)) {
    return `${path} must be one of ${schema['enum'].map(String).join(', ')}`
  }
  if (schema['type'] === 'array' && Array.isArray(value) && schema['items'] !== undefined) {
    for (let i = 0; i < value.length; i++) {
      const error = validateValue(value[i], schema['items'], `${path}[${i}]`)
      if (error) return error
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
      const error = validateValue(value[field], childSchema, `${path}.${field}`)
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

function buildZodCompatSchema(jsonSchema: Record<string, unknown>): ZodCompatSchema {
  return {
    safeParse(input: unknown):
      | { success: true; data: unknown }
      | { success: false; error: unknown } {
      if (typeof input !== 'object' || input === null) {
        return { success: false, error: 'Not an object' }
      }
      const record = input as Record<string, unknown>
      const required = Array.isArray(jsonSchema['required']) ? jsonSchema['required'] : []
      for (const field of required) {
        if (typeof field === 'string' && !(field in record)) {
          return { success: false, error: `Missing required field "${field}"` }
        }
      }

      const error = validateValue(record, jsonSchema, 'input')
      if (error) return { success: false, error }
      return { success: true, data: input }
    },
  }
}

// ── Context bridge: KernelToolContext → ToolCallContext ───────────────────────

function toToolCallContext(
  ctx: KernelToolContext,
  extraExtensions?: Record<string, unknown>,
): ToolCallContext {
  const ext = { ...ctx.extensions, ...extraExtensions }
  return {
    sessionId: ctx.sessionId,
    agentId: ctx.agentId ?? ctx.sessionId,
    abortSignal: ctx.abortSignal,
    workspaceRoot:       ctx.workspaceRoot,
    readFileState:       ctx.readFileState,
    jobManager:         ext['jobManager'] as ToolCallContext['jobManager'],
    vvChain:            ext['vvChain'] as ToolCallContext['vvChain'],
    provenanceTracker:  ext['provenanceTracker'] as ToolCallContext['provenanceTracker'],
    askUser:            ctx.askUser,
    onMessage:          ext['onMessage'] as ToolCallContext['onMessage'],
    planMode:           ctx.planMode,
  }
}

// ── The main adapter ──────────────────────────────────────────────────────────

export function toKernelTool(
  tool: MetaAgentTool,
  extraExtensions?: Record<string, unknown>,
  getDescriptionContext?: () => MetaToolDescriptionContext,
): KernelTool {
  const rawDescription = tool.description
  const description =
    typeof rawDescription === 'string'
      ? rawDescription
      : async () => rawDescription(getDescriptionContext?.() ?? {
          tools: [tool],
          toolNames: new Set([tool.name]),
          sessionId: '',
          domain: undefined,
        })

  return {
    name: tool.name,

    description,

    inputSchema: buildZodCompatSchema(tool.inputSchema as Record<string, unknown>),

    inputJSONSchema: tool.inputSchema as ToolInputJSONSchema,

    permission: tool.permission,

    async call(input: unknown, ctx: KernelToolContext): Promise<KernelToolResult> {
      const callCtx = toToolCallContext(ctx, extraExtensions)
      const result = await tool.call(input as Record<string, unknown>, callCtx)
      return {
        data: result.content,
        isError: result.isError,
      }
    },

    isConcurrencySafe(_parsedInput?: unknown): boolean {
      return tool.isConcurrencySafe ?? false
    },

    maxResultSizeChars: tool.maxResultSizeChars ?? getMaxResultSizeChars(),
  }
}

/**
 * Convert an array of MetaAgentTools, preserving registration order.
 */
export function toKernelTools(
  tools: MetaAgentTool[],
  extraExtensions?: Record<string, unknown>,
): KernelTool[] {
  return tools.map(t => toKernelTool(t, extraExtensions, () => ({
    tools,
    toolNames: new Set(tools.map(tool => tool.name)),
    sessionId: '',
    domain: undefined,
  })))
}
