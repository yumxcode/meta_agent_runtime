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
import type Anthropic from '@anthropic-ai/sdk';
import type { KernelMessage } from '../types/KernelMessage.js';
export type APIMessage = Anthropic.MessageParam;
/**
 * Convert KernelMessages to Anthropic API MessageParams.
 *
 * Rules:
 * - Skip compact boundary markers (isCompactBoundary) — they're metadata only
 * - Skip empty-content messages
 * - Merge consecutive same-role messages (required by Anthropic API)
 */
export declare function normalizeMessagesForAPI(messages: readonly KernelMessage[]): APIMessage[];
/** Remove provider/model-bound thinking blocks before cross-model fallback. */
export declare function stripThinkingBlocksFromMessages(messages: readonly KernelMessage[]): KernelMessage[];
/**
 * Get the slice of messages after the most recent compact boundary.
 * This is what gets sent to the API — the model only sees summary + recent context.
 */
export declare function getMessagesAfterCompactBoundary(messages: readonly KernelMessage[]): readonly KernelMessage[];
/**
 * Strip image and document content from messages before sending them to the
 * compact summarisation agent. Large blobs would cause PTL in the compact request.
 */
export declare function stripImagesFromMessages(messages: readonly KernelMessage[]): KernelMessage[];
//# sourceMappingURL=MessageNormalizer.d.ts.map