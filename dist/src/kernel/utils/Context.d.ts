/**
 * Context — model context window sizes and threshold calculations.
 * Mirrors CC's models.ts context window table and compactThreshold logic.
 */
export declare function getContextWindowSize(model: string): number;
export interface TokenWarningState {
    /** Context is at or above the autocompact trigger threshold */
    isAtCompactThreshold: boolean;
    /** Context is at or above the blocking limit (request will be rejected) */
    isAtBlockingLimit: boolean;
    autoCompactThreshold: number;
    blockingLimit: number;
    effectiveContextWindow: number;
}
export declare function calculateTokenWarningState(currentTokenCount: number, model: string, maxOutputTokens?: number): TokenWarningState;
export declare function isAutoCompactDisabled(): boolean;
export declare const ESCALATED_MAX_TOKENS = 64000;
export declare const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
//# sourceMappingURL=Context.d.ts.map