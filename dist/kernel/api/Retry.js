/**
 * Retry — exponential back-off retry for transient API errors.
 * Mirrors CC's withRetry.ts.
 */
import { isRetryableError } from './Errors.js';
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
function getErrorStatus(error) {
    if (error && typeof error === 'object' && 'status' in error) {
        const s = error.status;
        if (typeof s === 'number')
            return s;
    }
    return null;
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
export async function withRetry(fn, options = {}) {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const initialDelay = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    const maxDelay = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        }
        catch (error) {
            if (!isRetryableError(error) || attempt >= maxRetries) {
                throw error;
            }
            attempt++;
            // Exponential backoff with jitter
            const base = Math.min(initialDelay * 2 ** (attempt - 1), maxDelay);
            const jitter = Math.random() * 0.25 * base;
            const delayMs = Math.floor(base + jitter);
            options.onRetry?.(attempt, maxRetries, delayMs, getErrorStatus(error));
            await sleep(delayMs);
        }
    }
}
//# sourceMappingURL=Retry.js.map