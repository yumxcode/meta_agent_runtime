/**
 * Core type definitions for Meta-Agent Runtime
 *
 * Designed to be interface-compatible with Claude Code's SDKMessage types
 * so meta-agent-runtime and CC internals can be swapped in future.
 *
 * Ref: claude-code-source-code-main/src/entrypoints/agentSdkTypes.ts
 */

// ─────────────────────────────────────────────────────────────────────────────
// Session events yielded by MetaAgentSession.submit()
// ─────────────────────────────────────────────────────────────────────────────

/** Text chunk from the model (streaming) */
export interface MetaAgentTextEvent {
  type: 'text'
  text: string
  sessionId: string
}

/** Thinking (reasoning) chunk from the model (streaming) — emitted when thinking is enabled */
export interface MetaAgentThinkingDeltaEvent {
  type: 'thinking_delta'
  delta: string
  sessionId: string
}

/** Tool the model wants to invoke */
export interface MetaAgentToolUseEvent {
  type: 'tool_use'
  toolUseId: string
  toolName: string
  toolInput: Record<string, unknown>
  sessionId: string
}

/** Tool result injected back into the conversation */
export interface MetaAgentToolResultEvent {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError: boolean
  sessionId: string
}

/** Terminal success result for the full turn */
export interface MetaAgentResultEvent {
  type: 'result'
  subtype: 'success' | 'error_max_turns' | 'error_max_budget' | 'error_during_execution'
  sessionId: string
  result: string
  isError: boolean
  durationMs: number
  numTurns: number
  stopReason: string | null
  totalCostUsd: number
  usage: TokenUsage
  /** Populated on error_during_execution — contains the underlying error message(s) */
  errors?: string[]
}

/** API-level stream events (pass-through for advanced consumers) */
export interface MetaAgentStreamEvent {
  type: 'stream_event'
  event: unknown
  sessionId: string
}

/** Retry notification when API returns a retryable error */
export interface MetaAgentRetryEvent {
  type: 'api_retry'
  attempt: number
  maxRetries: number
  retryDelayMs: number
  sessionId: string
}

export type MetaAgentEvent =
  | MetaAgentTextEvent
  | MetaAgentThinkingDeltaEvent
  | MetaAgentToolUseEvent
  | MetaAgentToolResultEvent
  | MetaAgentResultEvent
  | MetaAgentStreamEvent
  | MetaAgentRetryEvent

// ─────────────────────────────────────────────────────────────────────────────
// Tool interface — every capability registered in the ToolRegistry implements this
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context passed to every tool.call() invocation.
 *
 * The optional runtime services (jobManager, vvChain, provenanceTracker) are
 * only present when the session was constructed with a RuntimeContext.  Tools
 * that want to query provenance, submit sub-jobs, or run custom V&V checks
 * can destructure them from context.
 *
 * Type-only imports are used here to avoid runtime circular dependencies.
 */
export interface ToolCallContext {
  sessionId: string
  agentId: string
  abortSignal: AbortSignal
  workspaceRoot?: string
  readFileState?: import('../kernel/session/FileStateCache.js').FileStateCache

  // ── Runtime services (injected by RuntimeContext when configured) ──────────
  jobManager?: import('../jobs/JobManager.js').JobManager
  vvChain?: import('../validation/VVHookChain.js').VVHookChain
  provenanceTracker?: import('../provenance/ProvenanceTracker.js').ProvenanceTracker
  askUser?: (question: string, options: string[]) => Promise<string>
  onMessage?: (message: string, status: 'normal' | 'proactive') => void
  /**
   * When true, the session is in "plan mode": every tool call that is NOT
   * concurrency-safe must be approved by the user via askUser() before it
   * executes.  Set/cleared by EnterPlanMode / ExitPlanMode tools through
   * the shared planModeRef on the session.
   */
  planMode?: boolean

  // ── Sandbox ───────────────────────────────────────────────────────────────
  /**
   * OS-level sandbox handle injected by MetaAgentSession._wrapTool() when
   * the tool declares permission.sandbox.
   *
   * Tools that execute subprocesses (e.g. BashTool) use this to wrap their
   * execFileAsync call via sandboxHandle.wrapExec(command, cwd), ensuring
   * filesystem and network restrictions are enforced at the OS level.
   *
   * Undefined when the tool has no sandbox declaration. If a sandbox is
   * declared but no backend is available, execution fails closed unless the
   * sandbox policy explicitly allows unsandboxed fallback.
   */
  sandboxHandle?: import('../sandbox/types.js').SandboxHandle
}

