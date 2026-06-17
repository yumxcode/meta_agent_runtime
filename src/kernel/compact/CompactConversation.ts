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
import type { ContentBlock, KernelMessage } from '../types/KernelMessage.js'
import type { FileStateCache } from '../session/FileStateCache.js'
import type { ThinkingConfig } from '../types/KernelConfig.js'
import { stripImagesFromMessages, normalizeMessagesForAPI } from '../messages/MessageNormalizer.js'
import { normalizeMessagesForDeepSeek } from '../messages/DeepSeekMessageNormalizer.js'
import { buildAnthropicAuth } from '../api/AnthropicClient.js'
import { getModelProtocol } from '../../providers/registry.js'
import {
  buildCompactPrompt,
  formatCompactSummary,
  extractCompactInstructions,
  buildFallbackCompactSummary,
  enrichCompactSummaryWithContinuity,
  isUsableCompactSummary,
  isTurnComplete,
  COMPACT_FINAL_INSTRUCTION,
} from './CompactPrompt.js'
import type { CompactProfile } from './CompactPrompt.js'
import { buildPostCompactMessages } from './PostCompact.js'
import type { CompactionResult } from './PostCompact.js'
import { stripVolatileContextPrefix } from '../utils/VolatileContext.js'

const COMPACT_MAX_PTL_RETRIES = 3
export const COMPACT_MODEL_DEFAULT = 'deepseek-v4-flash'
export const COMPACT_MAX_TOKENS = 12_000
const RECENT_USER_ANCHOR_COUNT = 6
const COMPACT_TEXT_BLOCK_CHAR_LIMIT = 8_000
const COMPACT_TOOL_RESULT_BLOCK_CHAR_LIMIT = 4_000
const COMPACT_TOOL_RESULT_TOTAL_CHAR_BUDGET = 80_000
type ToolResultContent = Extract<ContentBlock, { type: 'tool_result' }>['content']

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
  /**
   * Deterministic state anchors appended to the summary output in every path
   * (rich/terse/empty-fallback). May be a thunk resolved here at compaction
   * time so the anchors reflect live session state. See CompactConfig.
   */
  deterministicAnchors?: string | (() => string | null | undefined)
  /**
   * The session's original goal — the first few real user requests (captured
   * before any compaction, pre-formatted into one string by KernelSession).
   * Emitted as a protected "Original session goal" line in the deterministic
   * continuity anchors of every summary path, so the goal cannot drift across
   * nested compactions ("telephone game" through summary-of-summary chains).
   */
  originalUserGoal?: string
  thinkingConfig?: ThinkingConfig
  abortSignal?: AbortSignal
  maxRetries?: number
  /** Messages that must remain visible after compact, outside the summary. */
  messagesToKeep?: readonly KernelMessage[]
  /** Per-mode section-template selector for the summariser prompt. */
  promptProfile?: CompactProfile
  /**
   * Auto mode only. When true, a NO-MODEL structural-truncation fallback runs
   * if the model compactor fails or its circuit breaker is open, so an
   * unattended session never grows into the blocking limit. See StructuralTruncate.
   */
  autonomyFallback?: boolean
}

class CompactEmptyResponseError extends Error {
  constructor(message = 'Compact model returned empty response') {
    super(message)
    this.name = 'CompactEmptyResponseError'
  }
}

class CompactPromptTooLongError extends Error {
  status = 400
  error = { type: 'prompt_too_long' }

  constructor(message = 'Compact model context window exceeded') {
    super(message)
    this.name = 'CompactPromptTooLongError'
  }
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

  // Decide turn ownership from the LIVE messages (before stripping/trimming):
  // a finished turn boundary gets the "await next instruction" postamble, an
  // interrupted turn keeps the "resume the last task" framing. Computed once
  // here and threaded into every post-compact build path below.
  const turnComplete = isTurnComplete(messages)

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

  // Resolve deterministic anchors the same way (thunk → live state). These are
  // appended to the summary OUTPUT, so they survive even when the model returns
  // a terse or empty summary.
  const extraAnchors =
    typeof options.deterministicAnchors === 'function'
      ? options.deterministicAnchors() ?? undefined
      : options.deterministicAnchors

  const compactSystemPrompt = buildCompactPrompt(customInstructions, options.promptProfile)

  // F-2 dedupe: messages the keep-set preserves verbatim outside the summary.
  // Kept units carry their ORIGINAL uuids; the user/steering text clones carry
  // the original's uuid in sourceUuid — collect both so the continuity anchors
  // and fallback summary never duplicate keep-set content.
  const excludeMessageUuids = collectKeepSetUuids(options.messagesToKeep)

