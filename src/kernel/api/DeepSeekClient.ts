/**
 * DeepSeekClient — streaming API client for DeepSeek models.
 *
 * Uses the OpenAI SDK pointed at DeepSeek's base URL.
 * Emits Anthropic-compatible StreamEvents so KernelLoop needs no changes
 * to its event-processing switch statement.
 *
 * DeepSeek vs Anthropic differences handled here:
 *   • reasoning_content delta  →  thinking block events
 *   • tool_calls delta         →  tool_use block events (OpenAI format)
 *   • reasoning_effort param   →  replaces thinking.budget_tokens
 *   • thinking: { type }       →  passed as extra top-level param (cast)
 *   • No Anthropic beta headers
 *   • Usage arrives in the FINAL chunk (stream_options.include_usage=true)
 *     → message_start is emitted AFTER content blocks, before message_stop
 *
 * Block index layout emitted:
 *   0          : thinking  (if reasoning_content present)
 *   1 (or 0)   : text      (if content present)
 *   N+         : tool_use  (one per tool call, in order)
 */
import OpenAI from 'openai'
import type { KernelTool } from '../types/KernelTool.js'
import type { KernelConfig, ThinkingConfig } from '../types/KernelConfig.js'
import type { StreamEvent } from './AnthropicClient.js'
import type { DeepSeekMessage } from '../messages/DeepSeekMessageNormalizer.js'
import { DebugWriter } from './DebugWriter.js'
import {
  isRetryableError,
  isPromptTooLongError,
  PromptTooLongError,
} from './Errors.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReasoningEffort = 'high' | 'max'

export interface DeepSeekStreamParams {
  model: string
  sessionId?: string
  messages: DeepSeekMessage[]
  tools: KernelTool[]
  thinkingConfig?: ThinkingConfig
  maxOutputTokens?: number
  abortSignal: AbortSignal
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MAX_TOKENS = 131_072   // 128K — matches DeepSeek v4-Pro's output limit
const DEFAULT_MAX_RETRIES = 5
const INITIAL_RETRY_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 30_000

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildDeepSeekTools(
  tools: KernelTool[],
  sessionId: string,
  model: string,
): Promise<OpenAI.Chat.ChatCompletionTool[]> {
  return Promise.all(
    tools.map(async t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: typeof t.description === 'string'
          ? t.description
          : await t.description({ sessionId, model }),
        parameters: t.inputJSONSchema as Record<string, unknown>,
      },
    })),
  )
}

/**
 * Map ThinkingConfig to DeepSeek's `reasoning_effort` parameter.
 * Returns undefined to disable thinking (omits the param entirely).
 *
 * Mapping:
 *   disabled  → undefined (thinking off, no reasoning_effort sent)
 *   any other → 'max'     (always full reasoning effort when thinking is on)
 *
 * Rationale: DeepSeek distinguishes 'high' vs 'max' but for agent use-cases
 * (where thinking is intentionally turned on) maximum reasoning quality is
 * preferred.  Users who want 'high' can set reasoning_effort directly via
 * a custom KernelConfig.
 */
function buildReasoningEffort(config: ThinkingConfig | undefined): ReasoningEffort | undefined {
  if (!config || config.type === 'disabled') return undefined
  return 'max'
}

function mapFinishReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'stop':           return 'end_turn'
    case 'tool_calls':     return 'tool_use'
    case 'length':         return 'max_tokens'
    case 'content_filter': return 'stop_sequence'
    default:               return reason ?? null
  }
}

/**
 * H8: Sleep that resolves early when the abort signal fires.  Returns true if
 * the sleep elapsed naturally, false when interrupted.
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

/**
 * H7: Cache OpenAI SDK clients used to talk to DeepSeek so a multi-turn loop
 * reuses a single keep-alive pool instead of constructing a fresh client on
 * every API call.
 */
const DEEPSEEK_CLIENT_CACHE_MAX = 16
const _deepseekClientCache = new Map<string, OpenAI>()