export interface ToolResult {
  content: string
  isError: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool description context — passed to dynamic description functions
// Mirrors CC's toolToAPISchema options, letting each tool inspect the full
// set of registered siblings before producing its description string.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runtime context available to a tool's description function.
 *
 * Analogous to CC's `toolToAPISchema` options object — passed to every
 * tool whose `description` is an async function rather than a plain string.
 * Allows tools to cross-reference sibling tools, domains, and session state
 * when building their prompt (e.g. BashTool can say "use `grep` instead of rg").
 */
export interface ToolDescriptionContext {
  /** All tools registered in this session, in registration order. */
  readonly tools: readonly MetaAgentTool[]
  /** Fast O(1) lookup: is tool X available in this session? */
  readonly toolNames: ReadonlySet<string>
  /** Current session ID (stable within a session). */
  readonly sessionId: string
  /** Engineering domain configured for this session. */
  readonly domain?: string
}

/**
 * A tool description is either:
 *   - A plain string  (static, evaluated once at tool-creation time)
 *   - An async function  (dynamic, evaluated lazily per-session and cached)
 *
 * Dynamic descriptions receive a ToolDescriptionContext so they can
 * reference sibling tools, feature state, or domain at resolution time —
 * identical to CC's async `tool.prompt(options)` pattern.
 */
export type ToolDescription =
  | string
  | ((ctx: ToolDescriptionContext) => Promise<string>)

export type ToolPermissionCategory =
  | 'read'
  | 'write'
  | 'execute'
  | 'network'
  | 'config'
  | 'state'

export interface ToolPermissionDeclaration {
  /** Broad capability class used by the kernel permission policy. */
  category?: ToolPermissionCategory
  /** Input fields that contain filesystem paths and must stay in workspace. */
  pathFields?: string[]
  /** Input field that contains a working directory, usually bash.cwd. */
  cwdField?: string
  /** Whether path/cwd fields are constrained to the workspace. Default: true for path-aware tools. */
  requiresWorkspace?: boolean
  /** Whether calls should go through interactive confirmation when available. */
  sensitive?: boolean
  /** Plan-mode behavior for this tool. Default: ask for non-concurrency-safe tools. */
  planMode?: 'allow' | 'ask' | 'deny'
  /**
   * OS-level sandbox policy for this tool's execution.
   *
   * When set, MetaAgentSession._wrapTool() injects a SandboxHandle into the
   * ToolCallContext before each call, and the tool reads ctx.sandboxHandle to
   * wrap its subprocess execution.
   *
   * - true            → default policy: workspace root writable, network unrestricted
   * - SandboxConfig   → custom policy (e.g. deny network, extra write paths)
   * - undefined       → no OS-level sandbox (default)
   *
   * Tools that execute arbitrary shell commands (e.g. BashTool) should declare
   * sandbox: true so they are automatically sandboxed even in the main agent
   * session, not just inside isolated sub-agents.
   */
  sandbox?: true | import('../sandbox/types.js').SandboxConfig
}

/** Base tool interface — Claude Code compatible */
export interface MetaAgentTool {
  name: string
  /**
   * Tool description sent to the model via the Anthropic `tools[]` parameter.
   *
   * Accepts either a static string (backward-compatible) or an async function
   * that receives ToolDescriptionContext and returns a string.  The session
   * resolves functions lazily and caches the result until the tool registry
   * changes (same behaviour as CC's per-session toolSchemaCache).
   */
  description: ToolDescription
  inputSchema: Record<string, unknown>  // JSON Schema object
  permission?: ToolPermissionDeclaration
  call(input: Record<string, unknown>, context: ToolCallContext): Promise<ToolResult>
  /**
   * When true, this tool is concurrency-safe (read-only / no filesystem side
   * effects) and may be executed in parallel with other concurrency-safe tools
   * in the same model turn.
   *
   * Mirrors CC's `isConcurrencySafe()` — tools that write files, run shell
   * commands, or mutate any shared state must leave this unset (defaults to
   * false), which forces them to run serially relative to other writes.
   *
   * Default: false (safe — unknown tools are treated as having side effects).
   */
  isConcurrencySafe?: boolean
  /** Maximum characters to keep from this tool's result. Undefined uses runtime default. */
  maxResultSizeChars?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Token usage (mirrors CC's NonNullableUsage)
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
}

export function accumulateUsage(a: TokenUsage, b: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheCreationInputTokens: a.cacheCreationInputTokens + (b.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens: a.cacheReadInputTokens + (b.cacheReadInputTokens ?? 0),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation message (internal representation)
// ─────────────────────────────────────────────────────────────────────────────

export interface UserMessage {
  role: 'user'
  content: string | ContentBlock[]
}

export interface AssistantMessage {
  role: 'assistant'
  content: ContentBlock[]
}

export type ConversationMessage = UserMessage | AssistantMessage

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  /**
   * Thinking block returned by reasoning models (DeepSeek v4-flash/pro, Claude extended-thinking).
   * MUST be passed back verbatim to the API in the next turn — omitting it causes HTTP 400.
   * `signature` is an opaque integrity token issued by the provider.
   */
  | { type: 'thinking'; thinking: string; signature: string }
  /**
   * Redacted thinking block — provider has hidden the content for safety reasons.
   * Also MUST be passed back verbatim; `data` is an opaque blob.
   */
  | { type: 'redacted_thinking'; data: string }

// ─────────────────────────────────────────────────────────────────────────────
// Domain profile — which engineering domain this session operates in
// ─────────────────────────────────────────────────────────────────────────────

export type EngineeringDomain = 'battery' | 'mechanical' | 'thermal' | 'electrical' | 'generic'
