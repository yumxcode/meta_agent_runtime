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
import { acquireRegisteredModelCall } from '../../infra/modelCallAdmission.js'
import { parseCacheUsage } from '../utils/parseCacheUsage.js'
import { withStreamWatchdog } from './StreamWatchdog.js'
import { timeout } from '../../core/timeouts.js'
import {
  isRetryableError,
  isPromptTooLongError,
  PromptTooLongError,
  AvailabilityFallbackTriggeredError,
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

// L5: memoize the built tool array per (sessionId, model, tool-name set). Tool
// descriptions are stable for a given session+model+toolset, so rebuilding them
// (and awaiting any dynamic description thunks) on every turn is wasted work.
// Bounded LRU so many short-lived sessions can't grow it without limit.
const DEEPSEEK_TOOLS_CACHE_MAX = 32
const _deepseekToolsCache = new Map<string, OpenAI.Chat.ChatCompletionTool[]>()

/** Test/dispose hook — drop all cached DeepSeek tool schemas. */
export function clearDeepSeekToolsCache(): void {
  _deepseekToolsCache.clear()
}

async function buildDeepSeekTools(
  tools: KernelTool[],
  sessionId: string,
  model: string,
): Promise<OpenAI.Chat.ChatCompletionTool[]> {
  const cacheKey = `${sessionId}\x00${model}\x00${tools.map(t => t.name).join(',')}`
  const cached = _deepseekToolsCache.get(cacheKey)
  if (cached) {
    // LRU touch
    _deepseekToolsCache.delete(cacheKey)
    _deepseekToolsCache.set(cacheKey, cached)
    return cached
  }

  const built = await Promise.all(
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

  _deepseekToolsCache.set(cacheKey, built)
  if (_deepseekToolsCache.size > DEEPSEEK_TOOLS_CACHE_MAX) {
    const oldest = _deepseekToolsCache.keys().next().value
    if (oldest !== undefined) _deepseekToolsCache.delete(oldest)
  }
  return built
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
  const modelAdmission = await acquireRegisteredModelCall(params.sessionId, params.abortSignal)
  const activeAbortSignal = modelAdmission?.signal ?? params.abortSignal

  let attempt = 0
  // True once any stream event has been yielded. After that point a retry
  // would replay the whole response (duplicate terminal output / potential
  // double-counted message) — mid-stream failures are thrown to KernelLoop's
  // stream-error recovery instead. Mirrors AnthropicClient.streamMessages.
  let yieldedAny = false
  try {
    while (true) {
      // Per-ATTEMPT controller so the watchdog can abort THIS request without
      // tearing down the caller's (long-lived) signal. Mirrors AnthropicClient.
      const attemptCtrl = new AbortController()
      const forwardAbort = (): void => attemptCtrl.abort(activeAbortSignal.reason)
      if (activeAbortSignal.aborted) forwardAbort()
      else activeAbortSignal.addEventListener('abort', forwardAbort, { once: true })

      try {
        // DeepSeek-only request fields (thinking, reasoning_effort) are not in
        // OpenAI's TypeScript types, so the create call is re-typed rather than
        // the payload being narrowed to fit them.
        const stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk> =
          await (client.chat.completions.create as (params: unknown, opts: unknown) => Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>)(
            baseRequest,
            { signal: attemptCtrl.signal },
          )

        // Wrap the RAW SDK chunks, not processStream's output: processStream
        // filters/merges chunks, so a provider that keeps emitting content-less
        // keepalives would look "idle" downstream while the socket is healthy.
        // Guarding the raw layer measures the transport, which is the thing
        // that actually stalls.
        const guarded = withStreamWatchdog(stream, {
          firstTokenMs: timeout('llmFirstTokenMs'),
          idleMs:       timeout('llmIdleMs'),
          onTimeout:    () => attemptCtrl.abort(new Error('stream watchdog')),
        })

        for await (const event of processStream(guarded, config.debug, params.sessionId, baseRequest as Record<string, unknown>)) {
          yieldedAny = true
          yield event
        }
        return
      } catch (error: unknown) {
        if (isPromptTooLongError(error)) {
          throw new PromptTooLongError()
        }

        // Never replay a partially-delivered stream (see yieldedAny above).
        if (yieldedAny) throw error

        const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
        if (isRetryableError(error) && attempt >= maxRetries && !activeAbortSignal.aborted) {
          throw new AvailabilityFallbackTriggeredError(
            error instanceof Error ? error.message : 'Provider unavailable after retries',
          )
        }

        if (
          !isRetryableError(error) ||
          attempt >= maxRetries ||
          activeAbortSignal.aborted
        ) {
          throw error
        }

        attempt++
        const base = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS)
        const jitter = Math.random() * 0.25 * base
        const delayMs = Math.floor(base + jitter)
        onRetry?.(attempt, maxRetries, delayMs, getErrorStatus(error))
        const completed = await abortableSleep(delayMs, activeAbortSignal)
        if (!completed) {
          // Aborted during retry backoff — bail with the original error.
          throw error
        }
      } finally {
        // Don't leak one forwarder per attempt onto a session-lifetime signal.
        activeAbortSignal.removeEventListener('abort', forwardAbort)
      }
    }
  } finally {
    await modelAdmission?.release().catch(() => undefined)
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
  // M2-fix: opened INSIDE the try. DebugWriter.open() hands back two file
  // handles and writeRequest() immediately writes to one of them; both used to
  // run before the try, so a filesystem failure there leaked the handles that
  // had already been opened.
  let writer: DebugWriter | null = null
  try {
    // Open debug file (no-op when debug is false or sessionId is absent)
    writer = await DebugWriter.open(sessionId, reqPayload?.['model'] as string ?? 'deepseek', debug)
    if (writer && reqPayload) {
      await writer.writeRequest(reqPayload)
    }

    for await (const event of processStreamInner(stream)) {
      // Accumulate response content for the markdown debug twin.
      writer?.recordStreamEvent(event)
      yield event
    }
  } finally {
    if (writer) await writer.close().catch(() => undefined)
  }
}

/**
 * One in-flight tool call, accumulated across chunks.
 *
 * `id` and `name` MUST be accumulated rather than snapshotted, because the
 * OpenAI chunk protocol does not guarantee they arrive in the first delta for a
 * given `index`. The previous code read both exactly once, at the moment the
 * index was first seen, with no path to correct them afterwards — KernelLoop
 * takes `name` off `content_block_start` (`:1078-1084`) and finaliseAccumulator
 * builds the `tool_use` block straight from it, and no `content_block_delta`
 * can change a name. Two spec-legal shapes therefore produced broken calls:
 *
 *   opener carries only `type`, id+name follow  →  id `call_0`, name `''`
 *   name streamed in fragments ('ba' + 'sh')    →  name truncated to 'ba'
 *
 * An empty name misses `toolByName` and fails the whole batch; a synthetic
 * `call_0` id is echoed back as `tool_call_id` and the provider 400s it. Both
 * surface as "the model's tool call vanished", pointing nowhere near the stream
 * decoder.
 */
interface PendingToolCall {
  blockIdx: number
  id: string
  name: string
  /** arguments seen before the block could be opened (needs a name first). */
  buffered: string
  started: boolean
}

/**
 * Name given to a tool call whose `function.name` never arrived on the wire.
 *
 * Deliberately not `''`: an empty name produces `Tool "" not found`, which
 * reads like a registry problem. This one says where to look.
 */
export const UNNAMED_TOOL_CALL = '__unnamed_tool_call__'

/** Pure normalization of the OpenAI chunk stream into Anthropic-shaped events.
 *
 * Exported for tests. This is the only place the OpenAI wire format is
 * interpreted, it is a pure function of the chunk sequence, and every
 * interesting case is a chunk shape rather than a network condition — so it is
 * exactly what a table-driven test should drive. It had 6% coverage and no test
 * file when the tool-call accumulation bug above was found. */
export async function* processStreamInner(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
): AsyncGenerator<StreamEvent> {
  {
    // Block index tracking
    let nextBlockIdx = 0
    let thinkingBlockIdx = -1
    let textBlockIdx = -1
    const toolCalls = new Map<number, PendingToolCall>()   // tc.index → accumulator

    // Usage (populated from final usage chunk)
    let inputTokens = 0
    let cacheReadTokens = 0
    let outputTokens = 0
    let stopReason: string | null = null

    for await (const chunk of stream) {

    // ── Usage chunk (last chunk, choices is empty) ──────────────────────────
    if (chunk.usage) {
      const u = chunk.usage as UsageWithDetails
      // Normalize to Anthropic semantics (non-cached input + separate cache
      // reads). Covers both the `prompt_tokens_details.cached_tokens` shape and
      // DeepSeek's native `prompt_cache_hit/miss_tokens` pair, and avoids
      // double-charging the cached portion downstream in CostTracker.
      const parsed = parseCacheUsage(u as unknown as Record<string, unknown>, 'deepseek')
      inputTokens = parsed.inputTokens
      cacheReadTokens = parsed.cacheReadTokens
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

        // Reserve the block index on FIRST sight so ordering matches the wire
        // order even when the block cannot be opened yet, but accumulate
        // id/name across every chunk that mentions this index.
        let pending = toolCalls.get(tcIdx)
        if (!pending) {
          pending = { blockIdx: nextBlockIdx++, id: '', name: '', buffered: '', started: false }
          toolCalls.set(tcIdx, pending)
        }
        if (tc.id) pending.id = tc.id
        // APPEND, never assign: a provider may fragment the name across deltas
        // ('ba' then 'sh'). Snapshotting it truncated the tool name to 'ba'.
        if (tc.function?.name) pending.name += tc.function.name

        // WHEN is a name known to be complete? The protocol's own signal is the
        // first non-empty `arguments` fragment: names never interleave with
        // args for the same index. So hold the block open-able but unopened
        // until args start flowing (or the stream ends), rather than committing
        // to whatever prefix happened to arrive first.
        const args = tc.function?.arguments ?? ''
        if (!pending.started && pending.name && args) {
          pending.started = true
          yield {
            type: 'content_block_start',
            index: pending.blockIdx,
            content_block: {
              type: 'tool_use',
              // A provider that never sends an id leaves us no choice but to
              // synthesize one; that at least keeps a single-call turn usable.
              id: pending.id || `call_${tcIdx}`,
              name: pending.name,
              input: {},
            } as never,
          }
          if (pending.buffered) {
            yield {
              type: 'content_block_delta',
              index: pending.blockIdx,
              delta: { type: 'input_json_delta', partial_json: pending.buffered } as never,
            }
            pending.buffered = ''
          }
        }

        if (args) {
          if (pending.started) {
            yield {
              type: 'content_block_delta',
              index: pending.blockIdx,
              delta: { type: 'input_json_delta', partial_json: args } as never,
            }
          } else {
            // Args before a usable name — keep them in wire order for the flush.
            pending.buffered += args
          }
        }
      }
    }

    if (choice.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason)
    }
    }

    // Flush every tool call that never saw an `arguments` fragment: a zero-arg
    // tool, or a call whose name arrived but whose args did not. Sorted by tool
    // index so parallel calls keep wire order.
    //
    // A call whose name NEVER arrived gets an explicit sentinel rather than
    // ''. An empty name fails `toolByName` with `Tool "" not found`, which
    // reads like a registry problem and sends the reader to the wrong file;
    // dropping the call silently would lose the turn's intent entirely.
    for (const [tcIdx, pending] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (pending.started) continue
      yield {
        type: 'content_block_start',
        index: pending.blockIdx,
        content_block: {
          type: 'tool_use',
          id: pending.id || `call_${tcIdx}`,
          name: pending.name || UNNAMED_TOOL_CALL,
          input: {},
        } as never,
      }
      if (pending.buffered) {
        yield {
          type: 'content_block_delta',
          index: pending.blockIdx,
          delta: { type: 'input_json_delta', partial_json: pending.buffered } as never,
        }
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
  }
}
