/**
 * KernelEvent — the union of all events emitted by KernelSession.submitMessage().
 *
 * Corresponds to CC's SDKMessage but stripped of CLI-only subtypes.
 */
import type { TokenUsage } from './TokenUsage.js'

// ── Individual event types ────────────────────────────────────────────────────

export interface TextDeltaEvent {
  type: 'text_delta'
  delta: string
  sessionId: string
}

export interface ThinkingDeltaEvent {
  type: 'thinking_delta'
  delta: string
  sessionId: string
}

export interface ToolUseEvent {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  sessionId: string
}

export interface ToolResultEvent {
  type: 'tool_result'
  id: string
  toolName: string
  content: string
  isError: boolean
  sessionId: string
}

/**
 * Emitted right BEFORE the (slow, LLM-backed) conversation compaction begins,
 * so a UI can show a "compacting…" indicator while it runs. The matching
 * compact_boundary is emitted once compaction completes.
 */
export interface CompactStartEvent {
  type: 'compact_start'
  sessionId: string
}

export interface CompactBoundaryEvent {
  type: 'compact_boundary'
  compactMetadata: {
    summaryTokens: number
    previousTokens: number
  }
  sessionId: string
}

export interface CompactFailedEvent {
  type: 'compact_failed'
  attempt: number
  querySource?: string
  error: string
  consecutiveFailures: number
  sessionId: string
}

export interface ApiRetryEvent {
  type: 'api_retry'
  attempt: number
  maxRetries: number
  retryDelayMs: number
  errorStatus: number | null
  sessionId: string
}

export interface ToolUseSummaryEvent {
  type: 'tool_use_summary'
  summary: string
  precedingToolUseIds: string[]
  sessionId: string
}

export interface SystemMessageEvent {
  type: 'system_message'
  subtype: 'warning' | 'info'
  text: string
  sessionId: string
}

export type ResultSubtype =
  | 'success'
  | 'error_max_turns'
  | 'error_max_budget_usd'
  | 'error_during_execution'
  | 'error_blocking_limit'

export interface ResultEvent {
  type: 'result'
  subtype: ResultSubtype
  sessionId: string
  usage: TokenUsage
  costUsd: number
  numTurns: number
  stopReason: string | null
  resultText: string
  errors?: string[]
  permissionDenials?: PermissionDenial[]
}

// ── Permission denial (mirrors CC's SDKPermissionDenial) ─────────────────────

export interface PermissionDenial {
  toolName: string
  toolUseId: string
  reason: string
  timestamp: number
}

// ── The union ────────────────────────────────────────────────────────────────

export type KernelEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolUseEvent
  | ToolResultEvent
  | CompactStartEvent
  | CompactBoundaryEvent
  | CompactFailedEvent
  | ApiRetryEvent
  | ToolUseSummaryEvent
  | SystemMessageEvent
  | ResultEvent
