/**
 * FlashClient — unified wrapper for flash-model side-calls.
 *
 * Responsibilities:
 *   • Single Anthropic client instance per FlashClient (no per-call creation)
 *   • Hard timeout on every request (default 30 s)
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

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { resolveConfig } from '../config.js'
import { getModelProtocol } from '../../providers/registry.js'
import { buildAnthropicAuth } from '../../kernel/api/AnthropicClient.js'
import { withAbortableTimeout } from '../utils/withTimeout.js'
import { flashTimeoutMs } from '../timeouts.js'
import type { MetaAgentConfig } from '../config.js'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FlashQueryOpts {
  system: string
  user: string
  maxTokens: number
  /**
   * Hard timeout in ms. Default: DERIVED from maxTokens via
   * `flashTimeoutMs()` — `flashTtftMs + maxTokens / flashTokensPerSec`,
   * clamped to [30 s, 180 s].
   *
   * Pass an explicit value only when the call has a latency budget of its own
   * (QueryAnalyzer deliberately uses 8 s because it must not block the turn).
   * A flat default is what left the 1,000–1,200-token side-calls able to
   * succeed only on a fast provider.
   */
  timeoutMs?: number
  /**
   * When set, the result is cached in memory under this key.
   * Subsequent calls with the same key skip the network round-trip.
   * Use a content-hash so cache invalidates naturally when inputs change.
   */
  cacheKey?: string
  /**
   * This call is SPECULATIVE: the caller has already raced it against a
   * deadline and moved on, so a failure here changes nothing the user can see.
   *
   * The per-failure `console.warn` below exists because a silently-broken
   * knowledge pipeline (extraction, principle promotion) degrades to its
   * fallback with no other symptom. That reasoning does not hold for a request
   * whose whole purpose is to warm a cache after it already lost a race —
   * warning there prints an alarming line into the middle of the user's
   * streaming output for something working exactly as designed. Observed in
   * robotics mode: QueryAnalyzer's abandoned request timed out mid-turn and
   * the warning landed on top of the model's response.
   *
   * Speculative failures are still COUNTED, and a one-shot summary is printed
   * once a caller's failures cross SPECULATIVE_WARN_AFTER — so "this side-call
   * never once succeeded" stays discoverable instead of becoming invisible.
   * `label` names the caller in that summary.
   */
  speculative?: boolean
  /** Caller name used in the speculative-failure summary. */
  label?: string
}

/**
 * How many speculative failures from one label before we say something.
 *
 * Low enough that a permanently-misconfigured flash model is reported inside a
 * single session, high enough that ordinary jitter stays quiet.
 */
const SPECULATIVE_WARN_AFTER = 5

// ─────────────────────────────────────────────────────────────────────────────
// FlashClient
// ─────────────────────────────────────────────────────────────────────────────

export class FlashClient {
  private readonly anthropicClient: Anthropic | null
  private readonly openaiClient: OpenAI | null
  private readonly model: string
  private readonly cache = new Map<string, string>()
  /** label → consecutive speculative failures (see noteSpeculativeFailure). */
  private readonly speculativeFailures = new Map<string, number>()
  private static readonly MAX_CACHE_ENTRIES = 512
  static readonly DEFAULT_TIMEOUT_MS = 30_000

  constructor(config: Pick<MetaAgentConfig, 'apiKey' | 'baseURL' | 'model' | 'flashModel'>) {
    const { apiKey, baseURL, flashModel } = resolveConfig(config)
    this.model = flashModel
    if (getModelProtocol(flashModel, baseURL) === 'openai') {
      this.anthropicClient = null
      this.openaiClient = new OpenAI({ apiKey, baseURL })
    } else {
      // Anthropic path (incl. Bearer-auth compat endpoints like Zhipu GLM)
      this.anthropicClient = new Anthropic({ ...buildAnthropicAuth(apiKey, baseURL), baseURL })
      this.openaiClient = null
    }
  }

