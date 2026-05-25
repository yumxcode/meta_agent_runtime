/**
 * TokenUsage — mirrors CC's NonNullableUsage, covers all token counters
 * that Anthropic API returns per message.
 */
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}
export declare function emptyUsage(): TokenUsage;
export declare function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage;
//# sourceMappingURL=TokenUsage.d.ts.map