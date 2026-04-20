/**
 * Retry utilities with jittered exponential backoff.
 */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  /** Return true to stop retrying regardless of remaining attempts. */
  shouldStop?: (error: Error, attempt: number) => boolean;
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1_000,
    maxDelayMs = 60_000,
    jitter = true,
    shouldStop,
    onRetry,
  } = opts;

  let lastError: Error = new Error('Unknown error');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxAttempts) break;
      if (shouldStop?.(lastError, attempt)) break;

      const exponential = baseDelayMs * Math.pow(2, attempt - 1);
      let delay = Math.min(exponential, maxDelayMs);
      if (jitter) delay = delay * (0.5 + Math.random() * 0.5);

      onRetry?.(lastError, attempt, delay);
      await sleep(delay);
    }
  }

  throw lastError;
}

/** Classify whether an error should trigger a fallback provider switch. */
export function isRetryableError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('overloaded') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('network')
  );
}

export function isFatalError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('invalid api key') ||
    msg.includes('authentication')
  );
}