  /**
   * Send a one-shot flash-model query.
   *
   * Returns the model's text response, or null if:
   *   - The request timed out
   *   - A network/API error occurred
   *   - The model returned no text content
   *
   * Callers MUST handle null with a keyword-based or safe-default fallback.
   * Failures are logged (previously they were entirely silent, so a knowledge
   * pipeline that had stopped working produced no signal at all).
   */
  async query(opts: FlashQueryOpts): Promise<string | null> {
    // Cache hit
    if (opts.cacheKey && this.cache.has(opts.cacheKey)) {
      const cached = this.cache.get(opts.cacheKey)!
      this.cache.delete(opts.cacheKey)
      this.cache.set(opts.cacheKey, cached)
      return cached
    }

    const effectiveTimeoutMs = opts.timeoutMs ?? flashTimeoutMs(opts.maxTokens)

    try {
      let text: string | null = null

      if (this.openaiClient) {
        const msg = await withAbortableTimeout(signal =>
          this.openaiClient!.chat.completions.create({
            model: this.model,
            max_tokens: opts.maxTokens,
            messages: [
              { role: 'system', content: opts.system },
              { role: 'user', content: opts.user },
            ],
          }, { signal }),
          effectiveTimeoutMs,
        )
        text = msg.choices[0]?.message?.content?.trim() || null
      } else if (this.anthropicClient) {
        const msg = await withAbortableTimeout(signal =>
          this.anthropicClient!.messages.create({
            model: this.model,
            max_tokens: opts.maxTokens,
            system: opts.system,
            messages: [{ role: 'user', content: opts.user }],
          }, { signal }),
          effectiveTimeoutMs,
        )

        const block = msg.content[0]
        text = block?.type === 'text' ? (block as Anthropic.TextBlock).text.trim() : null
      }
      if (!text) return null

      if (opts.cacheKey) this.setCached(opts.cacheKey, text)
      return text
    } catch (err) {
      // Timeout, network error, or API failure — caller handles fallback.
      const detail = err instanceof Error ? err.message : String(err)
      if (opts.speculative) {
        this.noteSpeculativeFailure(opts.label ?? 'flash', detail, effectiveTimeoutMs, opts.maxTokens)
        return null
      }
      // Warn rather than swallow: a persistently failing flash call degrades a
      // whole feature (memory recall, knowledge extraction, principle
      // promotion) into its fallback with no other symptom.
      console.warn(
        `[meta-agent] flash call failed (model=${this.model}, maxTokens=${opts.maxTokens}, ` +
        `timeout=${effectiveTimeoutMs}ms) — using caller fallback:`,
        detail,
      )
      return null
    }
  }

  /**
   * Record a speculative failure; report ONCE per label when they pile up.
   *
   * Silence-by-default plus a threshold is deliberate: the alternative designs
   * both fail. Warning every time is what put an alarming line in the middle of
   * a streaming response for a request that was supposed to be abandoned.
   * Warning never means a flash model that is misconfigured, unreachable, or
   * simply too slow for its budget produces no signal at all — the feature just
   * quietly stops contributing forever, which is the exact failure the original
   * warning was added to prevent.
   */
  private noteSpeculativeFailure(
    label: string,
    detail: string,
    timeoutMs: number,
    maxTokens: number,
  ): void {
    const count = (this.speculativeFailures.get(label) ?? 0) + 1
    this.speculativeFailures.set(label, count)
    if (count !== SPECULATIVE_WARN_AFTER) return   // exactly once, not every time after
    console.warn(
      `[meta-agent] the "${label}" flash side-call has failed ${count} times ` +
      `(model=${this.model}, maxTokens=${maxTokens}, timeout=${timeoutMs}ms). ` +
      `It is best-effort, so nothing is broken — but it is contributing nothing. ` +
      `Last error: ${detail}`,
    )
  }

  /** Flush all cached results (call at session start or project switch). */
  clearCache(): void {
    this.cache.clear()
    this.speculativeFailures.clear()
  }

  /** @testonly — speculative failure count for a label. */
  speculativeFailureCount(label: string): number {
    return this.speculativeFailures.get(label) ?? 0
  }

  private setCached(key: string, value: string): void {
    if (this.cache.has(key)) this.cache.delete(key)
    this.cache.set(key, value)
    while (this.cache.size > FlashClient.MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (typeof oldest !== 'string') break
      this.cache.delete(oldest)
    }
  }

  /** Current flash model identifier (useful for logging/debugging). */
  get modelId(): string {
    return this.model
  }
}
