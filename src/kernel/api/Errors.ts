/**
 * Errors — error classification for the streaming API.
 * Mirrors CC's errors.ts / errorUtils.ts.
 */

/** Thrown when the API returns a prompt-too-long (context overflow) error */
export class PromptTooLongError extends Error {
  constructor(message = 'Prompt too long') {
    super(message)
    this.name = 'PromptTooLongError'
  }
}

/** Thrown when the model signals a fallback (e.g. thinking quota exceeded on this model) */
export class FallbackTriggeredError extends Error {
  constructor(message = 'Fallback triggered') {
    super(message)
    this.name = 'FallbackTriggeredError'
  }
}

/** Thrown when a provider stays unavailable after retries and a fallback model may help. */
export class AvailabilityFallbackTriggeredError extends FallbackTriggeredError {
  constructor(message = 'Provider unavailable after retries') {
    super(message)
    this.name = 'AvailabilityFallbackTriggeredError'
  }
}

/** Thrown when the request is aborted via AbortSignal */
export class AbortError extends Error {
  constructor(message = 'Request aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

// ── Error classification helpers ─────────────────────────────────────────────

export function isPromptTooLongError(error: unknown): boolean {
  if (error instanceof PromptTooLongError) return true
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>
    // Anthropic API: error.status === 400 with error type 'prompt_too_long'
    if (e['status'] === 400 && typeof e['message'] === 'string') {
      const msg = e['message'].toLowerCase()
      if (msg.includes('prompt is too long') || msg.includes('prompt_too_long')) return true
    }
    if (typeof e['error'] === 'object' && e['error'] !== null) {
      const inner = e['error'] as Record<string, unknown>
      if (inner['type'] === 'prompt_too_long') return true
    }
  }
  return false
}

export function isMaxOutputTokensStopReason(stopReason: string | null | undefined): boolean {
  return stopReason === 'max_tokens'
}

export function isOverloadedError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>
    if (e['status'] === 529) return true
    if (typeof e['message'] === 'string' && e['message'].toLowerCase().includes('overloaded')) return true
  }
  return false
}

export function isRateLimitError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>
    if (e['status'] === 429) return true
  }
  return false
}

export function isRetryableError(error: unknown): boolean {
  return isRateLimitError(error) || isOverloadedError(error) || isServerError(error)
}

function isServerError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>
    const status = e['status']
    return typeof status === 'number' && status >= 500 && status < 600
  }
  return false
}

/**
 * Detect whether an API error should trigger a model fallback.
 * Mirrors CC's isFallbackError() — covers cases where the primary model
 * is unable to handle the request (e.g. thinking feature not available,
 * model-specific capability limits, or explicit model-unavailable errors).
 */
export function isFallbackTriggeredError(error: unknown): boolean {
  if (error instanceof FallbackTriggeredError) return true
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>
    const status = e['status']
    const inner = typeof e['error'] === 'object' && e['error'] !== null
      ? e['error'] as Record<string, unknown>
      : {}
    const message = [
      typeof e['message'] === 'string' ? e['message'] : '',
      typeof inner['message'] === 'string' ? inner['message'] : '',
      typeof inner['type'] === 'string' ? inner['type'] : '',
    ].join(' ').toLowerCase()
    // 400 errors about model capabilities / feature not supported
    if (status === 400) {
      if (
        message.includes('extended thinking') ||
        message.includes('thinking is not supported') ||
        message.includes('model does not support') ||
        message.includes('feature is not available')
      ) return true
    }
    // Explicit model-not-available
    if (status === 404 && message.includes('model')) return true
  }
  return false
}

export const PROMPT_TOO_LONG_ERROR_MESSAGE =
  "I'm sorry, but my context window is full and I can't continue this conversation. " +
  'Please start a new conversation or use /compact to compress the conversation history.'
