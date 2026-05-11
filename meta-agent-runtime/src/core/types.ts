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

  // ── Runtime services (injected by RuntimeContext when configured) ──────────
  jobManager?: import('../jobs/JobManager.js').JobManager
  vvChain?: import('../validation/VVHookChain.js').VVHookChain
  provenanceTracker?: import('../provenance/ProvenanceTracker.js').ProvenanceTracker
}

export interface ToolResult {
  content: string
  isError: boolean
}

/** Base tool interface — Claude Code compatible */
export interface MetaAgentTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema object
  call(input: Record<string, unknown>, context: ToolCallContext): Promise<ToolResult>
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
