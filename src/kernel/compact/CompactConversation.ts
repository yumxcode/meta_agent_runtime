/**
 * CompactConversation — summarise the conversation history via a fork agent.
 * Mirrors CC's compact.ts / compactConversation.
 *
 * Flow:
 *  1. Build compact prompt (9-section + custom instructions)
 *  2. Strip images from messages to avoid PTL in the compact request
 *  3. Call the compact model (fork agent, querySource='compact')
 *     - PTL retry loop: up to 3 attempts, each time dropping oldest messages
 *  4. Format the summary
 *  5. Build post-compact messages (boundary + summary + re-attach files)
 *  6. Return CompactionResult
 */
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { KernelMessage } from '../types/KernelMessage.js'
import type { FileStateCache } from '../session/FileStateCache.js'
import type { ThinkingConfig } from '../types/KernelConfig.js'
import { stripImagesFromMessages, normalizeMessagesForAPI } from '../messages/MessageNormalizer.js'
import { normalizeMessagesForDeepSeek } from '../messages/DeepSeekMessageNormalizer.js'
import { buildAnthropicAuth } from '../api/AnthropicClient.js'
import { getModelProtocol } from '../../providers/registry.js'
import { buildCompactPrompt, formatCompactSummary, extractCompactInstructions } from './CompactPrompt.js'
import { buildPostCompactMessages } from './PostCompact.js'
import type { CompactionResult } from './PostCompact.js'

const COMPACT_MAX_PTL_RETRIES = 3
const COMPACT_MODEL_DEFAULT = 'deepseek-v4-flash'
const COMPACT_MAX_TOKENS = 65_536
const RECENT_USER_ANCHOR_COUNT = 6

export interface CompactOptions {
  model?: string
  apiKey?: string
  baseURL?: string
  systemPrompt?: string       // used to extract ## Compact Instructions
  /**
   * Explicit override. May be a thunk resolved here at compaction time so the
   * instructions reflect live session state rather than config-time state.
   */
  customInstructions?: string | (() => string | null | undefined)
  thinkingConfig?: ThinkingConfig
  abortSignal?: AbortSignal
  maxRetries?: number
  /** Messages that must remain visible after compact, outside the summary. */
  messagesToKeep?: readonly KernelMessage[]
}

/**
 * Run the compact summarisation.
 * Returns the CompactionResult (boundary + summary messages), or throws on failure.
 */
