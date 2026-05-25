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
import type { KernelMessage } from '../types/KernelMessage.js';
export interface DeepSeekSystemMessage {
    role: 'system';
    content: string;
}
export interface DeepSeekUserMessage {
    role: 'user';
    content: string;
}
export interface DeepSeekToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
export interface DeepSeekAssistantMessage {
    role: 'assistant';
    content: string | null;
    /** DeepSeek thinking mode: echoed back when tool calls were present */
    reasoning_content?: string;
    tool_calls?: DeepSeekToolCall[];
}
export interface DeepSeekToolMessage {
    role: 'tool';
    tool_call_id: string;
    content: string;
}
export type DeepSeekMessage = DeepSeekSystemMessage | DeepSeekUserMessage | DeepSeekAssistantMessage | DeepSeekToolMessage;
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
export declare function normalizeMessagesForDeepSeek(messages: readonly KernelMessage[], systemPrompt?: string): DeepSeekMessage[];
//# sourceMappingURL=DeepSeekMessageNormalizer.d.ts.map