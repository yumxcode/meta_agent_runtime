/**
 * ThinkingConfig helpers — mirrors CC's thinking.ts
 */
import type { ThinkingConfig } from '../types/KernelConfig.js'

const DEFAULT_THINKING_BUDGET = 16_000

/**
 * Build the `thinking` parameter to pass to the Anthropic API.
 * Returns undefined for disabled, or the appropriate object for enabled/adaptive.
 */
export function buildThinkingParam(
  config: ThinkingConfig | undefined,
): { type: 'enabled'; budget_tokens: number } | undefined {
  if (!config || config.type === 'disabled') return undefined
  if (config.type === 'enabled') {
    return { type: 'enabled', budget_tokens: config.budgetTokens }
  }
  // 'adaptive' — use the default budget
  return { type: 'enabled', budget_tokens: DEFAULT_THINKING_BUDGET }
}

/**
 * Whether the current thinking config allows thinking blocks in messages.
 * Used to decide whether to strip thinking blocks before sending to API.
 */
export function isThinkingEnabled(config: ThinkingConfig | undefined): boolean {
  if (!config || config.type === 'disabled') return false
  return true
}

/**
 * Thinking blocks in messages bind to the model that generated them.
 * When switching models (fallback), messages with thinking blocks should be
 * tombstoned to avoid API errors.
 */
export function messageHasThinkingBlocks(content: Array<{ type: string }>): boolean {
  return content.some(b => b.type === 'thinking' || b.type === 'redacted_thinking')
}