function getDeepSeekClient(apiKey: string | undefined, baseURL: string): OpenAI {
  const key = `${apiKey ?? ''} ${baseURL}`
  const cached = _deepseekClientCache.get(key)
  if (cached) {
    _deepseekClientCache.delete(key)
    _deepseekClientCache.set(key, cached)
    return cached
  }
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 })
  _deepseekClientCache.set(key, client)
  if (_deepseekClientCache.size > DEEPSEEK_CLIENT_CACHE_MAX) {
    const oldest = _deepseekClientCache.keys().next().value
    if (oldest !== undefined) _deepseekClientCache.delete(oldest)
  }
  return client
}

/** Test/dispose hook — drop all cached DeepSeek clients. */
export function clearDeepSeekClientCache(): void {
  _deepseekClientCache.clear()
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Stream messages from the DeepSeek API.
 * Yields Anthropic-compatible StreamEvents; caller processes them identically
 * to events from AnthropicClient.streamMessages.
 *
 * Retries on 429/5xx. Propagates PromptTooLongError on context overflow.
 */
export async function* streamDeepSeekMessages(
  params: DeepSeekStreamParams,
  config: Pick<KernelConfig, 'apiKey' | 'baseURL' | 'debug' | 'maxRetries'>,
  onRetry?: (attempt: number, maxRetries: number, delayMs: number, errorStatus: number | null) => void,
): AsyncGenerator<StreamEvent> {
  // H6: never fall back to ANTHROPIC_API_KEY for DeepSeek — Anthropic keys
  // fail with 401 at DeepSeek's endpoint and make the failure mode opaque to
  // operators ("DeepSeek down?" rather than "wrong key").
  const apiKey = config.apiKey ?? process.env['DEEPSEEK_API_KEY']

  const baseURL = config.baseURL ?? DEEPSEEK_BASE_URL

  const client = getDeepSeekClient(apiKey, baseURL)

  const toolsParam = await buildDeepSeekTools(
    params.tools,
    params.sessionId ?? '',
    params.model,
  )

  const reasoningEffort = buildReasoningEffort(params.thinkingConfig)
  const thinkingEnabled = reasoningEffort !== undefined

  // Build base request — DeepSeek-specific fields (thinking, reasoning_effort)
  // are not in OpenAI's TypeScript types, so we cast to any for the create call.
  const baseRequest = {
    model: params.model,
    max_tokens: params.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    messages: params.messages as OpenAI.Chat.ChatCompletionMessageParam[],
    stream: true as const,
    stream_options: { include_usage: true },
    ...(toolsParam.length > 0 ? { tools: toolsParam } : {}),
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    ...(thinkingEnabled
      ? { thinking: { type: 'enabled' } }
      : { thinking: { type: 'disabled' } }),
  }

  let attempt = 0
  while (true) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk> =
        await (client.chat.completions.create as (params: unknown, opts: unknown) => Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>)(
          baseRequest,
          { signal: params.abortSignal },
        )

      yield* processStream(stream, config.debug, params.sessionId, baseRequest as Record<string, unknown>)
      return
    } catch (error: unknown) {
      if (isPromptTooLongError(error)) {
        throw new PromptTooLongError()
      }

      if (
        !isRetryableError(error) ||
        attempt >= (config.maxRetries ?? DEFAULT_MAX_RETRIES) ||
        params.abortSignal.aborted
      ) {
        throw error
      }

      attempt++
      const base = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS)
      const jitter = Math.random() * 0.25 * base
      const delayMs = Math.floor(base + jitter)
      onRetry?.(attempt, config.maxRetries ?? DEFAULT_MAX_RETRIES, delayMs, getErrorStatus(error))
      const completed = await abortableSleep(delayMs, params.abortSignal)
      if (!completed) {
        // Aborted during retry backoff — bail with the original error.
        throw error
      }
    }
  }
}

// ── Stream processor ──────────────────────────────────────────────────────────

type DeltaWithReasoning = OpenAI.Chat.ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null
}

type UsageWithDetails = OpenAI.CompletionUsage & {
  prompt_tokens_details?: { cached_tokens?: number }
}

