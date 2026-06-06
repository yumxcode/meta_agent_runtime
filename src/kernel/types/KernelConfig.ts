/**
 * KernelConfig — unified configuration for KernelSession.
 */
import type { KernelTool, KernelToolContext } from './KernelTool.js'
import type { KernelMessage } from './KernelMessage.js'
import type { PermissionDenial } from './KernelEvent.js'

export type ThinkingConfig =
  | { type: 'disabled' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'adaptive' }   // pass thinking: {type:'enabled', budget_tokens:16000} to API

export interface CompactConfig {
  /** Whether to enable auto-compact (default: true) */
  enabled: boolean
  /** Model to use for compact summarisation (default: flashModel) */
  model?: string
  /**
   * Custom compact instructions, injected at the front of the compact side-call
   * prompt (the ## Additional Instructions section), ahead of the conversation
   * being summarised.
   *
   * May be a plain string, or a thunk resolved lazily at compaction time — use
   * the thunk form when the instructions depend on live session state (e.g.
   * active sub-agent task IDs, current phase, hardware constraints) that must be
   * current at the moment compaction fires rather than captured at config time.
   * Returning null/undefined from the thunk means "no custom instructions".
   */
  customInstructions?: string | (() => string | null | undefined)
  /**
   * Deterministic state anchors appended to the compact OUTPUT (the summary
   * itself), independent of the model-generated summary. Unlike
   * customInstructions — which only steer the summarisation model and are lost
   * when the model returns a terse or empty summary — these anchors are appended
   * verbatim and protected from truncation in every path (rich summary, terse
   * summary, and empty-response fallback).
   *
   * Use the thunk form when the anchors depend on live session state (e.g.
   * robotics active/completed sub-agent task IDs, phase, hardware safety
   * limits, experience working set) that must reflect the moment compaction
   * fires. Returning null/undefined means "no extra anchors".
   */
  deterministicAnchors?: string | (() => string | null | undefined)
  /** querySource tag — 'compact' to prevent recursion */
  querySource?: string
}

export type CanUseToolFn = (
  tool: KernelTool,
  input: unknown,
  assistantMessageUuid: string,
  toolUseId: string,
  context: KernelToolContext,
) => Promise<CanUseToolResult>

export type CanUseToolResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string }
  | { behavior: 'redirect'; message: string }

export interface KernelConfig {
  // ── API ──────────────────────────────────────────────────────────────────

  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string

  /** Main loop model (e.g. 'claude-sonnet-4-6'). */
  model: string

  /** Fallback model — used when main model triggers a FallbackTriggeredError */
  fallbackModel?: string

  /** Thinking config to use after fallback. Defaults to disabled. */
  fallbackThinkingConfig?: ThinkingConfig

  /** Beta flags to use after fallback. Defaults to none. */
  fallbackBetas?: string[]

  /** Whether to include the kernel's default Anthropic beta flags after fallback. Defaults to false. */
  fallbackIncludeDefaultBetas?: boolean

  /**
   * Additional Anthropic API beta feature flags sent on every request.
   * Merged with the kernel's default 'interleaved-thinking-2025-05-14' beta.
   *
   * Example — Campaign / agentic sessions with many tools should pass:
   *   betas: ['token-efficient-tools-2025-02-19']
   * This reduces token overhead for tool schema encoding (~40-70% savings on
   * tool-related prompt tokens in multi-tool sessions).
  */
  betas?: string[]

  /** Whether to include kernel default Anthropic beta flags. Defaults to true. */
  includeDefaultBetas?: boolean

  /** Base URL override for the Anthropic client */
  baseURL?: string

  // ── Session ───────────────────────────────────────────────────────────────

  /**
   * Optional pinned session ID. When omitted, KernelSession generates a random UUID.
   * Useful when callers (e.g. RoboticsSession) want the inner session ID to match
   * an outer session ID for consistent debug file paths and store entries.
   */
  sessionId?: string

  /** Current working directory (used by tools). Defaults to process.cwd() */
  cwd?: string

  /** Optional message history to preload when resuming a session. */
  initialMessages?: KernelMessage[]

  /**
   * Static system prompt text.
   *
   * The kernel assembles the effective system prompt via
   * `assembleSystemPrompt(systemPrompt, appendSystemPrompt)` (see
   * utils/AssembleSystemPrompt.ts) — empty / undefined / null parts are
   * elided so callers that build the whole prompt out of `appendSystemPrompt`
   * (e.g. MetaAgentSession) can pass `systemPrompt: ''` without producing
   * stray leading whitespace.
   */
  systemPrompt?: string

  /**
   * Suffix joined to systemPrompt on every submitMessage call.
   * Useful for Campaign/mode-specific dynamic context.
   * See `assembleSystemPrompt` for the precise join semantics.
   */
  appendSystemPrompt?: string

  // ── Tools ─────────────────────────────────────────────────────────────────

  /** Tools available to the model */
  tools: KernelTool[]

  /** Permission gate — called before each tool execution. Defaults to allow-all. */
  canUseTool?: CanUseToolFn

  /** Mutable plan-mode state shared with enter/exit plan-mode tools. */
  planModeRef?: { active: boolean }

  /** Optional user prompt function used by permission policies. */
  askUser?: (question: string, choices?: string[]) => Promise<string>

  // ── Limits ────────────────────────────────────────────────────────────────

  /** Maximum number of agentic turns per submitMessage call (default: 100) */
  maxTurns?: number

  /** Maximum cumulative USD budget across this session's lifetime */
  maxBudgetUsd?: number

  /** Override max_tokens sent to the API */
  maxOutputTokens?: number

  /** Maximum API retries for transient errors (default: 5) */
  maxRetries?: number

  // ── Compact ───────────────────────────────────────────────────────────────

  /** Auto-compact configuration */
  compact?: CompactConfig

  /**
   * querySource — prevents compact recursion.
   * Set to 'compact' when this session is used as a compact subagent.
   * Set to 'session_memory' for memory-update sessions.
   */
  querySource?: 'main' | 'compact' | 'session_memory' | string

  // ── Thinking ─────────────────────────────────────────────────────────────

  thinkingConfig?: ThinkingConfig

  // ── Callbacks ─────────────────────────────────────────────────────────────

  /** Called whenever the internal messages array changes (for persistence). */
  onMessagesUpdate?: (messages: readonly KernelMessage[]) => void

  /** Called when permission denials accumulate */
  onPermissionDenial?: (denial: PermissionDenial) => void

  // ── Debug ─────────────────────────────────────────────────────────────────

  /** Enables verbose debug logging */
  debug?: boolean
}
