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
import { RuntimeEnv } from '../infra/env/RuntimeEnv.js'

const COOPERATIVE_ABORT_TOOLS = new Set([
  // ask_user forwards ctx.abortSignal to the host prompt: the per-tool timeout
  // cancels the pending readline question instead of leaving a zombie prompt
  // that swallows the user's next input line.
  'ask_user',
  'bash',
  'experiment_dispatch',
  'paper_search',
  'powershell',
  'research_dispatch',
  'run_agent',
  'sleep',
  'spawn_sub_agent',
  'web_fetch',
  'web_search',
])

const NON_COOPERATIVE_ABORT_TOOLS = new Set([
  // The current MCP client abstraction does not accept AbortSignal. Auto mode
  // therefore fails closed instead of allowing timed-out MCP calls to pile up.
  'mcp_call',
  'read_mcp_resource',
  'list_mcp_resources',
])

/**
 * Authoritative built-in abort declaration. Third-party tools must declare
 * abortSupport on the tool object; unknown names deliberately remain undefined.
 */
export function resolveToolAbortSupport(
  tool: Pick<MetaAgentTool, 'name' | 'abortSupport'>,
): KernelTool['abortSupport'] {
  if (tool.abortSupport) return tool.abortSupport
  if (COOPERATIVE_ABORT_TOOLS.has(tool.name)) return 'cooperative'
  if (NON_COOPERATIVE_ABORT_TOOLS.has(tool.name)) return 'non_cooperative'
  // All remaining built-ins are local, bounded state/FS operations. Unknown
  // external tools are not silently classified.
  if (
    tool.name.startsWith('auto_') ||
    tool.name.startsWith('git_') ||
    tool.name.startsWith('team_') ||
    tool.name.startsWith('workflow_') ||
    BUILTIN_BOUNDED_TOOLS.has(tool.name)
  ) return 'bounded'
  return undefined
}

const BUILTIN_BOUNDED_TOOLS = new Set([
  'anchor_delete', 'artifacts_register', 'cancel_sub_agent', 'config',
  'cron_create', 'cron_delete', 'cron_list', 'echo', 'edit_file',
  'enter_plan_mode', 'exit_plan_mode', 'experience_delete', 'experience_load',
  'experience_search', 'experience_write', 'find_duplicate_computation', 'glob',
  'grep', 'get_computation_lineage', 'get_provenance',
  'get_sub_agent_intermediate', 'get_sub_agent_status', 'hardware_profile_read',
  'hardware_profile_write', 'list_recent_results', 'list_sub_agents',
  'memory_delete', 'memory_write', 'notebook_edit', 'physical_anchor_load',
  'physical_anchor_search', 'physical_anchor_write', 'principle_delete',
  'principle_load', 'principle_promote', 'principle_search', 'progress_note',
  'read_file', 'return_result', 'send_message', 'session_list', 'session_star',
  'session_tag', 'skill', 'todo_write', 'write_file', 'append_file',
])

const DEFAULT_MAX_RESULT_SIZE_CHARS = 200 * 1024

/**
 * Lazy getter — reads META_AGENT_MAX_TOOL_RESULT_CHARS at call time, not at
 * module-load time, so tests can override the env var after importing this module.
 */
function getMaxResultSizeChars(): number {
  return RuntimeEnv.maxToolResultChars(DEFAULT_MAX_RESULT_SIZE_CHARS)
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
  // ── M3: numeric range constraints ──────────────────────────────────────────
  if (typeof value === 'number' && Number.isFinite(value)) {
    const min = schema['minimum']
    const max = schema['maximum']
    const exMin = schema['exclusiveMinimum']
    const exMax = schema['exclusiveMaximum']
    const mul = schema['multipleOf']
    if (typeof min === 'number' && value < min) return `${path} must be >= ${min}`
    if (typeof max === 'number' && value > max) return `${path} must be <= ${max}`
    if (typeof exMin === 'number' && value <= exMin) return `${path} must be > ${exMin}`
    if (typeof exMax === 'number' && value >= exMax) return `${path} must be < ${exMax}`
    if (typeof mul === 'number' && mul > 0) {
      const ratio = value / mul
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) return `${path} must be a multiple of ${mul}`
    }
  }
  // ── M3: string length / pattern constraints ───────────────────────────────
  if (typeof value === 'string') {
    const minL = schema['minLength']
    const maxL = schema['maxLength']
    const pat = schema['pattern']
    if (typeof minL === 'number' && value.length < minL) return `${path} must be at least ${minL} chars`
    if (typeof maxL === 'number' && value.length > maxL) return `${path} must be at most ${maxL} chars`
    if (typeof pat === 'string') {
      try {
        if (!new RegExp(pat).test(value)) return `${path} does not match pattern ${pat}`
      } catch { /* invalid pattern — treat as no constraint */ }
    }
  }
  // ── M3: array length constraints ──────────────────────────────────────────
  if (schema['type'] === 'array' && Array.isArray(value)) {
    const minI = schema['minItems']
    const maxI = schema['maxItems']
    if (typeof minI === 'number' && value.length < minI) return `${path} must have at least ${minI} items`
    if (typeof maxI === 'number' && value.length > maxI) return `${path} must have at most ${maxI} items`
    if (schema['uniqueItems'] === true) {
      const seen = new Set<string>()
      for (let i = 0; i < value.length; i++) {
        const key = JSON.stringify(value[i])
        if (seen.has(key)) return `${path}[${i}] is a duplicate (uniqueItems)`
        seen.add(key)
      }
    }
    if (schema['items'] !== undefined) {
      for (let i = 0; i < value.length; i++) {
        const error = validateValue(value[i], schema['items'], `${path}[${i}]`)
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
    autonomousMode:     ctx.autonomousMode,
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
    abortSupport: resolveToolAbortSupport(tool),

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

    timeoutMs: tool.timeoutMs,
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
