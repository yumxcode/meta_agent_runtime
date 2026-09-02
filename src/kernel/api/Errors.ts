/**
 * Errors — error classification for the streaming API.
 * Mirrors CC's errors.ts / errorUtils.ts.
 */
import { isStreamTimeoutError } from './StreamWatchdog.js'

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

/**
 * Upper bound on how long a server-supplied `retry-after` may park a request.
 *
 * The header is attacker-influenceable in a proxy/gateway deployment, and a
 * misconfigured one is not exotic (`retry-after: 86400` on a quota page). The
 * cap keeps an honest hint useful while making a hostile one merely annoying.
 */
export const MAX_RETRY_AFTER_MS = 120_000

/**
 * Read the server's own "come back in N" hint from a failed API call.
 *
 * Both vendor SDKs attach the response headers to the thrown error, and both
 * our retry loops used to ignore them: a 429 whose quota window resets in 60 s
 * was retried on a fixed 1 s→30 s exponential ladder, so all five attempts were
 * spent inside the window and the call was declared a provider outage — which
 * then triggers a model fallback. Honouring the hint turns that into one wait.
 *
 * Accepts both RFC 7231 forms (delta-seconds and HTTP-date) plus Anthropic's
 * `anthropic-ratelimit-*-reset` absolute timestamps. Returns null when there is
 * no usable hint; clamps to [0, MAX_RETRY_AFTER_MS].
 */
export function retryAfterMsFromError(error: unknown, now = Date.now()): number | null {
  if (!error || typeof error !== 'object') return null
  const headers = (error as Record<string, unknown>)['headers']
  if (!headers) return null

  const read = (name: string): string | undefined => {
    // Headers may be a fetch Headers instance or a plain object, and plain
    // objects are not case-normalised by every SDK version.
    if (typeof (headers as Headers).get === 'function') {
      return (headers as Headers).get(name) ?? undefined
    }
    const record = headers as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (key.toLowerCase() !== name) continue
      const value = record[key]
      if (typeof value === 'string') return value
      if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
    }
    return undefined
  }

  const clamp = (ms: number): number | null =>
    Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : null

  const retryAfter = read('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter.trim())
    if (Number.isFinite(seconds)) return clamp(seconds * 1000)
    const at = Date.parse(retryAfter)
    if (Number.isFinite(at)) return clamp(at - now)
  }

  // Anthropic reports absolute reset instants per limit dimension; the soonest
  // one is when the request could possibly succeed again.
  let soonest: number | null = null
  for (const name of [
    'anthropic-ratelimit-requests-reset',
    'anthropic-ratelimit-input-tokens-reset',
    'anthropic-ratelimit-output-tokens-reset',
    'anthropic-ratelimit-tokens-reset',
  ]) {
    const raw = read(name)
    if (!raw) continue
    const at = Date.parse(raw)
    if (!Number.isFinite(at)) continue
    const ms = at - now
    if (ms > 0 && (soonest === null || ms < soonest)) soonest = ms
  }
  return soonest === null ? null : clamp(soonest)
}

export function isRetryableError(error: unknown): boolean {
  // A first-token / idle stream timeout is a transport-level stall, not a
  // semantic failure — re-issuing the request is the correct response. Callers
  // still gate on `yieldedAny`, so only a first-token timeout actually replays;
  // a mid-stream stall goes to KernelLoop's stream-error recovery instead.
  if (isStreamTimeoutError(error)) return true
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
