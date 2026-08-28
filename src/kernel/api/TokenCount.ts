/**
 * TokenCount — fast context size estimation without running a tokeniser.
 *
 * CC's tokenCountWithEstimation reads the most recent assistant message's
 * usage.inputTokens field (reported by the API), which is the most accurate
 * figure we have without calling the token-count API endpoint.
 *
 * Fallback: rough character-based estimate (1 token ≈ 4 chars).
 */
import type { KernelMessage } from '../types/KernelMessage.js'
import { getVisionLimits, DEFAULT_VISION_LIMITS } from '../../providers/registry.js'

const CHARS_PER_TOKEN = 4

/**
 * Estimate the total context size in tokens for a given message array.
 * Prefers the last assistant message's reported usage, then adds content that
 * was appended after that response. This keeps compact/blocking checks aware of
 * large tool_result blocks that arrive after the API reported input tokens.
 */
export function tokenCountWithEstimation(
  messages: readonly KernelMessage[],
  /** Sizes image blocks correctly; falls back to a conservative ceiling. */
  model?: string,
): number {
  const imageTokens = model
    ? getVisionLimits(model).imageTokenCeiling
    : DEFAULT_VISION_LIMITS.imageTokenCeiling

  // Walk backwards to find the most recent assistant message with usage
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role === 'assistant' && msg.usage?.inputTokens) {
      return (
        msg.usage.inputTokens +
        msg.usage.outputTokens +
        roughTokenCount(messages.slice(i + 1), imageTokens)
      )
    }
  }

  // Fallback: rough char count
  return roughTokenCount(messages, imageTokens)
}

/**
 * Images cost a flat per-image budget, not a per-character one.
 *
 * Two wrong answers are available here and this function used to give the
 * second. Estimating from the base64 string (chars/4) inflates a 1 MB
 * attachment to roughly 350k tokens and would trip compaction on the first
 * image. Skipping image blocks entirely — which is what the original
 * `'text' in block` chain did, since an image block has none of text/thinking/
 * input/content — charges them ZERO, so a transcript full of screenshots sails
 * past the compaction threshold and hits the model's hard context limit
 * instead. Providers scale every image to a fixed budget before inference, so
 * the flat ceiling is both the cheapest estimate and the accurate one.
 */
function roughTokenCount(messages: readonly KernelMessage[], imageTokens: number): number {
  let chars = 0
  let images = 0
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'image') {
        images++
      } else if ('text' in block && typeof block.text === 'string') {
        chars += block.text.length
      } else if ('thinking' in block && typeof block.thinking === 'string') {
        chars += block.thinking.length
      } else if ('input' in block) {
        chars += JSON.stringify((block as unknown as { input: unknown }).input ?? {}).length
      } else if ('content' in block) {
        const c = (block as unknown as { content: unknown }).content
        if (typeof c === 'string') chars += c.length
        else if (Array.isArray(c)) {
          for (const inner of c) {
            if (typeof inner !== 'object' || inner === null) continue
            const innerBlock = inner as Record<string, unknown>
            // Tool results carry images too — a screenshot returned by a tool
            // costs exactly what an attached one does.
            if (innerBlock['type'] === 'image') images++
            else if ('text' in innerBlock) chars += String(innerBlock['text'] ?? '').length
          }
        }
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * imageTokens
}
