/**
 * KernelTool — the interface every tool must satisfy.
 *
 * Mirrors CC's Tool interface, but slimmed to what the kernel actually needs.
 * UI-only methods (renderToolResultMessage, etc.) are omitted.
 */
import type { KernelMessage } from './KernelMessage.js'
import type { FileStateCache } from '../session/FileStateCache.js'
import type { ToolPermissionDeclaration } from './Permissions.js'

// ── Tool description context ──────────────────────────────────────────────────

export interface ToolDescriptionContext {
  sessionId: string
  model: string
}

// ── Permission context passed to isEnabled ────────────────────────────────────

export interface ToolPermissionContext {
  /** Whether the session is in plan (read-only) mode */
  planMode: boolean
  /** Whether permissions are fully bypassed (e.g. --dangerously-skip-permissions) */
  bypassPermissions: boolean
}

// ── Tool call context (passed to call()) ─────────────────────────────────────

export interface KernelToolContext {
  sessionId: string
  /** Current tool invocation id, injected immediately before call(). */
  toolUseId?: string
  agentId?: string                                  // non-null in subagent calls
  abortSignal: AbortSignal
  readFileState: FileStateCache
  messages: readonly KernelMessage[]                // current message history
  workspaceRoot?: string
  planMode?: boolean
  /** True for unattended auto-mode loops. */
  autonomousMode?: boolean
  askUser?: (question: string, choices?: string[], signal?: AbortSignal) => Promise<string>
  /** Escape hatch for mode-specific context (Campaign, Robotics, etc.) */
  extensions?: Record<string, unknown>
}

// ── Tool result ───────────────────────────────────────────────────────────────

export interface KernelToolResult {
  /** The result content. String is used as tool_result text content. */
  data: string | ContentBlockLike[]
  isError?: boolean
  /** Structured execution evidence forwarded into KernelEvent/trajectory. */
  execution?: KernelToolExecutionMetadata
  /** Structured domain facts; forwarded without kernel interpretation. */
  trajectoryItems?: import('../../trajectory/types.js').TrajectoryItem[]
  /** Optional additional messages to inject after the tool result */
  newMessages?: KernelMessage[]
  /** Optional context modifier applied after this tool runs */
  contextModifier?: (ctx: KernelToolContext) => KernelToolContext
  /** Optional control-flow request consumed mechanically by KernelLoop. */
  control?: KernelToolControl
}

export interface KernelToolExecutionMetadata {
  command?: string
  cwd?: string
  exitCode?: number | null
  signal?: string | null
  timedOut?: boolean
  aborted?: boolean
  shellSessionId?: string
}

export interface KernelParkControl {
  kind: 'park'
  afterMs: number
  reason: string
  checkpoint?: Record<string, unknown>
}

export type KernelToolControl = KernelParkControl

export type ContentBlockLike =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

// ── Zod-compatible schema (subset we need) ────────────────────────────────────

export interface ZodCompatSchema {
  safeParse(input: unknown):
    | { success: true; data: unknown }
    | { success: false; error: unknown }
}

// ── JSON Schema for sending to the API ───────────────────────────────────────

export interface ToolInputJSONSchema {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  [key: string]: unknown
}

// ── The tool interface ────────────────────────────────────────────────────────

export interface KernelTool {
  readonly name: string
  readonly aliases?: string[]

  /**
   * Description sent to the model as part of the tool schema.
   * Can be a static string or a function for dynamic descriptions.
   */
  readonly description: string | ((ctx: ToolDescriptionContext) => Promise<string>)

  /**
   * Zod-compatible schema.  safeParse result is passed to isConcurrencySafe.
   * If safeParse fails, the tool is treated as non-concurrency-safe.
   */
  readonly inputSchema: ZodCompatSchema

  /** JSON Schema version of the input — sent verbatim to the Anthropic API */
  readonly inputJSONSchema: ToolInputJSONSchema
  readonly permission?: ToolPermissionDeclaration
  /** Explicit cancellation/lifetime contract; auto mode rejects undeclared tools. */
  readonly abortSupport?: 'cooperative' | 'bounded' | 'non_cooperative'

  /**
   * Grouping label for deferred-schema tools. Defaults to 'core'.
   * See tools/registry/ToolVisibility.ts.
   */
  readonly namespace?: string
  /**
   * When true, this tool's SCHEMA is withheld from the model until a
   * `tool_search` call reveals it. The tool stays executable throughout — the
   * kernel filters what it SENDS, never what it will run, because permission
   * decisions belong to the permission layer and not to a context-budget
   * optimisation.
   */
  readonly deferLoading?: boolean

  /**
   * Execute the tool.
   * The kernel guarantees input has already been validated via inputSchema.safeParse.
   */
  call(input: unknown, context: KernelToolContext): Promise<KernelToolResult>

  /**
   * Whether this tool can safely be run in parallel with other safe tools.
   * Receives the already-parsed input (safeParse.data).
   * Must not throw — if it does, treated as false.
   */
  isConcurrencySafe(parsedInput?: unknown): boolean

  /** Whether this tool is available given the current permissions */
  isEnabled?(permissions: ToolPermissionContext): boolean

  /**
   * Maximum number of characters to keep in a tool result content string.
   * Undefined / Infinity → no limit (e.g. sub-agent calls).
   */
  maxResultSizeChars?: number

  /**
   * Per-tool execution timeout in milliseconds.
   *   - undefined  → use the kernel default (META_AGENT_TOOL_TIMEOUT_MS, 3 min).
   *   - 0 / Infinity → no per-tool timeout. Use for tools that legitimately block
   *     longer than the default — e.g. sub-agent-dispatch tools that await
   *     completion (those are bounded by the sub-agent's own wall-clock cap).
   * On timeout the kernel aborts the tool's abortSignal and returns an error
   * tool_result. Because the default lives in the kernel, it applies inside
   * sub-agent kernel loops too (the timeout mechanism propagates downward).
   */
  timeoutMs?: number
}
