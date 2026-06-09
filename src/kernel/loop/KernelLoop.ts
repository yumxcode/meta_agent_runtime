/**
 * KernelLoop — the while(true) agentic loop.
 *
 * Direct equivalent of CC's query.ts queryLoop().
 * Step numbers match cc-kernel-rewrite-detailed-plan.md §2.2.
 */
import type { KernelConfig } from '../types/KernelConfig.js'
import type { KernelEvent, PermissionDenial } from '../types/KernelEvent.js'
import type { KernelMessage, ContentBlock } from '../types/KernelMessage.js'
import type { KernelToolContext } from '../types/KernelTool.js'
import type { TokenUsage } from '../types/TokenUsage.js'
import { emptyUsage, addUsage } from '../types/TokenUsage.js'
import { initialLoopState, type LoopState } from './LoopState.js'
import { applyToolResultBudget } from '../tools/ToolResultBudget.js'
import { autoCompactIfNeeded, shouldAutoCompact, type AutoCompactTrackingState } from '../compact/AutoCompact.js'
import { streamMessages } from '../api/AnthropicClient.js'
import { streamDeepSeekMessages } from '../api/DeepSeekClient.js'
import {
  normalizeMessagesForAPI,
  getMessagesAfterCompactBoundary,
  stripThinkingBlocksFromMessages,
} from '../messages/MessageNormalizer.js'
import { normalizeMessagesForDeepSeek } from '../messages/DeepSeekMessageNormalizer.js'
import {
  makeAssistantMessage,
  makeInterruptionMessage,
  makeMaxOutputTokensRecoveryMessage,
  makeTextUserMessage,
} from '../messages/MessageFactory.js'
import {
  runTools,
  buildMissingToolResultMessages,
} from '../tools/ToolOrchestration.js'
import { defaultCanUseTool } from '../permissions/CanUseTool.js'
import {
  calculateTokenWarningState,
  ESCALATED_MAX_TOKENS,
  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
} from '../utils/Context.js'
import { tokenCountWithEstimation } from '../api/TokenCount.js'
import {
  isMaxOutputTokensStopReason,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  PromptTooLongError,
  FallbackTriggeredError,
} from '../api/Errors.js'
import { calcCostUsd } from '../utils/CostTracker.js'
import { parseCacheUsage } from '../utils/parseCacheUsage.js'
import { getModelProtocol } from '../../providers/registry.js'
import { assembleSystemPrompt } from '../utils/AssembleSystemPrompt.js'
import type { FileStateCache } from '../session/FileStateCache.js'

const VOLATILE_CONTEXT_PREFIX_START = '<context>\n'
const VOLATILE_CONTEXT_PREFIX_END = '\n</context>\n\n---\n\n'

// ── Return type ───────────────────────────────────────────────────────────────

export type LoopTerminationReason =
  | 'success'
  | 'max_turns'
  | 'no_progress'
  | 'blocking_limit'
  | 'aborted_streaming'
  | 'aborted_tools'
  | 'max_budget_usd'
  | 'error'

export interface LoopResult {
  reason: LoopTerminationReason
  totalUsage: TokenUsage
  costUsd: number
  numTurns: number
  resultText: string
  finalModel: string
  fallbackTriggered: boolean
  permissionDenials: PermissionDenial[]
  finalMessages: KernelMessage[]
  autoCompactTracking: AutoCompactTrackingState | undefined
}

// ── Context passed in from KernelSession ─────────────────────────────────────

export interface KernelLoopContext {
  config: KernelConfig
  /** Shared mutable array — the loop appends to it; KernelSession owns it */
  mutableMessages: KernelMessage[]
  abortController: AbortController
  fileCache: FileStateCache
  sessionId: string
  cwd: string
  cumulativeCostUsd: number
  autoCompactTracking?: AutoCompactTrackingState
  /**
   * Drain any pending mid-turn user corrections ("steering"). Called at the top
   * of every loop iteration. Returns the queued correction strings (and clears
   * the queue). Each is appended as a user message BEFORE the next API request,
   * so the model incorporates the correction at the next natural boundary —
   * without aborting the in-flight stream. Undefined / empty when no steering is
   * wired or queued.
   */
  drainSteering?: () => string[]
}

function stripVolatileContextPrefix(text: string): string {
  if (!text.startsWith(VOLATILE_CONTEXT_PREFIX_START)) return text
  const end = text.lastIndexOf(VOLATILE_CONTEXT_PREFIX_END)
  if (end < 0) return text
  return text.slice(end + VOLATILE_CONTEXT_PREFIX_END.length)
}

function isRealUserMessage(message: KernelMessage): boolean {
  return message.role === 'user' &&
    !message.isMeta &&
    !message.isCompactSummary &&
    !message.isCompactBoundary &&
    !message.sourceToolAssistantUUID
}