/**
 * Process a DeepSeek/OpenAI stream and emit Anthropic-compatible StreamEvents.
 *
 * Ordering guarantee:
 *   content_block_start/delta events come first (enable real-time text streaming),
 *   then message_start (with accurate token counts from the final usage chunk),
 *   then message_delta + message_stop (to finalise the accumulator).
 *
 * This ordering is safe because KernelLoop's accumulator only reads inputTokens
 * on message_start and outputTokens on message_delta, both of which are used
 * only when message_stop triggers finaliseAccumulator().
 */
async function* processStream(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  debug?: boolean,
  sessionId?: string,
  reqPayload?: Record<string, unknown>,
): AsyncGenerator<StreamEvent> {
  // Open debug file (no-op when debug is false or sessionId is absent)
  const writer = await DebugWriter.open(sessionId, reqPayload?.['model'] as string ?? 'deepseek', debug)
  if (writer && reqPayload) {
    await writer.writeRequest(reqPayload)
  }

  // Block index tracking
  let nextBlockIdx = 0
  let thinkingBlockIdx = -1
  let textBlockIdx = -1
  const toolBlockByCallIdx = new Map<number, number>()   // tc.index → block index

  // Usage (populated from final usage chunk)
  let inputTokens = 0
  let cacheReadTokens = 0
  let outputTokens = 0
  let stopReason: string | null = null

  for await (const chunk of stream) {

    // ── Usage chunk (last chunk, choices is empty) ──────────────────────────
    if (chunk.usage) {
      const u = chunk.usage as UsageWithDetails
      inputTokens = u.prompt_tokens ?? 0
      cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? 0
      outputTokens = u.completion_tokens ?? 0
    }

    const choice = chunk.choices?.[0]
    if (!choice) continue

    const delta = choice.delta as DeltaWithReasoning

    // ── Thinking (reasoning_content) ────────────────────────────────────────
    if (delta.reasoning_content) {
      if (thinkingBlockIdx === -1) {
        thinkingBlockIdx = nextBlockIdx++
        yield {
          type: 'content_block_start',
          index: thinkingBlockIdx,
          // KernelLoop uses Anthropic.ContentBlock type; cast for DeepSeek thinking
          content_block: { type: 'thinking', thinking: '' } as never,
        }
      }
      yield {
        type: 'content_block_delta',
        index: thinkingBlockIdx,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content } as never,
      }
    }

    // ── Text (content) ──────────────────────────────────────────────────────
    if (delta.content) {
      if (textBlockIdx === -1) {
        textBlockIdx = nextBlockIdx++
        yield {
          type: 'content_block_start',
          index: textBlockIdx,
          content_block: { type: 'text', text: '' } as never,
        }
      }
      yield {
        type: 'content_block_delta',
        index: textBlockIdx,
        delta: { type: 'text_delta', text: delta.content } as never,
      }
    }

    // ── Tool calls ──────────────────────────────────────────────────────────
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const tcIdx = tc.index ?? 0

        if (!toolBlockByCallIdx.has(tcIdx)) {
          const blockIdx = nextBlockIdx++
          toolBlockByCallIdx.set(tcIdx, blockIdx)
          yield {
            type: 'content_block_start',
            index: blockIdx,
            content_block: {
              type: 'tool_use',
              id: tc.id ?? `call_${tcIdx}`,
              name: tc.function?.name ?? '',
              input: {},
            } as never,
          }
        }

        if (tc.function?.arguments) {
          yield {
            type: 'content_block_delta',
            index: toolBlockByCallIdx.get(tcIdx)!,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments } as never,
          }
        }
      }
    }

    if (choice.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason)
    }
  }

  // ── Emit usage + stop events AFTER content ─────────────────────────────────
  // DeepSeek sends usage only in the final (empty-choices) chunk.
  // KernelLoop reads inputTokens from message_start and outputTokens from
  // message_delta; both are consumed at message_stop time, so late emission is safe.
  yield {
    type: 'message_start',
    usage: {
      input_tokens: inputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: 0,
    },
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  }

  yield { type: 'message_stop' }

  if (writer) await writer.close()
}
