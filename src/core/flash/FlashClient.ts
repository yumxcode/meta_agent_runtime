/**
 * FlashClient — unified wrapper for flash-model side-calls.
 *
 * Responsibilities:
 *   • Single Anthropic client instance per FlashClient (no per-call creation)
 *   • Hard timeout on every request (default 4 s)
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
import { detectProvider } from '../config.js'
import { withTimeout } from '../utils/withTimeout.js'
import type { MetaAgentConfig } from '../config.js'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FlashQueryOpts {
  system: string
  user: string
  maxTokens: number
  /** Hard timeout in ms. Default: 4000 */
  timeoutMs?: number
  /**
   * When set, the result is cached in memory under this key.
   * Subsequent calls with the same key skip the network round-trip.
   * Use a content-hash so cache invalidates naturally when inputs change.
   */
  cacheKey?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// FlashClient
// ─────────────────────────────────────────────────────────────────────────────

export class FlashClient {
  private readonly anthropicClient: Anthropic | null
  private readonly openaiClient: OpenAI | null
  private readonly model: string
  private readonly cache = new Map<string, string>()

  constructor(config: Pick<MetaAgentConfig, 'apiKey' | 'baseURL' | 'model'>) {
    const { provider, apiKey, baseURL, flashModel } = detectProvider(config)
    this.model = flashModel
    if (provider === 'deepseek' || flashModel.startsWith('deepseek-')) {
      this.anthropicClient = null
      this.openaiClient = new OpenAI({ apiKey, baseURL })
    } else {
      this.anthropicClient = new Anthropic({ apiKey, baseURL })
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
   */
  async query(opts: FlashQueryOpts): Promise<string | null> {
    // Cache hit
    if (opts.cacheKey && this.cache.has(opts.cacheKey)) {
      return this.cache.get(opts.cacheKey)!
    }

    try {
      let text: string | null = null

      if (this.openaiClient) {
        const msg = await withTimeout(
          this.openaiClient.chat.completions.create({
            model: this.model,
            max_tokens: opts.maxTokens,
            messages: [
              { role: 'system', content: opts.system },
              { role: 'user', content: opts.user },
            ],
          }),
          opts.timeoutMs ?? 4_000,
        )
        text = msg.choices[0]?.message?.content?.trim() || null
      } else if (this.anthropicClient) {
        const msg = await withTimeout(
          this.anthropicClient.messages.create({
            model: this.model,
            max_tokens: opts.maxTokens,
            system: opts.system,
            messages: [{ role: 'user', content: opts.user }],
          }),
          opts.timeoutMs ?? 4_000,
        )

        const block = msg.content[0]
        text = block?.type === 'text' ? (block as Anthropic.TextBlock).text.trim() : null
      }
      if (!text) return null

      if (opts.cacheKey) this.cache.set(opts.cacheKey, text)
      return text
    } catch {
      // Timeout, network error, or API failure — caller handles fallback
      return null
    }
  }

  /** Flush all cached results (call at session start or project switch). */
  clearCache(): void {
    this.cache.clear()
  }

  /** Current flash model identifier (useful for logging/debugging). */
  get modelId(): string {
    return this.model
  }
}