function cloneLastRealUserTextMessage(messages: readonly KernelMessage[]): KernelMessage[] {
  const message = [...messages].reverse().find(isRealUserMessage)
  if (!message) return []

  const textBlocks = message.content
    .filter((block): block is ContentBlock & { type: 'text'; text: string } =>
      block.type === 'text' && typeof (block as { text?: unknown }).text === 'string',
    )
    .map(block => ({
      ...block,
      text: stripVolatileContextPrefix(block.text),
    }))
    .filter(block => block.text.trim().length > 0)

  if (textBlocks.length === 0) return []

  return [{
    uuid: crypto.randomUUID(),
    role: 'user',
    content: textBlocks,
  }]
}

/**
 * Token budget for the "current-turn tail" preserved verbatim across a
 * compaction. The tail (the assistant ⇄ tool_result cycles since the last real
 * user message) is kept OUTSIDE the summary so the freshest tool_use/tool_result
 * pairs survive at full fidelity instead of being lossily folded into the flash
 * summary.
 *
 * It is bounded so a long inner loop can't defeat the point of compacting:
 * summary (≤ COMPACT_MAX_TOKENS ≈ 12k) + tail (≤ this budget) stays well under
 * any realistic compaction threshold, so preserving the tail cannot itself
 * re-trigger an immediate compaction (infinite-loop guard).
 */
const CURRENT_TURN_TAIL_TOKEN_BUDGET = 40_000

/** Per-message rough token estimate. Mirrors TokenCount.roughTokenCount. */
function estimateMessageTokens(message: KernelMessage): number {
  let chars = 0
  for (const block of message.content) {
    if ('text' in block && typeof block.text === 'string') {
      chars += block.text.length
    } else if ('thinking' in block && typeof (block as { thinking?: unknown }).thinking === 'string') {
      chars += (block as { thinking: string }).thinking.length
    } else if ('input' in block) {
      chars += JSON.stringify((block as { input?: unknown }).input ?? {}).length
    } else if ('content' in block) {
      const c = (block as { content?: unknown }).content
      if (typeof c === 'string') {
        chars += c.length
      } else if (Array.isArray(c)) {
        for (const inner of c) {
          if (inner && typeof inner === 'object' && 'text' in inner) {
            chars += String((inner as { text?: unknown }).text ?? '').length
          }
        }
      }
    }
  }
  return Math.ceil(chars / 4)
}

/**
 * Group a message tail into "units", where each unit is one assistant message
 * plus the user (tool_result / meta) messages that follow it up to the next
 * assistant message. Leading non-assistant messages (e.g. an injected steering
 * message that sits before the first assistant reply) are dropped — they cannot
 * form a valid standalone unit and the real user text is preserved separately.
 */
function groupTailUnits(tail: readonly KernelMessage[]): KernelMessage[][] {
  const units: KernelMessage[][] = []
  let current: KernelMessage[] | null = null
  for (const message of tail) {
    if (message.role === 'assistant') {
      if (current) units.push(current)
      current = [message]
    } else if (current) {
      current.push(message)
    }
  }
  if (current) units.push(current)
  return units
}

/**
 * A unit is "complete" (safe to send to the API) iff every tool_use block in
 * its head assistant message has a matching tool_result in the following user
 * messages. A text-only assistant message (no tool_use) is trivially complete.
 * This is the protocol guard: we never keep half a tool pair.
 */
function isCompleteTailUnit(unit: readonly KernelMessage[]): boolean {
  const head = unit[0]
  if (!head || head.role !== 'assistant') return false

  const toolUseIds = head.content
    .filter(block => block.type === 'tool_use')
    .map(block => (block as { id: string }).id)
  if (toolUseIds.length === 0) return true

  const resultIds = new Set<string>()
  for (let i = 1; i < unit.length; i++) {
    for (const block of unit[i]!.content) {
      if (block.type === 'tool_result') {
        resultIds.add((block as { tool_use_id: string }).tool_use_id)
      }
    }
  }
  return toolUseIds.every(id => resultIds.has(id))
}

/**
 * Build the messages to preserve verbatim after a compaction:
 *   [ <last real user message, text-only, stripped> , ...<bounded current-turn tail> ]
 *
 * The tail is taken from the messages AFTER the last real user message, grouped
 * into complete assistant⇄tool_result units, then accumulated newest-first until
 * the token budget is hit (always keeping at least the most recent complete
 * unit). applyToolResultBudget is applied first so a single oversized result is
 * still clipped to the per-tool limit — identical to normal-flow behaviour.
 */