  // Strip large/non-text payloads before the compact side-call. The compact
  // model needs the shape of recent work, not full historical command output.
  const stripped = shrinkMessagesForCompact(stripImagesFromMessages(messages))

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
      // Quality gate: a non-empty response is not necessarily a summary.
      // Observed failure mode (GLM, no tools armed): the "summary" is 100%
      // leaked tool-call template text — formatCompactSummary strips it,
      // leaving (near-)nothing. Propagating that through nested compactions
      // destroys the session narrative; the deterministic local fallback is
      // strictly better.
      if (!isUsableCompactSummary(formatted, summary)) {
        const fallback = buildFallbackCompactSummary(stripped, {
          extraAnchors,
          originalUserGoal: options.originalUserGoal,
          excludeMessageUuids,
        })
        return buildPostCompactMessages(fallback, fileCache, options.messagesToKeep, turnComplete)
      }
      const enrichedSummary = enrichCompactSummaryWithContinuity(formatted, stripped, {
        extraAnchors,
        originalUserGoal: options.originalUserGoal,
        excludeMessageUuids,
      })
      return buildPostCompactMessages(enrichedSummary, fileCache, options.messagesToKeep, turnComplete)
    } catch (error: unknown) {
      if (isCompactEmptyResponse(error)) {
        const fallback = buildFallbackCompactSummary(stripped, {
          extraAnchors,
          originalUserGoal: options.originalUserGoal,
          excludeMessageUuids,
        })
        return buildPostCompactMessages(fallback, fileCache, options.messagesToKeep, turnComplete)
      }
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

  if (isPromptTooLong(lastError)) {
    const fallback = buildFallbackCompactSummary(stripped, {
      extraAnchors,
      originalUserGoal: options.originalUserGoal,
      excludeMessageUuids,
    })
    return buildPostCompactMessages(fallback, fileCache, options.messagesToKeep, turnComplete)
  }

  throw lastError ?? new Error('Compact failed: could not summarise conversation')
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Collect the identity set of the keep-set: original uuids of kept units plus
 * the sourceUuid of each text clone. Used to exclude keep-set-covered messages
 * from the summary's recent-detail / fallback sections (F-2 dedupe).
 */
function collectKeepSetUuids(
  messagesToKeep: readonly KernelMessage[] | undefined,
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const message of messagesToKeep ?? []) {
    ids.add(message.uuid)
    if (message.sourceUuid) ids.add(message.sourceUuid)
  }
  return ids
}

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

function shrinkMessagesForCompact(messages: readonly KernelMessage[]): KernelMessage[] {
  let remainingToolResultChars = COMPACT_TOOL_RESULT_TOTAL_CHAR_BUDGET

  return [...messages].reverse().map(message => {
    const content = message.content.map(block => {
      if (block.type === 'text') {
        const text = stripVolatileContextPrefix(block.text)
        return {
          ...block,
          text: clipForCompact(text, COMPACT_TEXT_BLOCK_CHAR_LIMIT, 'text block'),
        }
      }

      if (block.type === 'tool_result') {
        const [content, remaining] = shrinkToolResultContent(
          block.content,
          remainingToolResultChars,
        )
        remainingToolResultChars = remaining
        return { ...block, content }
      }

      return block
    })
    return { ...message, content }
  }).reverse()
}

function shrinkToolResultContent(
  content: ToolResultContent,
  remainingBudget: number,
): [ToolResultContent, number] {
  if (typeof content === 'string') {
    const allowed = Math.min(COMPACT_TOOL_RESULT_BLOCK_CHAR_LIMIT, remainingBudget)
    const next = Math.max(0, remainingBudget - Math.min(content.length, allowed))
    return [clipToolResultForCompact(content, allowed), next]
  }

  if (Array.isArray(content)) {
    let remaining = remainingBudget
    const nextContent = content.map(item => {
      if (!item || typeof item !== 'object') return item
      const block = item as unknown as Record<string, unknown>
      if (block['type'] !== 'text' || typeof block['text'] !== 'string') return item
      const allowed = Math.min(COMPACT_TOOL_RESULT_BLOCK_CHAR_LIMIT, remaining)
      remaining = Math.max(0, remaining - Math.min(block['text'].length, allowed))
      return {
        ...block,
        text: clipToolResultForCompact(block['text'], allowed),
      }
    })
    return [nextContent as ToolResultContent, remaining]
  }

  return [content, remainingBudget]
}

function clipToolResultForCompact(text: string, limit: number): string {
  if (limit <= 0) {
    return `[tool_result omitted for compact; original length ${text.length} chars]`
  }
  return clipForCompact(text, limit, 'tool_result')
}

function clipForCompact(text: string, limit: number, label: string): string {
  if (text.length <= limit) return text
  const suffix = `\n[${label} truncated for compact; original length ${text.length} chars]`
  return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`
}

/**
 * Append the summarization instruction as the LAST user message — adjacent to
 * the generation point, where it outweighs the tool-call pattern saturation of
 * the conversation body (see COMPACT_FINAL_INSTRUCTION). Applied inside the
 * model-call so PTL retries (which trim old messages) always keep it last.
 */
function withFinalInstruction(messages: readonly KernelMessage[]): KernelMessage[] {
  return [
    ...messages,
    {
      uuid: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: COMPACT_FINAL_INSTRUCTION }],
      isMeta: true,
    },
  ]
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

  const apiMessages = normalizeMessagesForAPI(withFinalInstruction(messages))

  const response = await client.messages.create({
    model,
    max_tokens: COMPACT_MAX_TOKENS,
    system: systemPrompt,
    messages: apiMessages,
    // No tools — the prompt explicitly forbids tool use
  }, {
    signal: options.abortSignal,
  })

  if (isCompactContextWindowStop(response.stop_reason)) {
    throw new CompactPromptTooLongError(`Compact model stopped: ${response.stop_reason}`)
  }

  // Extract text content from the response
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')

  if (!text.trim()) {
    throw new CompactEmptyResponseError()
  }

  return text
}

function isCompactContextWindowStop(stopReason: unknown): boolean {
  return typeof stopReason === 'string' &&
    (stopReason.includes('context_window_exceeded') ||
      stopReason.includes('prompt_too_long'))
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
  const dsMessages = normalizeMessagesForDeepSeek(withFinalInstruction(messages), systemPrompt)

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
    throw new CompactEmptyResponseError('Compact model (DeepSeek) returned empty response')
  }

  return text
}

function isCompactEmptyResponse(error: unknown): boolean {
  return error instanceof CompactEmptyResponseError
}

function isPromptTooLong(error: unknown): boolean {
  if (error instanceof CompactPromptTooLongError) return true
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
