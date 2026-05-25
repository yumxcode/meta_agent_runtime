/**
 * TokenCount — fast context size estimation without running a tokeniser.
 *
 * CC's tokenCountWithEstimation reads the most recent assistant message's
 * usage.inputTokens field (reported by the API), which is the most accurate
 * figure we have without calling the token-count API endpoint.
 *
 * Fallback: rough character-based estimate (1 token ≈ 4 chars).
 */
import type { KernelMessage } from '../types/KernelMessage.js';
/**
 * Estimate the total context size in tokens for a given message array.
 * Prefers the last assistant message's reported inputTokens.
 */
export declare function tokenCountWithEstimation(messages: readonly KernelMessage[]): number;
//# sourceMappingURL=TokenCount.d.ts.map