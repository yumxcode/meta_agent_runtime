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
import Anthropic from '@anthropic-ai/sdk';
import type { ConversationMessage } from '../types.js';
export declare function getCompactThreshold(model: string): number;
/**
 * Returns true if the current input token count exceeds the compact threshold
 * for the given model.
 */
export declare function shouldCompact(model: string, inputTokens: number): boolean;
export interface CompactResult {
    /** New conversation history (single user message with compact summary). */
    newMessages: ConversationMessage[];
    /** Raw compact summary text, for logging/debugging. */
    summaryText: string;
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
export declare function runCompact(client: Anthropic, model: string, currentMessages: readonly ConversationMessage[], sessionId: string, abortSignal?: AbortSignal): Promise<CompactResult>;
//# sourceMappingURL=autoCompact.d.ts.map