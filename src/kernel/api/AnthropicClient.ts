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
import {
  isRetryableError,
  isPromptTooLongError,
  isFallbackTriggeredError,
  PromptTooLongError,
  FallbackTriggeredError,
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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

  const client = new Anthropic({
    apiKey: config.apiKey ?? process.env['ANTHROPIC_API_KEY'],
    baseURL: config.baseURL,
    maxRetries: 0, // We handle retries ourselves
    ...(betaHeader ? { defaultHeaders: { 'anthropic-beta': betaHeader } } : {}),
  })

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

  let attempt = 0
  while (true) {
    try {
      const stream = await client.messages.create(requestParams, {
        signal: params.abortSignal,
      })

      for await (const event of stream) {
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
      await sleep(delayMs)
    }
  }
}
