/**
 * DeepSeekMessageNormalizer — convert KernelMessages to OpenAI (DeepSeek) API format.
 *
 * Key differences from Anthropic format:
 * - tool_result blocks become separate { role: 'tool', tool_call_id, content } messages
 * - tool_use blocks become tool_calls: [...] on assistant messages
 * - thinking blocks become reasoning_content field on assistant messages
 * - System prompt is prepended as { role: 'system', content } message (not a separate param)
 *
 * Per DeepSeek docs:
 *   - When no tool calls: reasoning_content is ignored by the API on echo-back
 *   - When tool calls present: reasoning_content MUST be echoed back
 *   - For safety we always include reasoning_content when present
 */
import type { KernelMessage } from '../types/KernelMessage.js'

// ── DeepSeek / OpenAI-compatible message types ────────────────────────────────

export interface DeepSeekSystemMessage {
  role: 'system'
  content: string
}

export interface DeepSeekUserMessage {
  role: 'user'
  content: string
}

export interface DeepSeekToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface DeepSeekAssistantMessage {
  role: 'assistant'
  content: string | null
  /** DeepSeek thinking mode: echoed back when tool calls were present */
  reasoning_content?: string
  tool_calls?: DeepSeekToolCall[]
}

export interface DeepSeekToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

export type DeepSeekMessage =
  | DeepSeekSystemMessage
  | DeepSeekUserMessage
  | DeepSeekAssistantMessage
  | DeepSeekToolMessage

// ── Normalizer ────────────────────────────────────────────────────────────────

/**
 * Convert KernelMessages + optional systemPrompt to DeepSeek / OpenAI format.
 *
 * Conversion rules:
 *   assistant.thinking   → reasoning_content (always echoed)
 *   assistant.text       → content
 *   assistant.tool_use   → tool_calls: [{ id, type, function }]
 *   user.text            → { role: 'user', content: text }
 *   user.tool_result     → { role: 'tool', tool_call_id, content }
 *   user.image           → skipped (no text equivalent)
 *   compact_boundary     → skipped
 */
export function normalizeMessagesForDeepSeek(
  messages: readonly KernelMessage[],
  systemPrompt?: string,
): DeepSeekMessage[] {
  const result: DeepSeekMessage[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (msg.isCompactBoundary || msg.content.length === 0) continue

    if (msg.role === 'user') {
      const pendingText: string[] = []

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          // Flush any pending text as a user message before tool results
          if (pendingText.length > 0) {
            result.push({ role: 'user', content: pendingText.join('') })
            pendingText.length = 0
          }
          // Each tool_result becomes its own 'tool' message
          const content = toolResultContent(block.content)
          result.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content,
          })
        } else if (block.type === 'text') {
          pendingText.push(block.text)
        }
        // Silently skip image blocks — no text mapping available
      }

      if (pendingText.length > 0) {
        result.push({ role: 'user', content: pendingText.join('') })
      }
    } else {
      // assistant message
      let reasoning = ''
      let text = ''
      const toolCalls: DeepSeekToolCall[] = []

      for (const block of msg.content) {
        switch (block.type) {
          case 'thinking':
            reasoning += block.thinking
            break
          case 'text':
            text += block.text
            break
          case 'tool_use':
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            })
            break
          // redacted_thinking → skip (no DeepSeek equivalent)
        }
      }

      // OpenAI/DeepSeek require an assistant message to carry `content` or
      // `tool_calls`; a turn with neither is rejected with
      //   400 Invalid assistant message: content or tool_calls must be set
      // This happens when a turn is interrupted (Ctrl+C) mid-thinking: the
      // committed assistant message holds ONLY a thinking block, so text is ''
      // and there are no tool_calls. Per DeepSeek's contract reasoning_content
      // is ignored on echo-back unless tool_calls are present, so such a turn
      // carries nothing actionable — skip it instead of emitting an invalid
      // (content: null, no tool_calls) message that poisons every later turn.
      if (!text && toolCalls.length === 0) continue

      const assistantMsg: DeepSeekAssistantMessage = {
        role: 'assistant',
        content: text || null,
      }
      if (reasoning) {
        assistantMsg.reasoning_content = reasoning
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      result.push(assistantMsg)
    }
  }

  // OpenAI API requires the first message to be 'system' or 'user', not 'tool'
  const firstNonSystem = result.find(m => m.role !== 'system')
  if (firstNonSystem && firstNonSystem.role === 'tool') {
    const sysIdx = result.findIndex(m => m.role === 'system')
    result.splice(sysIdx + 1, 0, { role: 'user', content: '' })
  }

  return result
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type ToolResultContent = string | Array<{ type: string; text?: string }> | undefined

function toolResultContent(raw: ToolResultContent): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text!)
      .join('')
  }
  return ''
}
