/**
 * Retry — exponential back-off retry for transient API errors.
 * Mirrors CC's withRetry.ts.
 */
import { isRetryableError } from './Errors.js'

export interface RetryOptions {
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
  onRetry?: (attempt: number, maxRetries: number, delayMs: number, errorStatus: number | null) => void
}

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_INITIAL_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 30_000

function getErrorStatus(error: unknown): number | null {
  if (error && typeof error === 'object' && 'status' in error) {
    const s = (error as Record<string, unknown>).status
    if (typeof s === 'number') return s
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const initialDelay = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelay = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS

  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (error) {
      if (!isRetryableError(error) || attempt >= maxRetries) {
        throw error
      }
      attempt++
      // Exponential backoff with jitter
      const base = Math.min(initialDelay * 2 ** (attempt - 1), maxDelay)
      const jitter = Math.random() * 0.25 * base
      const delayMs = Math.floor(base + jitter)
      options.onRetry?.(attempt, maxRetries, delayMs, getErrorStatus(error))
      await sleep(delayMs)
    }
  }
}
