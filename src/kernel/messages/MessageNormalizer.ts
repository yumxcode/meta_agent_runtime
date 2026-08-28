/**
 * MessageNormalizer — prepare KernelMessages for the Anthropic API.
 *
 * CC's normalizeMessagesForAPI does two main things:
 * 1. Convert internal KernelMessage format → Anthropic MessageParam format
 * 2. Apply "message coalescing" rules required by the API:
 *    - Consecutive messages with the same role must be merged
 *    - The first message must be a user message
 *
 * We also filter out any "system" pseudo-messages (compact boundary markers, etc.)
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { KernelMessage, ContentBlock } from '../types/KernelMessage.js'

export type APIMessage = Anthropic.MessageParam

/**
 * Convert a KernelMessage's content to Anthropic API content format.
 * Thinking/redacted_thinking blocks are passed through as-is (the SDK accepts them).
 */
function toAPIContent(content: ContentBlock[]): Anthropic.ContentBlockParam[] {
  return content as Anthropic.ContentBlockParam[]
}

/**
 * Convert KernelMessages to Anthropic API MessageParams.
 *
 * Rules:
 * - Skip compact boundary markers (isCompactBoundary) — they're metadata only
 * - Skip empty-content messages
 * - Merge consecutive same-role messages (required by Anthropic API)
 */
export function normalizeMessagesForAPI(messages: readonly KernelMessage[]): APIMessage[] {
  const filtered = messages.filter(
    m => !m.isCompactBoundary && m.content.length > 0,
  )

  if (filtered.length === 0) return []

  // Merge consecutive same-role messages.
  // IMPORTANT: always create new content arrays — never push into the existing
  // array in-place. The same KernelMessage objects persist in mutableMessages
  // across turns; mutating msg.content would cause duplicate tool_result blocks
  // on subsequent normalizeMessagesForAPI calls.
  const merged: APIMessage[] = []
  for (const msg of filtered) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) {
      const prev = last.content
      const next = toAPIContent(msg.content)
      merged[merged.length - 1] = {
        role: last.role,
        content: Array.isArray(prev)
          ? [...(prev as Anthropic.ContentBlockParam[]), ...next]
          : [{ type: 'text', text: prev as string }, ...next],
      }
    } else {
      // Shallow-copy so later merges don't mutate the original KernelMessage
      merged.push({ role: msg.role, content: [...toAPIContent(msg.content)] })
    }
  }

  // API requires first message to be user
  if (merged.length > 0 && merged[0]!.role !== 'user') {
    merged.unshift({ role: 'user', content: [{ type: 'text', text: '' }] })
  }

  return merged
}

/**
 * Keep only the most recent `retain` images at full fidelity.
 *
 * Images are pure input cost. They are not covered by prefix caching, they are
 * never elided by the text-oriented truncation in StructuralTruncate, and they
 * carry a flat per-image token charge that does not shrink with age — so a long
 * session accumulates a floor of cost from screenshots nobody is looking at any
 * more. The placeholder keeps the fact that an image WAS there, which is what
 * later turns actually reference ("the error in that screenshot").
 *
 * Counted in images rather than turns because the charge is per image: N turns
 * could mean one attachment or thirty.
 *
 * Identity when nothing would be dropped, so short sessions pay nothing.
 */
export function applyImageRetention(
  messages: readonly KernelMessage[],
  retain: number,
): readonly KernelMessage[] {
  if (retain < 0) return messages

  let total = 0
  for (const msg of messages) total += countImages(msg.content)
  if (total <= retain) return messages

  // Walk backwards so "most recent" is decided before anything is rewritten.
  let budget = retain
  const rewritten: KernelMessage[] = new Array(messages.length)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    const count = countImages(msg.content)
    if (count === 0) {
      rewritten[i] = msg
      continue
    }
    if (count <= budget) {
      budget -= count
      rewritten[i] = msg
      continue
    }
    const keepInThisMessage = budget
    budget = 0
    rewritten[i] = { ...msg, content: retainWithin(msg.content, keepInThisMessage) }
  }
  return rewritten
}

function countImages(content: readonly ContentBlock[]): number {
  let n = 0
  for (const block of content) {
    if (block.type === 'image') n++
    else if (block.type === 'tool_result' && Array.isArray(block.content)) {
      n += countImages(block.content as ContentBlock[])
    }
  }
  return n
}

