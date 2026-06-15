/**
 * KernelMessage — internal message representation.
 *
 * CC uses a complex Message union with many subtypes. We keep the essential
 * structure that the API and loop need, while stripping CLI-only fields.
 */
import type Anthropic from '@anthropic-ai/sdk'

// Content block types re-exported for convenience
export type TextBlock = Anthropic.TextBlockParam
export type ImageBlock = Anthropic.ImageBlockParam
export type ToolUseBlock = Anthropic.ToolUseBlockParam
export type ToolResultBlock = Anthropic.ToolResultBlockParam
export type ThinkingBlock = { type: 'thinking'; thinking: string }
export type RedactedThinkingBlock = { type: 'redacted_thinking'; data: string }

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock

export type MessageRole = 'user' | 'assistant'

/**
 * Base message that maps 1:1 to API messages (role + content).
 * Additional metadata is stored in optional fields.
 */
export interface KernelMessage {
  uuid: string
  role: MessageRole
  content: ContentBlock[]

  // Optional metadata (not sent to API)
  isMeta?: boolean          // hidden from user UI, e.g. max_output_tokens recovery msgs
  isCompactSummary?: boolean // this is the compacted summary user message
  isInterruption?: boolean  // user interruption message
  /**
   * Mid-turn user steering correction (Ctrl+G). Sent to the API like a normal
   * user message, but compaction prefers the last NON-steering user message as
   * the verbatim task anchor so a late correction can't displace the task.
   */
  isSteering?: boolean
  /**
   * Text-only clone created by the compact keep-set builder
   * (cloneLastRealUserTextMessage / cloneSteeringTextMessage). The clone
   * preserves the user's words across a compaction but is NOT the original
   * message: goal capture (originalUserGoal) must skip it — otherwise, after a
   * resume, a mid-session request cloned by compaction #N would be mistaken
   * for the session's first user message.
   */
  isKeepSetClone?: boolean
  /**
   * For keep-set clones: the uuid of the original message this was cloned
   * from. Used by the compact continuity anchors to exclude content that the
   * keep-set already preserves verbatim (F-2 dedupe).
   */
  sourceUuid?: string

  // Usage for assistant messages (from API response)
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }

  // Stop reason for assistant messages
  stopReason?: string | null

  // For tool_result messages: which assistant message this came from
  sourceToolAssistantUUID?: string

  // Compact boundary marker (system messages)
  isCompactBoundary?: boolean

  // Sub-type for system messages
  systemSubtype?: 'compact_boundary' | 'api_retry' | 'warning' | 'info'
}

/** Create a minimal user message */
export function makeUserMessage(
  content: ContentBlock[],
  meta?: Partial<Pick<KernelMessage, 'isMeta' | 'isCompactSummary' | 'isInterruption' | 'isSteering' | 'sourceToolAssistantUUID'>>,
): KernelMessage {
  return {
    uuid: crypto.randomUUID(),
    role: 'user',
    content,
    ...meta,
  }
}

/** Create a minimal assistant message */
export function makeAssistantMessage(
  content: ContentBlock[],
  meta?: Partial<Pick<KernelMessage, 'usage' | 'stopReason'>>,
): KernelMessage {
  return {
    uuid: crypto.randomUUID(),
    role: 'assistant',
    content,
    ...meta,
  }
}

/** Compact boundary sentinel – treated as a system message in the loop */
export function makeCompactBoundaryMessage(): KernelMessage {
  return {
    uuid: crypto.randomUUID(),
    role: 'user',           // must have a role; we use user so API ignores it when sliced off
    content: [],
    isCompactBoundary: true,
    systemSubtype: 'compact_boundary',
  }
}
