import type { KernelTool } from '../types/KernelTool.js';
import type { KernelConfig, ThinkingConfig } from '../types/KernelConfig.js';
import type { StreamEvent } from './AnthropicClient.js';
import type { DeepSeekMessage } from '../messages/DeepSeekMessageNormalizer.js';
export type ReasoningEffort = 'high' | 'max';
export interface DeepSeekStreamParams {
    model: string;
    sessionId?: string;
    messages: DeepSeekMessage[];
    tools: KernelTool[];
    thinkingConfig?: ThinkingConfig;
    maxOutputTokens?: number;
    abortSignal: AbortSignal;
}
/** Test/dispose hook — drop all cached DeepSeek clients. */
export declare function clearDeepSeekClientCache(): void;
/**
 * Stream messages from the DeepSeek API.
 * Yields Anthropic-compatible StreamEvents; caller processes them identically
 * to events from AnthropicClient.streamMessages.
 *
 * Retries on 429/5xx. Propagates PromptTooLongError on context overflow.
 */
export declare function streamDeepSeekMessages(params: DeepSeekStreamParams, config: Pick<KernelConfig, 'apiKey' | 'baseURL' | 'debug' | 'maxRetries'>, onRetry?: (attempt: number, maxRetries: number, delayMs: number, errorStatus: number | null) => void): AsyncGenerator<StreamEvent>;
//# sourceMappingURL=DeepSeekClient.d.ts.map