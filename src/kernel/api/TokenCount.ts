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

const CHARS_PER_TOKEN = 4

/**
 * Estimate the total context size in tokens for a given message array.
 * Prefers the last assistant message's reported usage, then adds content that
 * was appended after that response. This keeps compact/blocking checks aware of
 * large tool_result blocks that arrive after the API reported input tokens.
 */
export function tokenCountWithEstimation(messages: readonly KernelMessage[]): number {
  // Walk backwards to find the most recent assistant message with usage
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role === 'assistant' && msg.usage?.inputTokens) {
      return (
        msg.usage.inputTokens +
        msg.usage.outputTokens +
        roughTokenCount(messages.slice(i + 1))
      )
    }
  }

  // Fallback: rough char count
  return roughTokenCount(messages)
}

function roughTokenCount(messages: readonly KernelMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    for (const block of msg.content) {
      if ('text' in block && typeof block.text === 'string') {
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
            if (typeof inner === 'object' && inner && 'text' in inner) {
              chars += String((inner as Record<string, unknown>).text ?? '').length
            }
          }
        }
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}