export function buildMessagesToKeepAfterCompact(
  messages: readonly KernelMessage[],
  tools: KernelConfig['tools'],
  budgetTokens: number = CURRENT_TURN_TAIL_TOKEN_BUDGET,
): KernelMessage[] {
  // Constraint: per-tool clipping, consistent with the live loop.
  const budgeted = applyToolResultBudget(messages, tools)

  const userText = cloneLastRealUserTextMessage(budgeted)

  let lastUserIdx = -1
  for (let i = budgeted.length - 1; i >= 0; i--) {
    if (isRealUserMessage(budgeted[i]!)) { lastUserIdx = i; break }
  }
  if (lastUserIdx < 0) return userText

  const tail = budgeted.slice(lastUserIdx + 1)
  const units = groupTailUnits(tail).filter(isCompleteTailUnit)

  const kept: KernelMessage[][] = []
  let used = 0
  for (let i = units.length - 1; i >= 0; i--) {
    const unitTokens = units[i]!.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
    // Guard: always keep the most recent complete unit (kept.length === 0),
    // even if it alone exceeds the budget — its results are already per-tool
    // clipped, so this can't blow up unbounded.
    if (kept.length > 0 && used + unitTokens > budgetTokens) break
    kept.unshift(units[i]!)
    used += unitTokens
  }

  return [...userText, ...kept.flat()]
}

/**
 * Wrap a raw user correction so the model reads it as live supplemental guidance
 * rather than a brand-new task. Mirrors the redirect-message phrasing used by
 * the permission policy's option 3.
 */
export function formatSteeringMessage(text: string): string {
  return `[用户实时补充指导]\n${text}\n\n请将上述指导纳入考虑，并据此调整接下来的规划与执行。`
}

// ── Streaming accumulator for one assistant message ───────────────────────────

type PartialBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: string }

interface StreamAccumulator {
  blocks: (PartialBlock | null)[]
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  stopReason: string | null
}

/**
 * Abort-aware delay. Resolves early (without rejecting) if the signal aborts so
 * the caller can re-check `signal.aborted` and bail cleanly.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise<void>(resolve => {
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Condense a model-call error into a single sanitized line for surfacing into
 * the conversation and the warning event. Prefers a nested `error.message`
 * (provider error envelopes) and strips control chars / caps length.
 */
function summarizeStreamError(err: unknown): string {
  let msg: string
  if (err instanceof Error) {
    msg = err.message
  } else if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>
    const nested = rec['error']
    if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>)['message'] === 'string') {
      msg = String((nested as Record<string, unknown>)['message'])
    } else if (typeof rec['message'] === 'string') {
      msg = String(rec['message'])
    } else {
      try { msg = JSON.stringify(err) } catch { msg = String(err) }
    }
  } else {
    msg = String(err)
  }
  // eslint-disable-next-line no-control-regex
  msg = msg.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return msg.length > 500 ? msg.slice(0, 500) + '…' : msg
}

/** Guidance message injected into history so the model can self-correct. */
function buildStreamErrorRecoveryText(detail: string): string {
  return (
    `[系统] 上一步模型调用失败：${detail}\n` +
    `这通常是网络/网关瞬时波动，或本轮上下文过大（例如抓取了过长的文档）。\n` +
    `请据此决定如何继续：若判断为瞬时错误可直接重试当前步骤；` +
    `若可能是上下文过大，请避免再次注入大段原文（改用更小范围/分页抓取或只取关键片段），` +
    `或基于已掌握的信息直接继续推进，不要因此中断任务。`
  )
}

function newAccumulator(): StreamAccumulator {
  return {
    blocks: [],
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    stopReason: null,
  }
}

function finaliseAccumulator(acc: StreamAccumulator): {
  content: ContentBlock[]
  usage: TokenUsage
  stopReason: string | null
} {
  const content: ContentBlock[] = []
  for (const block of acc.blocks) {
    if (!block) continue
    if (block.type === 'text') {
      if (block.text) content.push({ type: 'text', text: block.text })
    } else if (block.type === 'thinking') {
      content.push({ type: 'thinking', thinking: block.thinking } as ContentBlock)
    } else if (block.type === 'redacted_thinking') {
      content.push({ type: 'redacted_thinking', data: block.data } as ContentBlock)
    } else if (block.type === 'tool_use') {
      let parsed: unknown = {}
      try { parsed = JSON.parse(block.input || '{}') } catch { /* ok */ }
      content.push({ type: 'tool_use', id: block.id, name: block.name, input: parsed })
    }
  }

  return {
    content,
    usage: {
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens,
    },
    stopReason: acc.stopReason,
  }
}

const NO_PROGRESS_REPEAT_LIMIT = 3

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? String(value) : encoded
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

// ── Main loop ────────────────────────────────────────────────────────────────

