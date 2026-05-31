/**
 * FlashClient — unified wrapper for flash-model side-calls.
 *
 * Responsibilities:
 *   • Single Anthropic client instance per FlashClient (no per-call creation)
 *   • Hard timeout on every request (default 4 s)
 *   • In-memory result cache keyed by caller-supplied cacheKey
 *   • Returns null on timeout / network error — callers MUST implement fallback
 *
 * Provider resolution uses detectProvider() so the correct flash model is
 * selected regardless of whether the session uses Anthropic, DeepSeek, or Qwen.
 *
 * Usage:
 *   const flash = new FlashClient(config)
 *   const raw = await flash.query({ system: '...', user: '...', maxTokens: 200 })
 *   if (!raw) { // fallback }
 */
import type { MetaAgentConfig } from '../config.js';
export interface FlashQueryOpts {
    system: string;
    user: string;
    maxTokens: number;
    /** Hard timeout in ms. Default: 4000 */
    timeoutMs?: number;
    /**
     * When set, the result is cached in memory under this key.
     * Subsequent calls with the same key skip the network round-trip.
     * Use a content-hash so cache invalidates naturally when inputs change.
     */
    cacheKey?: string;
}
export declare class FlashClient {
    private readonly anthropicClient;
    private readonly openaiClient;
    private readonly model;
    private readonly cache;
    private static readonly MAX_CACHE_ENTRIES;
    constructor(config: Pick<MetaAgentConfig, 'apiKey' | 'baseURL' | 'model'>);
    /**
     * Send a one-shot flash-model query.
     *
     * Returns the model's text response, or null if:
     *   - The request timed out
     *   - A network/API error occurred
     *   - The model returned no text content
     *
     * Callers MUST handle null with a keyword-based or safe-default fallback.
     */
    query(opts: FlashQueryOpts): Promise<string | null>;
    /** Flush all cached results (call at session start or project switch). */
    clearCache(): void;
    private setCached;
    /** Current flash model identifier (useful for logging/debugging). */
    get modelId(): string;
}
//# sourceMappingURL=FlashClient.d.ts.map