/**
 * Auto-compact for MetaAgentSession
 *
 * Monitors input token usage after each API response.  When the context
 * approaches the model's limit, compacts the conversation history into a
 * structured summary and replaces mutableMessages with a single user message
 * containing that summary.
 *
 * Compact trigger: input_tokens > contextWindow * 0.80 - maxOutputTokens
 *
 * After compaction:
 *   - mutableMessages is replaced with a single user message (the compact summary)
 *   - The session's SectionRegistry is invalidated so dynamic sections regenerate
 *   - The agentic loop continues normally on the next iteration
 */

import Anthropic from '@anthropic-ai/sdk'
import type { ConversationMessage } from '../types.js'
import {
  getMetaAgentCompactPrompt,
  formatCompactSummary,
} from './compactPrompt.js'

// ─────────────────────────────────────────────────────────────────────────────
// Context window sizes by model
// ─────────────────────────────────────────────────────────────────────────────

const CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  'claude-opus-4-6':           200_000,
  'claude-sonnet-4-6':         200_000,
  'claude-haiku-4-5-20251001': 200_000,
  // DeepSeek — 128K context (verified 2025-05; api.deepseek.com/anthropic)
  'deepseek-chat':             128_000,
  'deepseek-reasoner':         128_000,
  // Qwen
  'qwen-max':                  32_000,
  'qwen-plus':                 131_072,
  'qwen-turbo':                131_072,
  // GLM
  'glm-4':                     128_000,
  'glm-4-flash':               128_000,
}

const DEFAULT_CONTEXT_WINDOW  = 100_000
/** Reserve this many tokens for the compact summary output itself. */
const COMPACT_MAX_OUTPUT       = 20_000
/** Trigger compaction this many tokens before the hard limit. */
const COMPACT_BUFFER           = 10_000

// ─────────────────────────────────────────────────────────────────────────────
// Threshold calculation
// ─────────────────────────────────────────────────────────────────────────────

export function getCompactThreshold(model: string): number {
  const window = CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW
  return window - COMPACT_MAX_OUTPUT - COMPACT_BUFFER
}

/**
 * Returns true if the current input token count exceeds the compact threshold
 * for the given model.
 */
export function shouldCompact(model: string, inputTokens: number): boolean {
  return inputTokens >= getCompactThreshold(model)
}

// ─────────────────────────────────────────────────────────────────────────────
// Compact execution
// ─────────────────────────────────────────────────────────────────────────────

export interface CompactResult {
  /** New conversation history (single user message with compact summary). */
  newMessages: ConversationMessage[]
  /** Raw compact summary text, for logging/debugging. */
  summaryText: string
}

/**
 * Run a compact pass over the current conversation history.
 *
 * Calls the API synchronously (no streaming needed — we just want the text).
 * Returns new messages that replace the full conversation history.
 *
 * On failure (API error, malformed output) throws — callers should catch and
 * decide whether to continue without compacting or abort.
 */
export async function runCompact(
  client: Anthropic,
  model: string,
  currentMessages: readonly ConversationMessage[],
  sessionId: string,
  abortSignal?: AbortSignal,
): Promise<CompactResult> {
  const compactPrompt = getMetaAgentCompactPrompt()

  // Convert internal message format to Anthropic API format
  const apiMessages = buildApiMessages(currentMessages)

  const response = await client.messages.create(
    {
      model,
      max_tokens: COMPACT_MAX_OUTPUT,
      // System prompt is the compact task — no tools allowed
      system: compactPrompt,
      messages: apiMessages,
    },
    { signal: abortSignal },
  )

  const rawText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')

  if (!rawText.trim()) {
    throw new Error('Compact call returned empty response')
  }

  const formatted = formatCompactSummary(rawText)

  const summaryMessage =
    `This session was compacted to manage context length. ` +
    `The summary below covers the earlier portion of the conversation.\n\n` +
    formatted + '\n\n' +
    `Continue the conversation from where it left off. ` +
    `Do not acknowledge the compaction or recap what happened — resume directly.`

  const newMessages: ConversationMessage[] = [
    { role: 'user', content: summaryMessage },
  ]

  return { newMessages, summaryText: formatted }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildApiMessages(
  messages: readonly ConversationMessage[],
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content })
      } else {
        const blocks: Anthropic.ToolResultBlockParam[] = msg.content
          .filter(
            (b): b is { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean } =>
              b.type === 'tool_result',
          )
          .map(b => ({
            type: 'tool_result' as const,
            tool_use_id: b.tool_use_id,
            content: b.content,
            ...(b.is_error ? { is_error: true } : {}),
          }))
        if (blocks.length > 0) {
          result.push({ role: 'user', content: blocks })
        }
      }
    } else {
      const blocks = msg.content.map(b => {
        if (b.type === 'text')     return { type: 'text' as const, text: b.text }
        if (b.type === 'tool_use') return { type: 'tool_use' as const, id: b.id, name: b.name, input: b.input }
        return { type: 'text' as const, text: JSON.stringify(b) }
      }) as Anthropic.ContentBlock[]
      result.push({ role: 'assistant', content: blocks })
    }
  }

  return result
}
