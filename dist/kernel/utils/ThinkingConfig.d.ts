/**
 * ThinkingConfig helpers — mirrors CC's thinking.ts
 */
import type { ThinkingConfig } from '../types/KernelConfig.js';
/**
 * Build the `thinking` parameter to pass to the Anthropic API.
 * Returns undefined for disabled, or the appropriate object for enabled/adaptive.
 */
export declare function buildThinkingParam(config: ThinkingConfig | undefined): {
    type: 'enabled';
    budget_tokens: number;
} | undefined;
/**
 * Whether the current thinking config allows thinking blocks in messages.
 * Used to decide whether to strip thinking blocks before sending to API.
 */
export declare function isThinkingEnabled(config: ThinkingConfig | undefined): boolean;
/**
 * Thinking blocks in messages bind to the model that generated them.
 * When switching models (fallback), messages with thinking blocks should be
 * tombstoned to avoid API errors.
 */
export declare function messageHasThinkingBlocks(content: Array<{
    type: string;
}>): boolean;
//# sourceMappingURL=ThinkingConfig.d.ts.map