export async function compactConversation(
  messages: readonly KernelMessage[],
  fileCache: FileStateCache,
  options: CompactOptions = {},
): Promise<CompactionResult> {
  const compactModel = options.model ?? COMPACT_MODEL_DEFAULT

  // Resolve custom instructions. When a thunk is supplied, evaluate it now — at
  // compaction time — so the instructions reflect live session state (active
  // task IDs, phase, hardware constraints) rather than config-time state.
  // Coerce null → undefined so buildCompactPrompt treats "nothing to add" uniformly.
  const resolvedCustom =
    typeof options.customInstructions === 'function'
      ? options.customInstructions() ?? undefined
      : options.customInstructions
  // Fall back to extracting ## Compact Instructions from the system prompt.
  const customInstructions =
    resolvedCustom ??
    (options.systemPrompt ? extractCompactInstructions(options.systemPrompt) : undefined)

  const compactSystemPrompt = buildCompactPrompt(customInstructions)

  // Strip images to avoid PTL in the compact request
  const stripped = stripImagesFromMessages(messages)

  // PTL retry loop: drop oldest messages on each failure
  let messagesToSummarise = [...stripped]
  let lastError: unknown

  for (let attempt = 0; attempt < COMPACT_MAX_PTL_RETRIES; attempt++) {
    try {
      const summary = await callCompactModel(
        messagesToSummarise,
        compactSystemPrompt,
        compactModel,
        options,
      )

      const formatted = formatCompactSummary(summary)
      return buildPostCompactMessages(formatted, fileCache, options.messagesToKeep)
    } catch (error: unknown) {
      if (isPromptTooLong(error) && messagesToSummarise.length > 2) {
        // Drop old non-anchor messages first. Keep durable anchors such as the
        // first user request, compact summaries, and recent user messages.
        messagesToSummarise = trimPromptTooLongMessages(messagesToSummarise)
        lastError = error
        continue
      }
      throw error
    }
  }

  throw lastError ?? new Error('Compact failed: could not summarise conversation')
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function isRealUserMessage(message: KernelMessage): boolean {
  return message.role === 'user' &&
    !message.isMeta &&
    !message.isCompactSummary &&
    !message.isCompactBoundary &&
    !message.sourceToolAssistantUUID
}

function selectAnchorMessageIds(messages: readonly KernelMessage[]): Set<string> {
  const ids = new Set<string>()

  const firstUser = messages.find(isRealUserMessage)
  if (firstUser) ids.add(firstUser.uuid)

  for (const message of messages) {
    if (message.isCompactSummary) ids.add(message.uuid)
  }

  const recentUsers = messages
    .filter(isRealUserMessage)
    .slice(-RECENT_USER_ANCHOR_COUNT)
  for (const message of recentUsers) ids.add(message.uuid)

  return ids
}

function trimPromptTooLongMessages(messages: readonly KernelMessage[]): KernelMessage[] {
  const anchors = selectAnchorMessageIds(messages)
  const removable = messages.filter(message => !anchors.has(message.uuid))

  if (removable.length === 0) {
    return messages.slice(1)
  }

  const dropCount = Math.max(1, Math.floor(messages.length * 0.2))
  const toDrop = new Set(removable.slice(0, dropCount).map(message => message.uuid))
  return messages.filter(message => !toDrop.has(message.uuid))
}

async function callCompactModel(
  messages: KernelMessage[],
  systemPrompt: string,
  model: string,
  options: CompactOptions,
): Promise<string> {
  // Route to native OpenAI-format client for OpenAI-protocol providers (DeepSeek)
  if (getModelProtocol(model, options.baseURL) === 'openai') {
    return callCompactModelDeepSeek(messages, systemPrompt, model, options)
  }

  // Anthropic path (incl. Bearer-auth compat endpoints like Zhipu GLM)
  const client = new Anthropic({
    ...buildAnthropicAuth(options.apiKey, options.baseURL),
    baseURL: options.baseURL,
    maxRetries: options.maxRetries ?? 2,
  })

  const apiMessages = normalizeMessagesForAPI(messages)

  const response = await client.messages.create({
    model,
    max_tokens: COMPACT_MAX_TOKENS,
    system: systemPrompt,
    messages: apiMessages,
    // No tools — the prompt explicitly forbids tool use
  }, {
    signal: options.abortSignal,
  })

  // Extract text content from the response
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')

  if (!text.trim()) {
    throw new Error('Compact model returned empty response')
  }

  return text
}

async function callCompactModelDeepSeek(
  messages: KernelMessage[],
  systemPrompt: string,
  model: string,
  options: CompactOptions,
): Promise<string> {
  const client = new OpenAI({
    apiKey: options.apiKey ?? process.env['DEEPSEEK_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'],
    baseURL: options.baseURL ?? 'https://api.deepseek.com',
    maxRetries: options.maxRetries ?? 2,
  })

  // Compact is text-only — include systemPrompt and convert to OpenAI format
  const dsMessages = normalizeMessagesForDeepSeek(messages, systemPrompt)

  const response = await client.chat.completions.create(
    {
      model,
      max_tokens: COMPACT_MAX_TOKENS,
      messages: dsMessages as OpenAI.Chat.ChatCompletionMessageParam[],
      // No tools, no thinking — straightforward summarisation call
    },
    { signal: options.abortSignal },
  )

  const text = response.choices[0]?.message?.content ?? ''
  if (!text.trim()) {
    throw new Error('Compact model (DeepSeek) returned empty response')
  }

  return text
}

function isPromptTooLong(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as Record<string, unknown>
  if (e['status'] === 400 && typeof e['message'] === 'string') {
    const msg = e['message'].toLowerCase()
    if (msg.includes('prompt is too long') || msg.includes('prompt_too_long')) return true
  }
  if (typeof e['error'] === 'object' && e['error'] !== null) {
    const inner = e['error'] as Record<string, unknown>
    if (inner['type'] === 'prompt_too_long') return true
  }
  return false
}
