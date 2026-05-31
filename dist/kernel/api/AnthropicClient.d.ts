/**
 * AnthropicClient — streaming API wrapper.
 * Mirrors CC's claude.ts / queryModelWithStreaming.
 *
 * Key responsibilities:
 * - Build the request parameters (model, tokens, thinking, tools, system)
 * - Stream events from the SDK
 * - Emit api_retry events on retries
 * - Convert stop_reason to our domain types
 */
import Anthropic from '@anthropic-ai/sdk';
import type { KernelTool } from '../types/KernelTool.js';
import type { KernelConfig, ThinkingConfig } from '../types/KernelConfig.js';
import type { APIMessage } from '../messages/MessageNormalizer.js';
export type StreamEvent = {
    type: 'message_start';
    usage: {
        input_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
} | {
    type: 'content_block_start';
    index: number;
    content_block: Anthropic.ContentBlock;
} | {
    type: 'content_block_delta';
    index: number;
    delta: Anthropic.RawContentBlockDelta;
} | {
    type: 'content_block_stop';
    index: number;
} | {
    type: 'message_delta';
    delta: {
        stop_reason: string | null;
        stop_sequence: string | null;
    };
    usage: {
        output_tokens: number;
    };
} | {
    type: 'message_stop';
};
export interface StreamParams {
    model: string;
    sessionId?: string;
    messages: APIMessage[];
    systemPrompt?: string;
    tools: KernelTool[];
    thinkingConfig?: ThinkingConfig;
    maxOutputTokens?: number;
    abortSignal: AbortSignal;
    /**
     * Additional Anthropic beta feature flags to include in the request.
     * Merged with the default 'interleaved-thinking-2025-05-14' beta.
     * Example: ['token-efficient-tools-2025-02-19']
     */
    betas?: string[];
    /** Whether to include kernel default beta headers. Default: true. */
    includeDefaultBetas?: boolean;
}
/** Test/dispose hook — drop all cached SDK clients. */
export declare function clearAnthropicClientCache(): void;
/**
 * Stream messages from the Anthropic API.
 * Yields raw SDK stream events; the caller is responsible for reconstructing
 * assistant messages from these events.
 *
 * Retries automatically on 429/5xx.
 * Propagates PromptTooLongError on 400 PTL.
 * Propagates FallbackTriggeredError when the model cannot handle the request.
 */
export declare function streamMessages(params: StreamParams, config: Pick<KernelConfig, 'apiKey' | 'baseURL' | 'debug' | 'maxRetries'>, onRetry?: (attempt: number, maxRetries: number, delayMs: number, errorStatus: number | null) => void): AsyncGenerator<StreamEvent>;
//# sourceMappingURL=AnthropicClient.d.ts.map