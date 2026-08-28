/**
 * DeepSeekMessageNormalizer — convert KernelMessages to OpenAI (DeepSeek) API format.
 *
 * Key differences from Anthropic format:
 * - tool_result blocks become separate { role: 'tool', tool_call_id, content } messages
 * - tool_use blocks become tool_calls: [...] on assistant messages
 * - thinking blocks become reasoning_content field on assistant messages
 * - System prompt is prepended as { role: 'system', content } message (not a separate param)
 * - image blocks become { type: 'image_url', image_url: { url } } content parts
 *
 * Per DeepSeek docs:
 *   - When no tool calls: reasoning_content is ignored by the API on echo-back
 *   - When tool calls present: reasoning_content MUST be echoed back
 *   - For safety we always include reasoning_content when present
 */
import type { KernelMessage, ContentBlock, ImageBlock } from '../types/KernelMessage.js'
import { imageBlockToDataUrl, isImageBlock } from './imageBlocks.js'

// ── DeepSeek / OpenAI-compatible message types ────────────────────────────────

/** Detail level for an image. Unset means the provider default (`original`). */
export type DeepSeekImageDetail = 'low' | 'high' | 'original' | 'auto'

export type DeepSeekContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: DeepSeekImageDetail } }

export interface DeepSeekSystemMessage {
  role: 'system'
  content: string
}

export interface DeepSeekUserMessage {
  role: 'user'
  /**
   * String when the message is text-only, which is the overwhelming majority.
   * The array form exists only to carry images and is used ONLY when one is
   * present — sending every message as a one-element array would rewrite the
   * entire request shape for no gain and put a well-tested path at risk.
   */
  content: string | DeepSeekContentPart[]
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

/** Placeholder left in a `tool` message whose real payload is an image. */
const TOOL_IMAGE_PLACEHOLDER = '[image returned; see the following user message]'

/** Placeholder for an image that cannot legally occupy its position. */
const ILLEGAL_POSITION_PLACEHOLDER = '[image omitted]'

/**
 * Convert KernelMessages + optional systemPrompt to DeepSeek / OpenAI format.
 *
 * Conversion rules:
 *   assistant.thinking   → reasoning_content (always echoed)
 *   assistant.text       → content
 *   assistant.tool_use   → tool_calls: [{ id, type, function }]
 *   assistant.image      → '[image omitted]' text (illegal outside user messages)
 *   user.text            → { role: 'user', content: text }
 *   user.image           → { role: 'user', content: [{ type: 'image_url', … }] }
 *   user.tool_result     → { role: 'tool', tool_call_id, content }
 *   tool_result.image    → deferred into a trailing user message (see below)
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
      const pending: DeepSeekContentPart[] = []
      /**
       * Images pulled out of tool_result blocks, held until every `tool`
       * message of this turn has been emitted.
       *
       * Two constraints collide here. A `tool` message's content is a plain
       * string, so it cannot carry an image; and DeepSeek rejects images
       * anywhere but a `user` message. Emitting the image right after its own
       * tool message would satisfy both but split the run of tool replies that
       * OpenAI requires to follow their assistant's tool_calls contiguously.
       * Deferring to one trailing user message satisfies all three, and the
       * tool_call_id in the caption keeps the image attributable.
       */
      const deferredToolImages: Array<{ toolCallId: string; block: ImageBlock }> = []

      const flushPending = (): void => {
        if (pending.length === 0) return
        result.push({ role: 'user', content: collapseParts(pending) })
        pending.length = 0
      }

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          // Flush any pending text/images as a user message before tool results
          flushPending()
          const { text, images } = splitToolResultContent(block.content)
          for (const image of images) {
            deferredToolImages.push({ toolCallId: block.tool_use_id, block: image })
          }
          result.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: text || (images.length > 0 ? TOOL_IMAGE_PLACEHOLDER : ''),
          })
        } else if (block.type === 'text') {
          pending.push({ type: 'text', text: block.text })
        } else if (isImageBlock(block)) {
          pending.push(toImagePart(block))
        }
      }

      flushPending()

      if (deferredToolImages.length > 0) {
        const parts: DeepSeekContentPart[] = []
        for (const { toolCallId, block } of deferredToolImages) {
          parts.push({ type: 'text', text: `Image returned by tool call ${toolCallId}:` })
          parts.push(toImagePart(block))
        }
        result.push({ role: 'user', content: parts })
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
          case 'image':
            // DeepSeek returns 400 for an image on an assistant message. This
            // is not defensive coding for an impossible state: the model never
            // emits images, but a caller replaying a transcript from another
            // provider can, and a silent 400 would be blamed on the request
            // that happened to be in flight.
            text += ILLEGAL_POSITION_PLACEHOLDER
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

function toImagePart(block: ImageBlock): DeepSeekContentPart {
  return { type: 'image_url', image_url: { url: imageBlockToDataUrl(block) } }
}

/**
 * Text-only part lists collapse back to a plain string.
 *
 * Keeps the wire format identical to what it was before images existed for
 * every request that carries none, so the array form is observable only when it
 * is actually needed.
 */
function collapseParts(parts: DeepSeekContentPart[]): string | DeepSeekContentPart[] {
  if (parts.some(p => p.type === 'image_url')) return [...parts]
  return parts.map(p => (p.type === 'text' ? p.text : '')).join('')
}

type ToolResultContent = string | Array<{ type: string; text?: string }> | undefined

interface SplitToolResult {
  text: string
  images: ImageBlock[]
}

function splitToolResultContent(raw: ToolResultContent): SplitToolResult {
  if (typeof raw === 'string') return { text: raw, images: [] }
  if (!Array.isArray(raw)) return { text: '', images: [] }

  const textParts: string[] = []
  const images: ImageBlock[] = []
  for (const part of raw as ContentBlock[]) {
    if (part.type === 'text' && typeof part.text === 'string') {
      textParts.push(part.text)
    } else if (isImageBlock(part)) {
      images.push(part)
    }
  }
  return { text: textParts.join(''), images }
}
