/**
 * Errors — error classification for the streaming API.
 * Mirrors CC's errors.ts / errorUtils.ts.
 */
/** Thrown when the API returns a prompt-too-long (context overflow) error */
export declare class PromptTooLongError extends Error {
    constructor(message?: string);
}
/** Thrown when the model signals a fallback (e.g. thinking quota exceeded on this model) */
export declare class FallbackTriggeredError extends Error {
    constructor(message?: string);
}
/** Thrown when the request is aborted via AbortSignal */
export declare class AbortError extends Error {
    constructor(message?: string);
}
export declare function isPromptTooLongError(error: unknown): boolean;
export declare function isMaxOutputTokensStopReason(stopReason: string | null | undefined): boolean;
export declare function isOverloadedError(error: unknown): boolean;
export declare function isRateLimitError(error: unknown): boolean;
export declare function isRetryableError(error: unknown): boolean;
/**
 * Detect whether an API error should trigger a model fallback.
 * Mirrors CC's isFallbackError() — covers cases where the primary model
 * is unable to handle the request (e.g. thinking feature not available,
 * model-specific capability limits, or explicit model-unavailable errors).
 */
export declare function isFallbackTriggeredError(error: unknown): boolean;
export declare const PROMPT_TOO_LONG_ERROR_MESSAGE: string;
//# sourceMappingURL=Errors.d.ts.map