export async function* runKernelLoop(
  ctx: KernelLoopContext,
): AsyncGenerator<KernelEvent, LoopResult> {
  const { config, mutableMessages, abortController, fileCache, sessionId } = ctx
  const signal = abortController.signal
  const canUseTool = config.canUseTool ?? defaultCanUseTool
  const maxTurns = config.maxTurns ?? 100

  // S3: pass the live mutableMessages reference into the initial loop state.
  // Both LoopState.messages and mutableMessages will stay in sync without
  // per-turn O(n) array copies (see append() comment below).
  let state: LoopState = initialLoopState(mutableMessages, config.model, ctx.autoCompactTracking)
  let totalUsage: TokenUsage = emptyUsage()
  let totalCost = ctx.cumulativeCostUsd
  let allPermissionDenials: PermissionDenial[] = []
  let resultText = ''
  let lastToolRequestSignature = ''
  let repeatedToolRequestCount = 0

  // Helper: push messages and re-point state.messages at the live array.
  //
  // S3: previously we did `state = { ...state, messages: [...mutableMessages] }`
  // here, which allocated a fresh O(n) copy of the message list on every
  // append (~2-3 times per turn).  In a 100-turn session that's ~15k array
  // copies and tens of MB of GC pressure that hurt p99 latency on small heaps.
  //
  // mutableMessages and state.messages were already in lock-step (the only
  // place state.messages diverged from mutableMessages is the compact
  // replacement below, which mutates both via splice).  Sharing the same
  // reference is therefore safe and removes the copy entirely.
  function append(...msgs: KernelMessage[]): void {
    mutableMessages.push(...msgs)
    state = { ...state, messages: mutableMessages }
  }

  function done(reason: LoopTerminationReason): LoopResult {
    return {
      reason,
      totalUsage,
      costUsd: totalCost,
      numTurns: state.turnCount,
      resultText,
      finalModel: state.currentModel,
      fallbackTriggered: state.fallbackTriggered,
      permissionDenials: allPermissionDenials,
      finalMessages: [...mutableMessages],
      autoCompactTracking: state.autoCompactTracking,
    }
  }

  while (true) {
    // ── Step 0: inject mid-turn user steering ────────────────────────────────
    // The user can submit a correction at any point during a turn (e.g. via a
    // CLI hotkey). We never abort the model; instead we drain the queue here, at
    // the loop boundary, and append each correction as a user message so the
    // NEXT API request sees it. normalizeMessagesForAPI coalesces it with any
    // trailing tool_result (user-role) message, preserving role alternation; for
    // DeepSeek it becomes a plain user message after the tool messages.
    const steers = ctx.drainSteering?.() ?? []
    for (const steerText of steers) {
      const trimmed = steerText.trim()
      if (!trimmed) continue
      append(makeTextUserMessage(formatSteeringMessage(trimmed), { isMeta: false }))
    }

    // ── Step 1: applyToolResultBudget ────────────────────────────────────────
    const budgetedMessages = applyToolResultBudget(state.messages, config.tools)

    // ── Step 5: autoCompactIfNeeded ──────────────────────────────────────────
    const messagesForQuery = [...getMessagesAfterCompactBoundary(budgetedMessages)]
    // L1: route through assembleSystemPrompt so "" / undefined are treated
    // identically and there's one canonical place to change the join rule.
    const effectiveSystemPrompt =
      assembleSystemPrompt(config.systemPrompt, config.appendSystemPrompt) ?? ''
    const messagesToKeepAfterCompact = buildMessagesToKeepAfterCompact(messagesForQuery, config.tools)

    // Surface a "compacting…" indicator before the slow LLM-backed summarization
    // begins. We probe the same gates autoCompactIfNeeded uses so the event only
    // fires when a compaction will actually run.
    if (
      config.compact?.enabled !== false &&
      shouldAutoCompact(
        messagesForQuery,
        state.currentModel,
        config.compact?.querySource ?? config.querySource,
        state.autoCompactTracking,
        state.maxOutputTokensOverride ?? config.maxOutputTokens,
        config.compact?.model,
      )
    ) {
      yield { type: 'compact_start', sessionId }
    }

    const compactResult = config.compact?.enabled === false
      ? {
          wasCompacted: false,
          tracking: state.autoCompactTracking ?? {
            compacted: false,
            turnId: crypto.randomUUID(),
            turnCounter: 0,
            consecutiveFailures: 0,
          },
        }
      : await autoCompactIfNeeded(
          messagesForQuery,
          state.currentModel,
          fileCache,
          config.compact?.querySource ?? config.querySource,
          state.autoCompactTracking,
          state.maxOutputTokensOverride ?? config.maxOutputTokens,
          {
            model: config.compact?.model,
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            systemPrompt: effectiveSystemPrompt,
            customInstructions: config.compact?.customInstructions,
            deterministicAnchors: config.compact?.deterministicAnchors,
            messagesToKeep: messagesToKeepAfterCompact,
            abortSignal: signal,
            maxRetries: config.maxRetries,
          },
        )

    state = { ...state, autoCompactTracking: compactResult.tracking }
    if (compactResult.failure) {
      yield {
        type: 'compact_failed',
        attempt: compactResult.failure.attempt,
        querySource: compactResult.failure.querySource,
        error: compactResult.failure.error,
        consecutiveFailures: compactResult.failure.consecutiveFailures,
        sessionId,
      }
    }

    let currentMessagesForQuery: KernelMessage[]

    if (compactResult.wasCompacted && compactResult.postCompactMessages) {
      const compactMsgs = compactResult.postCompactMessages
      // Replace mutableMessages + state with compacted version. The compact
      // summary is now the authoritative continuation; keeping pre-compact
      // messages here would preserve the memory/persistence growth that compact
      // is meant to relieve.
      mutableMessages.splice(0, mutableMessages.length, ...compactMsgs)
      // S3: same reasoning as append() — keep state.messages pointing at the
      // live mutableMessages array instead of allocating a fresh copy.
      state = { ...state, messages: mutableMessages }
      currentMessagesForQuery = [...getMessagesAfterCompactBoundary(state.messages)]

      yield {
        type: 'compact_boundary',
        compactMetadata: {
          summaryTokens: compactResult.summaryTokenEstimate ?? 0,
          previousTokens: tokenCountWithEstimation(messagesForQuery),
        },
        sessionId,
      }
    } else {
      currentMessagesForQuery = messagesForQuery
    }

    // ── Step 6: blocking limit check ─────────────────────────────────────────
    const tokenCount = tokenCountWithEstimation(currentMessagesForQuery)
    const { isAtBlockingLimit } = calculateTokenWarningState(
      tokenCount,
      state.currentModel,
      state.maxOutputTokensOverride ?? config.maxOutputTokens,
    )

    if (isAtBlockingLimit) {
      resultText = PROMPT_TOO_LONG_ERROR_MESSAGE
      yield { type: 'text_delta', delta: PROMPT_TOO_LONG_ERROR_MESSAGE, sessionId }
      return done('blocking_limit')
    }

    // ── Steps 7+8: stream API + accumulate messages ───────────────────────────
    const systemPrompt = effectiveSystemPrompt
    const messagesForApi = state.fallbackTriggered
      ? stripThinkingBlocksFromMessages(currentMessagesForQuery)
      : currentMessagesForQuery

    const assistantMessages: KernelMessage[] = []
    const acc = newAccumulator()
    let streamError: unknown = null

    // Route to OpenAI-format (DeepSeek) or Anthropic-format wire protocol via
    // the provider registry — baseURL wins, model name is the fallback signal.
    const isDeepSeek = getModelProtocol(state.currentModel, config.baseURL) === 'openai'

    try {
      const retryEvents: KernelEvent[] = []
      const retryCallback = (attempt: number, maxRetries: number, retryDelayMs: number, errorStatus: number | null): void => {
        retryEvents.push({ type: 'api_retry', attempt, maxRetries, retryDelayMs, errorStatus, sessionId })
      }

      const eventStream = isDeepSeek
        ? streamDeepSeekMessages(
            {
              model: state.currentModel,
              sessionId,
              messages: normalizeMessagesForDeepSeek(
                messagesForApi,
                systemPrompt || undefined,
              ),
              tools: config.tools,
              thinkingConfig: state.fallbackTriggered
                ? (config.fallbackThinkingConfig ?? { type: 'disabled' })
                : config.thinkingConfig,
              maxOutputTokens: state.maxOutputTokensOverride ?? config.maxOutputTokens,
              abortSignal: signal,
            },
            config,
            retryCallback,
          )
        : streamMessages(
            {
              model: state.currentModel,
              sessionId,
              messages: normalizeMessagesForAPI(messagesForApi),
              systemPrompt: systemPrompt || undefined,
              tools: config.tools,
              thinkingConfig: state.fallbackTriggered
                ? (config.fallbackThinkingConfig ?? { type: 'disabled' })
                : config.thinkingConfig,
              maxOutputTokens: state.maxOutputTokensOverride ?? config.maxOutputTokens,
              abortSignal: signal,
              betas: state.fallbackTriggered
                ? (config.fallbackBetas ?? [])
                : config.betas,
              includeDefaultBetas: state.fallbackTriggered
                ? (config.fallbackIncludeDefaultBetas ?? false)
                : (config.includeDefaultBetas ?? true),
            },
            config,
            retryCallback,
          )

      for await (const event of eventStream) {
        // Drain any pending retry events
        for (const retryEvent of retryEvents.splice(0)) {
          yield retryEvent
        }

        switch (event.type) {
          case 'message_start': {
            // Provider-tolerant parse: GLM/Zhipu rides the Anthropic wire format
            // but may report cache hits in the OpenAI `prompt_tokens_details`
            // shape; DeepSeek may use the `prompt_cache_hit/miss` pair. Reading
            // only `cache_read_input_tokens` would record those as 0. Also covers
            // the raw Anthropic `{ message: { usage } }` nesting.
            const u = parseCacheUsage(event as unknown as Record<string, unknown>)
            acc.inputTokens = u.inputTokens
            acc.cacheReadTokens = u.cacheReadTokens
            acc.cacheWriteTokens = u.cacheWriteTokens
            break
          }

          case 'content_block_start': {
            const cb = event.content_block
            if (cb.type === 'text') {
              acc.blocks[event.index] = { type: 'text', text: '' }
            } else if (cb.type === 'thinking') {
              acc.blocks[event.index] = { type: 'thinking', thinking: '' }
            } else if (cb.type === 'redacted_thinking') {
              acc.blocks[event.index] = { type: 'redacted_thinking', data: (cb as { data?: string }).data ?? '' }
            } else if (cb.type === 'tool_use') {
              acc.blocks[event.index] = {
                type: 'tool_use',
                id: (cb as { id: string }).id,
                name: (cb as { name: string }).name,
                input: '',
              }
            }
            break
          }

          case 'content_block_delta': {
            const block = acc.blocks[event.index]
            if (!block) break
            const delta = event.delta as unknown as Record<string, unknown>
            if (delta['type'] === 'text_delta' && block.type === 'text') {
              const text = String(delta['text'] ?? '')
              block.text += text
              yield { type: 'text_delta', delta: text, sessionId }
            } else if (delta['type'] === 'thinking_delta' && block.type === 'thinking') {
              const thinkingChunk = String(delta['thinking'] ?? '')
              block.thinking += thinkingChunk
              if (thinkingChunk) {
                yield { type: 'thinking_delta', delta: thinkingChunk, sessionId }
              }
            } else if (delta['type'] === 'input_json_delta' && block.type === 'tool_use') {
              block.input += String(delta['partial_json'] ?? '')
            }
            break
          }

          case 'message_delta': {
            acc.stopReason = event.delta?.stop_reason ?? null
            acc.outputTokens = event.usage?.output_tokens ?? 0
            // Anthropic (and GLM/Zhipu on the compat endpoint) report the
            // authoritative final input / cache counts on message_delta, not
            // message_start. Override with any non-zero values seen here so the
            // footer doesn't show in:0 when the provider defers usage to the end.
            const d = parseCacheUsage(event as unknown as Record<string, unknown>)
            if (d.inputTokens > 0) acc.inputTokens = d.inputTokens
            if (d.cacheReadTokens > 0) acc.cacheReadTokens = d.cacheReadTokens
            if (d.cacheWriteTokens > 0) acc.cacheWriteTokens = d.cacheWriteTokens
            break
          }

          case 'message_stop': {
            const { content, usage, stopReason } = finaliseAccumulator(acc)
            const assistantMsg = makeAssistantMessage(content, { usage, stopReason })
            assistantMessages.push(assistantMsg)
            totalUsage = addUsage(totalUsage, usage)
            totalCost += calcCostUsd(usage, state.currentModel)
            // Reset accumulator for potential next message in same stream
            Object.assign(acc, newAccumulator())
            break
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof PromptTooLongError) {
        if (
          config.compact?.enabled !== false &&
          !state.hasAttemptedReactiveCompact
        ) {
          // Reactive compaction is forced (the request already overflowed), so a
          // compaction is guaranteed to run here — announce it before the wait.
          yield { type: 'compact_start', sessionId }
          const reactiveCompactResult = await autoCompactIfNeeded(
            currentMessagesForQuery,
            state.currentModel,
            fileCache,
            config.compact?.querySource ?? config.querySource,
            state.autoCompactTracking,
            state.maxOutputTokensOverride ?? config.maxOutputTokens,
            {
              model: config.compact?.model,
              apiKey: config.apiKey,
              baseURL: config.baseURL,
              systemPrompt: effectiveSystemPrompt,
              customInstructions: config.compact?.customInstructions,
              deterministicAnchors: config.compact?.deterministicAnchors,
              messagesToKeep: buildMessagesToKeepAfterCompact(currentMessagesForQuery, config.tools),
              abortSignal: signal,
              maxRetries: config.maxRetries,
            },
            true,
          )
          state = {
            ...state,
            autoCompactTracking: reactiveCompactResult.tracking,
            hasAttemptedReactiveCompact: true,
          }
          if (reactiveCompactResult.failure) {
            yield {
              type: 'compact_failed',
              attempt: reactiveCompactResult.failure.attempt,
              querySource: reactiveCompactResult.failure.querySource,
              error: reactiveCompactResult.failure.error,
              consecutiveFailures: reactiveCompactResult.failure.consecutiveFailures,
              sessionId,
            }
          }
          if (reactiveCompactResult.wasCompacted && reactiveCompactResult.postCompactMessages) {
            mutableMessages.splice(0, mutableMessages.length, ...reactiveCompactResult.postCompactMessages)
            state = { ...state, messages: [...mutableMessages] }
            yield {
              type: 'compact_boundary',
              compactMetadata: {
                summaryTokens: reactiveCompactResult.summaryTokenEstimate ?? 0,
                previousTokens: tokenCountWithEstimation(currentMessagesForQuery),
              },
              sessionId,
            }
            continue
          }
        }
        resultText = PROMPT_TOO_LONG_ERROR_MESSAGE
        yield { type: 'text_delta', delta: PROMPT_TOO_LONG_ERROR_MESSAGE, sessionId }
        return done('blocking_limit')
      }

      // ── Fallback model switch ─────────────────────────────────────────────
      // When the primary model cannot handle the request (e.g. thinking quota
      // exceeded), switch to fallbackModel and retry this loop iteration.
      // The tombstone flag prevents infinite recursion if the fallback model
      // also triggers a FallbackTriggeredError.
      if (
        err instanceof FallbackTriggeredError &&
        config.fallbackModel &&
        !state.fallbackTriggered
      ) {
        state = {
          ...state,
          currentModel: config.fallbackModel,
          fallbackTriggered: true,       // tombstone: don't fall back again
          maxOutputTokensOverride: undefined, // reset escalation for fresh model
        }
        continue  // retry this turn with the fallback model
      }

      streamError = err
    }

    // ── Step 12: abort after streaming ───────────────────────────────────────
    if (signal.aborted) {
      const missingResults = buildMissingToolResultMessages(assistantMessages, 'Interrupted by user')
      append(...assistantMessages, ...missingResults)
      if (signal.reason !== 'interrupt') {
        append(makeInterruptionMessage(false))
      }
      return done('aborted_streaming')
    }

    // ── Step 12b: recover from model-call (stream) errors ────────────────────
    // A streamError that is not PromptTooLongError / FallbackTriggeredError used
    // to be re-thrown here, aborting the whole turn as error_during_execution —
    // the model never got to react. Instead, surface the error into the
    // conversation (like a failed tool result) and retry the turn, so the model
    // can decide how to proceed (retry, change approach, answer with what it
    // has). Bounded by maxStreamErrorRecoveries to avoid looping on a persistent
    // error; on a transient gateway error ("please retry later") the retry
    // usually self-heals.
    if (streamError) {
      const maxRecoveries = config.maxStreamErrorRecoveries ?? 2
      // FallbackTriggeredError is a control-flow signal ("this model can't do
      // it"): if it reached here the fallback branch declined to handle it (no
      // fallbackModel, or tombstoned), so retrying the same model is pointless —
      // keep failing fast. Only genuine network/provider errors are recoverable.
      const recoverable = !(streamError instanceof FallbackTriggeredError)
      if (recoverable && maxRecoveries > 0 && state.streamErrorRecoveryCount < maxRecoveries) {
        const attempt = state.streamErrorRecoveryCount + 1
        const detail = summarizeStreamError(streamError)
        yield {
          type: 'system_message',
          subtype: 'warning',
          text:
            `模型调用失败（第 ${attempt}/${maxRecoveries} 次恢复）：${detail}　将注入错误并重试。`,
          sessionId,
        }
        // Drop any partial assistant blocks from this failed attempt and inject a
        // guidance message the model will read on the retry.
        append(makeTextUserMessage(buildStreamErrorRecoveryText(detail), { isMeta: true }))
        state = { ...state, streamErrorRecoveryCount: attempt }
        // Brief backoff before retrying — the provider layer already exhausted
        // its own HTTP retries, so give a transient gateway error a moment.
        await delay(Math.min(1000 * attempt, 3000), signal)
        if (signal.aborted) return done('aborted_streaming')
        continue
      }
      // Recovery disabled or exhausted — preserve the original fail-fast path.
      throw streamError
    }

    // A turn streamed successfully — clear the consecutive-error counter so only
    // back-to-back failures count toward the recovery budget.
    if (state.streamErrorRecoveryCount !== 0) {
      state = { ...state, streamErrorRecoveryCount: 0 }
    }

    // Commit assistant messages to history
    append(...assistantMessages)

    // ── Collect tool_use blocks ──────────────────────────────────────────────
    const toolUseRequests = assistantMessages.flatMap(msg =>
      msg.content
        .filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
          b.type === 'tool_use',
        )
        .map(b => ({
          toolUseId: b.id,
          toolName: b.name,
          input: b.input,
          assistantMessageUuid: msg.uuid,
        })),
    )

    const lastMsg = assistantMessages[assistantMessages.length - 1]
    const stopReason = lastMsg?.stopReason ?? null
    const assistantText = assistantMessages
      .flatMap(m => m.content)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('')

    // ── Step 14: no-tools path ───────────────────────────────────────────────
    if (toolUseRequests.length === 0) {
      resultText = assistantText

      // 14b: max_output_tokens recovery
      if (isMaxOutputTokensStopReason(stopReason)) {
        if (
          state.maxOutputTokensOverride === undefined &&
          !process.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS']
        ) {
          // Phase 1: escalate to 64k
          state = { ...state, maxOutputTokensOverride: ESCALATED_MAX_TOKENS }
          continue
        }

        if (state.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          // Phase 2: multi-turn recovery
          append(makeMaxOutputTokensRecoveryMessage())
          state = { ...state, maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount + 1 }
          continue
        }

        // Phase 3: exhausted → surface to user and exit
        return done('success')
      }

      // 14e: normal completion
      return done('success')
    }

    const toolRequestSignature = toolUseRequests
      .map(req => `${req.toolName}:${stableStringify(req.input)}`)
      .join('\n')
    // L5: a model stuck in a loop often narrates ("let me try again…") while
    // re-issuing the *exact* same tool call. The old guard only counted repeats
    // when assistantText was empty, so any accompanying text disabled the
    // safety net and the loop could spin until the turn/budget cap. We now count
    // an identical tool signature as no-progress regardless of narration —
    // differing tool inputs still reset the counter, so genuine progress is
    // unaffected.
    if (toolRequestSignature === lastToolRequestSignature) {
      repeatedToolRequestCount++
    } else {
      lastToolRequestSignature = toolRequestSignature
      repeatedToolRequestCount = 1
    }
    if (repeatedToolRequestCount >= NO_PROGRESS_REPEAT_LIMIT) {
      resultText =
        `Stopped: the model repeated the same tool request ${repeatedToolRequestCount} times without making progress.`
      yield { type: 'text_delta', delta: resultText, sessionId }
      return done('no_progress')
    }

    // Emit tool_use events
    for (const req of toolUseRequests) {
      yield { type: 'tool_use', id: req.toolUseId, name: req.toolName, input: req.input, sessionId }
    }

    // ── Step 15: runTools ────────────────────────────────────────────────────
    const toolCtx: KernelToolContext = {
      sessionId,
      abortSignal: signal,
      readFileState: fileCache,
      messages: state.messages,
      workspaceRoot: ctx.cwd,
      planMode: config.planModeRef?.active ?? false,
      askUser: config.askUser,
    }

    const toolsResult = await runTools(toolUseRequests, config.tools, toolCtx, canUseTool)
    const toolNameByUseId = new Map(toolUseRequests.map(req => [req.toolUseId, req.toolName]))

    // Emit tool_result events
    for (const resultMsg of toolsResult.toolResultMessages) {
      for (const block of resultMsg.content) {
        if (block.type === 'tool_result') {
          const content =
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content)
          yield {
            type: 'tool_result',
            id: block.tool_use_id,
            toolName: toolNameByUseId.get(block.tool_use_id) ?? '',
            content,
            isError: block.is_error ?? false,
            sessionId,
          }
        }
      }
    }

    allPermissionDenials.push(...toolsResult.permissionDenials)
    for (const denial of toolsResult.permissionDenials) {
      config.onPermissionDenial?.(denial)
    }
    append(...toolsResult.toolResultMessages, ...toolsResult.extraMessages)

    // ── Step 16: abort after tools ───────────────────────────────────────────
    if (signal.aborted) {
      if (signal.reason !== 'interrupt') {
        append(makeInterruptionMessage(true))
      }
      return done('aborted_tools')
    }

    // ── Step 18: max turns check ─────────────────────────────────────────────
    state = { ...state, turnCount: state.turnCount + 1 }
    if (state.turnCount >= maxTurns) {
      return done('max_turns')
    }

    // ── Budget check ─────────────────────────────────────────────────────────
    if (config.maxBudgetUsd !== undefined && totalCost >= config.maxBudgetUsd) {
      return done('max_budget_usd')
    }

    // ── Step 19: continue ────────────────────────────────────────────────────
  }
}
