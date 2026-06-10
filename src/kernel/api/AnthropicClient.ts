/**
 * AnthropicClient — streaming API wrapper.
 * Mirrors CC's claude.ts / queryModelWithStreaming.
 *
 * Key responsibilities:
 * - Build the request parameters (model, tokens, thinking, tools, system)
 * - Stream events from the SDK
 * - Emit api_retry events on retries
 * - Convert stop_reason to our domain types
 */
import Anthropic from '@anthropic-ai/sdk'
import type { KernelTool } from '../types/KernelTool.js'
import type { KernelConfig, ThinkingConfig } from '../types/KernelConfig.js'
import type { APIMessage } from '../messages/MessageNormalizer.js'
import { buildThinkingParam } from '../utils/ThinkingConfig.js'
import { DebugWriter } from './DebugWriter.js'
import {
  isRetryableError,
  isPromptTooLongError,
  isFallbackTriggeredError,
  PromptTooLongError,
  FallbackTriggeredError,
  AvailabilityFallbackTriggeredError,
} from './Errors.js'

export type StreamEvent =
  | { type: 'message_start'; usage: { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
  | { type: 'content_block_start'; index: number; content_block: Anthropic.ContentBlock }
  | { type: 'content_block_delta'; index: number; delta: Anthropic.RawContentBlockDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string | null; stop_sequence: string | null }; usage: { output_tokens: number } }
  | { type: 'message_stop' }

export interface StreamParams {
  model: string
  sessionId?: string
  messages: APIMessage[]
  systemPrompt?: string
  tools: KernelTool[]
  thinkingConfig?: ThinkingConfig
  maxOutputTokens?: number
  abortSignal: AbortSignal
  /**
   * Additional Anthropic beta feature flags to include in the request.
   * Merged with the default 'interleaved-thinking-2025-05-14' beta.
   * Example: ['token-efficient-tools-2025-02-19']
   */
  betas?: string[]
  /** Whether to include kernel default beta headers. Default: true. */
  includeDefaultBetas?: boolean
}

const DEFAULT_MAX_TOKENS = 32_768
const DEFAULT_MAX_RETRIES = 5
const INITIAL_RETRY_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 30_000

async function buildToolsParam(tools: KernelTool[], model: string, sessionId = ''): Promise<Anthropic.Tool[]> {
  return Promise.all(tools.map(async t => ({
    name: t.name,
    description: typeof t.description === 'string'
      ? t.description
      : await t.description({ sessionId, model }),
    input_schema: t.inputJSONSchema as Anthropic.Tool.InputSchema,
  })))
}

/**
 * H8: Sleep that resolves early when the abort signal fires.  Returns true
 * when the sleep completed normally, false when interrupted by abort.
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function getErrorStatus(e: unknown): number | null {
  if (e && typeof e === 'object' && 'status' in e) {
    const s = (e as Record<string, unknown>).status
    if (typeof s === 'number') return s
  }
  return null
}

// Default beta flags sent on every request
const DEFAULT_BETAS = ['interleaved-thinking-2025-05-14']

/**
 * Hosts whose Anthropic-compatible endpoints authenticate with
 * `Authorization: Bearer <key>` instead of Anthropic's native `x-api-key`
 * header. The Zhipu GLM coding plan (open.bigmodel.cn/api/anthropic, z.ai) is
 * one such endpoint.
 */
const BEARER_AUTH_HOSTS = ['bigmodel.cn', 'z.ai']

/** True when `baseURL` points at an endpoint that expects Bearer-token auth. */
export function usesBearerAuth(baseURL?: string): boolean {
  if (!baseURL) return false
  return BEARER_AUTH_HOSTS.some(h => baseURL.includes(h))
}

/**
 * Build the auth options for the Anthropic SDK client.
 *
 * Anthropic's own API uses `x-api-key`; Bearer-auth compat endpoints (Zhipu
 * GLM) use `Authorization: Bearer`. The SDK sends `x-api-key` for `apiKey` and
 * `Authorization: Bearer` for `authToken`, so we set exactly one — passing
 * `apiKey: null` suppresses the `x-api-key` header entirely (see the SDK's
 * apiKeyAuth()/validateHeaders()).
 */
export function buildAnthropicAuth(
  apiKey: string | undefined,
  baseURL: string | undefined,
): { apiKey: string | null; authToken?: string } {
  if (usesBearerAuth(baseURL)) {
    return { apiKey: null, authToken: apiKey ?? process.env['ZHIPU_API_KEY'] ?? undefined }
  }
  return { apiKey: apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? null }
}

/**
 * H7: Cache Anthropic SDK clients keyed by (apiKey, baseURL, betaHeader)
 * so a 30-turn agentic loop reuses a single keep-alive connection pool
 * instead of constructing 30 fresh clients.
 *
 * Bounded by ANTHROPIC_CLIENT_CACHE_MAX entries (LRU) to prevent unbounded
 * growth under callers that rotate keys/URLs.
 */
const ANTHROPIC_CLIENT_CACHE_MAX = 16
const _anthropicClientCache = new Map<string, Anthropic>()

function getAnthropicClient(
  apiKey: string | undefined,
  baseURL: string | undefined,
  betaHeader: string,
): Anthropic {
  const key = `${apiKey ?? ''}
${baseURL ?? ''}
${betaHeader}`
  const cached = _anthropicClientCache.get(key)
  if (cached) {
    // touch for LRU
    _anthropicClientCache.delete(key)
    _anthropicClientCache.set(key, cached)
    return cached
  }
  const client = new Anthropic({
    ...buildAnthropicAuth(apiKey, baseURL),
    baseURL,
    maxRetries: 0, // we own retries
    ...(betaHeader ? { defaultHeaders: { 'anthropic-beta': betaHeader } } : {}),
  })
  _anthropicClientCache.set(key, client)
  if (_anthropicClientCache.size > ANTHROPIC_CLIENT_CACHE_MAX) {
    const oldest = _anthropicClientCache.keys().next().value
    if (oldest !== undefined) _anthropicClientCache.delete(oldest)
  }
  return client
}

/** Test/dispose hook — drop all cached SDK clients. */
export function clearAnthropicClientCache(): void {
  _anthropicClientCache.clear()
}

/**
 * Stream messages from the Anthropic API.
 * Yields raw SDK stream events; the caller is responsible for reconstructing
 * assistant messages from these events.
 *
 * Retries automatically on 429/5xx.
 * Propagates PromptTooLongError on 400 PTL.
 * Propagates FallbackTriggeredError when the model cannot handle the request.
 */
export async function* streamMessages(
  params: StreamParams,
  config: Pick<KernelConfig, 'apiKey' | 'baseURL' | 'debug' | 'maxRetries'>,
  onRetry?: (attempt: number, maxRetries: number, delayMs: number, errorStatus: number | null) => void,
): AsyncGenerator<StreamEvent> {
  // Merge default betas with any caller-supplied extras (dedup by Set)
  const allBetas = [...new Set([...(params.includeDefaultBetas === false ? [] : DEFAULT_BETAS), ...(params.betas ?? [])])]
  const betaHeader = allBetas.join(',')

  const client = getAnthropicClient(config.apiKey, config.baseURL, betaHeader)

  const thinkingParam = buildThinkingParam(params.thinkingConfig)
  const toolsParam = await buildToolsParam(params.tools, params.model, params.sessionId)

  const requestParams: Anthropic.MessageCreateParamsStreaming = {
    model: params.model,
    max_tokens: params.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    messages: params.messages,
    ...(params.systemPrompt ? { system: params.systemPrompt } : {}),
    ...(toolsParam.length > 0 ? { tools: toolsParam } : {}),
    ...(thinkingParam ? { thinking: thinkingParam } : {}),
  }

  // Open debug file once (outside retry loop — one file per logical call)
  const writer = await DebugWriter.open(params.sessionId, params.model, config.debug)
  if (writer) {
    await writer.writeRequest(requestParams as unknown as Record<string, unknown>)
  }

  let attempt = 0
  // True once any stream event has been yielded to the caller. After that
  // point a retry would REPLAY the whole response from the start — the caller
  // already rendered the first attempt's text (duplicate terminal output) and,
  // if a message_stop was already consumed, would double-count the assistant
  // message and its usage/cost. Mid-stream failures are instead thrown to
  // KernelLoop's stream-error recovery, which injects the error into the
  // conversation and retries the turn without replaying UI output.
  let yieldedAny = false
  try {
    while (true) {
      try {
        const stream = await client.messages.create(requestParams, {
          signal: params.abortSignal,
        })

        for await (const event of stream) {
          yieldedAny = true
          yield event as unknown as StreamEvent
        }
        return
      } catch (error: unknown) {
        if (isPromptTooLongError(error)) {
          throw new PromptTooLongError()
        }

        // Detect model-capability errors → let KernelLoop switch to fallbackModel
        if (isFallbackTriggeredError(error)) {
          throw new FallbackTriggeredError(
            error instanceof Error ? error.message : 'Fallback triggered',
          )
        }

        // Mid-stream failure after events were already delivered — never
        // replay (see yieldedAny comment above).
        if (yieldedAny) throw error

        const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
        if (isRetryableError(error) && attempt >= maxRetries && !params.abortSignal.aborted) {
          throw new AvailabilityFallbackTriggeredError(
            error instanceof Error ? error.message : 'Provider unavailable after retries',
          )
        }

        if (
          !isRetryableError(error) ||
          attempt >= maxRetries ||
          params.abortSignal.aborted
        ) {
          throw error
        }

        attempt++
        const base = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS)
        const jitter = Math.random() * 0.25 * base
        const delayMs = Math.floor(base + jitter)
        onRetry?.(attempt, maxRetries, delayMs, getErrorStatus(error))
        const completed = await abortableSleep(delayMs, params.abortSignal)
        if (!completed) {
          // Aborted mid-backoff — rethrow the original error so KernelLoop can
          // surface the interruption rather than silently retrying.
          throw error
        }
      }
    }
  } finally {
    // Single close point: covers normal completion, every throw path, AND the
    // consumer abandoning the generator mid-stream (break / early return),
    // which previously leaked the debug file handle.
    if (writer) await writer.close().catch(() => {})
  }
}