/**
 * Keep the LAST `keep` images within one message, aging out the rest.
 * Applied back-to-front for the same reason as the outer walk.
 */
function retainWithin(content: readonly ContentBlock[], keep: number): ContentBlock[] {
  let budget = keep
  const out: ContentBlock[] = new Array(content.length)
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i]!
    if (block.type === 'image') {
      if (budget > 0) {
        budget--
        out[i] = block
      } else {
        out[i] = { type: 'text', text: '[image aged out of context]' }
      }
      continue
    }
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const inner = block.content as ContentBlock[]
      const innerCount = countImages(inner)
      if (innerCount === 0) { out[i] = block; continue }
      const keepInner = Math.min(budget, innerCount)
      budget -= keepInner
      out[i] = { ...block, content: retainWithin(inner, keepInner) } as ContentBlock
      continue
    }
    out[i] = block
  }
  return out
}

/**
 * Replace image blocks with text placeholders when the target model has no
 * vision capability.
 *
 * This is a second line of defence, not the primary gate — attachments are
 * rejected at the entry point with a message naming the model. It exists
 * because the model can change MID-SESSION (`/model`, availability fallback,
 * the flash side-call path) while the transcript keeps every image that earlier
 * turns attached. Without this, one `/model` to a text-only model turns every
 * subsequent turn of that session into a 400 whose text blames the request in
 * flight rather than the switch that caused it.
 *
 * Identity when `supportsVision` is true, so the vision path pays nothing.
 */
export function downgradeImagesForModel(
  messages: readonly KernelMessage[],
  supportsVision: boolean,
): readonly KernelMessage[] {
  if (supportsVision) return messages
  if (!messages.some(hasImageContent)) return messages
  return messages.map(msg =>
    hasImageContent(msg) ? { ...msg, content: msg.content.map(downgradeBlock) } : msg,
  )
}

function hasImageContent(message: KernelMessage): boolean {
  return message.content.some(block =>
    block.type === 'image' ||
    (block.type === 'tool_result' && Array.isArray(block.content) &&
      (block.content as ContentBlock[]).some(inner => inner.type === 'image')),
  )
}

function downgradeBlock(block: ContentBlock): ContentBlock {
  if (block.type === 'image') {
    return { type: 'text', text: '[image omitted — the active model has no vision support]' }
  }
  if (block.type === 'tool_result' && Array.isArray(block.content)) {
    return {
      ...block,
      content: (block.content as ContentBlock[]).map(downgradeBlock),
    } as ContentBlock
  }
  return block
}

/** Remove provider/model-bound thinking blocks before cross-model fallback. */
export function stripThinkingBlocksFromMessages(messages: readonly KernelMessage[]): KernelMessage[] {
  return messages.map(msg => ({
    ...msg,
    content: msg.content.filter(block =>
      block.type !== 'thinking' && block.type !== 'redacted_thinking',
    ),
  }))
}

/**
 * Get the slice of messages after the most recent compact boundary.
 * This is what gets sent to the API — the model only sees summary + recent context.
 */
export function getMessagesAfterCompactBoundary(messages: readonly KernelMessage[]): readonly KernelMessage[] {
  let boundaryIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.isCompactBoundary) {
      boundaryIdx = i
      break
    }
  }
  if (boundaryIdx === -1) return messages
  return messages.slice(boundaryIdx) // include the boundary itself for slicing context
}

/**
 * Strip image and document content from messages before sending them to the
 * compact summarisation agent. Large blobs would cause PTL in the compact request.
 */
export function stripImagesFromMessages(messages: readonly KernelMessage[]): KernelMessage[] {
  return messages.map(msg => {
    const strippedContent = msg.content.map(block => {
      if (block.type === 'image') {
        return { type: 'text', text: '[image]' } as ContentBlock
      }
      // tool_result can contain images inside its content array
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        return {
          ...block,
          content: (block.content as ContentBlock[]).map(inner =>
            inner.type === 'image' ? ({ type: 'text', text: '[image]' } as ContentBlock) : inner,
          ),
        } as ContentBlock
      }
      return block
    })
    return { ...msg, content: strippedContent }
  })
}
