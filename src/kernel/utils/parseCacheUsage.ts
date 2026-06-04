/**
 * parseCacheUsage — provider-tolerant token-usage normalizer.
 *
 * Different providers report cache hits in different wire shapes, even though
 * GLM/Zhipu and DeepSeek both ride compat endpoints that we read through the
 * same StreamEvent pipeline:
 *
 *   • Anthropic (native):     usage.cache_read_input_tokens
 *                             usage.cache_creation_input_tokens
 *                             usage.input_tokens          (EXCLUDES cached)
 *
 *   • OpenAI / GLM / DeepSeek usage.prompt_tokens         (INCLUDES cached)
 *     (chat.completions):     usage.prompt_tokens_details.cached_tokens
 *
 *   • DeepSeek (native pair): usage.prompt_cache_hit_tokens
 *                             usage.prompt_cache_miss_tokens
 *
 * The GLM coding-plan endpoint speaks the Anthropic wire format but does NOT
 * always populate `cache_read_input_tokens`; some responses carry the OpenAI
 * `prompt_tokens_details.cached_tokens` shape instead. Reading only the
 * Anthropic field silently records GLM cache reads as 0, which understates the
 * cache hit rate and overstates cost in monitoring.
 *
 * This function normalizes every known shape to Anthropic semantics:
 *   inputTokens     = NON-cached prompt tokens (billed at full input price)
 *   cacheReadTokens = cached/reused prompt tokens (billed at cache-read price)
 *   cacheWriteTokens= tokens written to cache this turn (Anthropic only; 0 else)
 *
 * Normalizing to non-cached `inputTokens` keeps CostTracker correct, which
 * computes  inputTokens*input + cacheReadTokens*cacheRead  and would otherwise
 * double-charge the cached portion for OpenAI-shaped providers.
 */
import type { ProviderId } from '../../providers/registry.js'

export interface NormalizedUsage {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Any raw usage-bearing object: a StreamEvent, an SDK message, or a usage blob. */
type RawUsageLike = Record<string, unknown> | null | undefined

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Locate the usage object regardless of nesting. Accepts:
 *   { usage: {...} }              (our flattened StreamEvent / OpenAI chunk)
 *   { message: { usage: {...} } } (raw Anthropic message_start event)
 *   { input_tokens, ... }         (a bare usage object)
 */
function pickUsage(raw: RawUsageLike): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (o['usage'] && typeof o['usage'] === 'object') {
    return o['usage'] as Record<string, unknown>
  }
  if (o['message'] && typeof o['message'] === 'object') {
    const inner = (o['message'] as Record<string, unknown>)['usage']
    if (inner && typeof inner === 'object') return inner as Record<string, unknown>
  }
  // Already a bare usage object.
  return o
}

/**
 * Normalize a raw provider usage payload to Anthropic semantics.
 *
 * @param raw      A StreamEvent, SDK message, or usage object (any nesting).
 * @param provider Optional provider hint. Only used to disambiguate; field
 *                 presence always wins, so an unexpected wire shape still parses.
 */
export function parseCacheUsage(raw: RawUsageLike, _provider?: ProviderId): NormalizedUsage {
  const u = pickUsage(raw)
  if (!u) return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

  // ── Anthropic shape ────────────────────────────────────────────────────────
  // input_tokens already EXCLUDES cached reads; cache_creation is write-side.
  const hasAnthropic =
    'input_tokens' in u || 'cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u
  if (hasAnthropic && !('prompt_tokens' in u) && !('prompt_cache_hit_tokens' in u)) {
    return {
      inputTokens: num(u['input_tokens']),
      cacheReadTokens: num(u['cache_read_input_tokens']),
      cacheWriteTokens: num(u['cache_creation_input_tokens']),
    }
  }

  // ── DeepSeek native hit/miss pair ───────────────────────────────────────────
  // miss = fresh input, hit = cached. prompt_tokens (if present) == hit + miss.
  if ('prompt_cache_hit_tokens' in u || 'prompt_cache_miss_tokens' in u) {
    const hit = num(u['prompt_cache_hit_tokens'])
    const miss = num(u['prompt_cache_miss_tokens'])
    return { inputTokens: miss, cacheReadTokens: hit, cacheWriteTokens: 0 }
  }

  // ── OpenAI / GLM / DeepSeek chat.completions shape ──────────────────────────
  // prompt_tokens INCLUDES cached; subtract to get the non-cached remainder.
  const details = u['prompt_tokens_details']
  const cached =
    details && typeof details === 'object'
      ? num((details as Record<string, unknown>)['cached_tokens'])
      : 0
  const promptTotal = num(u['prompt_tokens'])
  return {
    inputTokens: Math.max(0, promptTotal - cached),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  }
}
