/**
 * KernelLoop — the while(true) agentic loop.
 *
 * Direct equivalent of CC's query.ts queryLoop().
 * Step numbers match cc-kernel-rewrite-detailed-plan.md §2.2.
 */
import type { KernelConfig } from '../types/KernelConfig.js'
import type { KernelEvent, PermissionDenial } from '../types/KernelEvent.js'
import type { KernelMessage, ContentBlock } from '../types/KernelMessage.js'
import {
  AUTO_STALL_FAILURE_LIMIT, AUTO_STALL_SOFT_LIMIT, AUTO_NO_FS_PROGRESS_LIMIT,
  SELF_EVAL_PROMPT, allToolResultsErrored, turnMutatedFs, FS_MUTATING_TOOLS,
} from './AutoStallGuard.js'
import { MAX_VERIFY_ROUNDS, buildVerifyRejectionPrompt } from './VerifyGate.js'
import type { VerifyVerdict } from './VerifyGate.js'
import { DRIFT_TURN_INTERVAL, buildDriftCorrectionPrompt } from './DriftGate.js'
import type { DriftVerdict } from './DriftGate.js'
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
import { stripVolatileContextPrefix } from '../utils/VolatileContext.js'
import { RuntimeEnv } from '../../infra/env/RuntimeEnv.js'
import type { FileStateCache } from '../session/FileStateCache.js'
import type {
  CheckpointBoundaryEvent,
  CheckpointBoundaryResult,
} from './CheckpointBoundary.js'

// ── Return type ───────────────────────────────────────────────────────────────

export type LoopTerminationReason =
  | 'success'
  | 'max_turns'
  | 'no_progress'
  | 'blocking_limit'
  | 'aborted_streaming'
  | 'aborted_tools'
  | 'max_budget_usd'
  | 'verify_exhausted'
  | 'auto_verify_unavailable'
  | 'auto_drift_unavailable'
  | 'auto_runtime_limit'
  | 'auto_tool_batch_limit'
  | 'phase_hook_abort'
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
  /** Session-lifetime number of completed tool batches. */
  toolBatchCount: number
  /** Latest durable checkpoint revision observed by the loop. */
  checkpointRevision: number
  lastDriftToolBatchCount: number
  lastDriftCheckpointRevision: number
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
  initialToolBatchCount?: number
  initialCheckpointRevision?: number
  initialLastDriftToolBatchCount?: number
  initialLastDriftCheckpointRevision?: number
  /**
   * Drain any pending mid-turn user corrections ("steering"). Called at the top
   * of every loop iteration. Returns the queued correction strings (and clears
   * the queue). Each is appended as a user message BEFORE the next API request,
   * so the model incorporates the correction at the next natural boundary —
   * without aborting the in-flight stream. Undefined / empty when no steering is
   * wired or queued.
   */
  drainSteering?: () => string[]
  /**
   * The session's current top-level goal, captured or re-anchored by
   * KernelSession before compaction. Forwarded into the compact pipeline so the
   * deterministic goal anchor survives nested compactions.
   */
  originalUserGoal?: string
}

function isRealUserMessage(message: KernelMessage): boolean {
  return message.role === 'user' &&
    !message.isMeta &&
    !message.isCompactSummary &&
    !message.isCompactBoundary &&
    !message.sourceToolAssistantUUID
}

/**
 * Pick the user message preserved verbatim across a compaction.
 * Prefers the last NON-steering real user message: a mid-turn Ctrl+G
 * correction must not displace the actual task as the post-compact anchor
 * (the correction's content still survives inside the summary).
 * Falls back to the last real user message when only steering exists.
 */
function cloneLastRealUserTextMessage(messages: readonly KernelMessage[]): KernelMessage[] {
  const reversed = [...messages].reverse()
  const message =
    reversed.find(m => isRealUserMessage(m) && !m.isSteering) ??
    reversed.find(isRealUserMessage)
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
    // Mark as a keep-set clone so (a) goal capture never mistakes it for the
    // session's original request after a resume, and (b) continuity anchors
    // can exclude its source from the recent-detail sections (F-2/F-3).
    isKeepSetClone: true,
    sourceUuid: message.uuid,
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
 * Clone a steering message down to its text blocks (volatile prefix stripped).
 * The isSteering flag is preserved so a later compaction classifies the clone
 * correctly again. Returns null when no usable text remains.
 */
function cloneSteeringTextMessage(message: KernelMessage): KernelMessage | null {
  const textBlocks = message.content
    .filter((block): block is ContentBlock & { type: 'text'; text: string } =>
      block.type === 'text' && typeof (block as { text?: unknown }).text === 'string',
    )
    .map(block => ({ ...block, text: stripVolatileContextPrefix(block.text) }))
    .filter(block => block.text.trim().length > 0)
  if (textBlocks.length === 0) return null
  return {
    uuid: crypto.randomUUID(),
    role: 'user',
    content: textBlocks,
    isSteering: true,
    isKeepSetClone: true,
    sourceUuid: message.uuid,
  }
}

/**
 * Build the messages to preserve verbatim after a compaction:
 *   [ <last NON-steering real user message, text-only, stripped> ,
 *     ...<steering corrections not covered by kept units> ,
 *     ...<bounded current-turn tail> ]
 *
 * The tail is anchored at the last NON-steering real user message — a mid-turn
 * steering correction must not silently shrink the preserved tail to only the
 * post-steering work. Steering messages inside the tail ride along verbatim in
 * their chronological unit; steering that falls outside the kept units (budget
 * overflow or leading position) is cloned text-only right after the user
 * anchor, so a correction issued shortly before compaction can never be lost
 * to a terse summary.
 *
 * Units are complete assistant⇄tool_result groups accumulated newest-first
 * until the token budget is hit (always keeping at least the most recent
 * complete unit). applyToolResultBudget is applied first so a single oversized
 * result is still clipped to the per-tool limit — identical to normal-flow
 * behaviour.
 */
export function buildMessagesToKeepAfterCompact(
  messages: readonly KernelMessage[],
  tools: KernelConfig['tools'],
  budgetTokens: number = CURRENT_TURN_TAIL_TOKEN_BUDGET,
): KernelMessage[] {
  // Constraint: per-tool clipping, consistent with the live loop.
  const budgeted = applyToolResultBudget(messages, tools)

  const userText = cloneLastRealUserTextMessage(budgeted)

  // Anchor at the last NON-steering real user message; fall back to the last
  // real user message (which may be a steering one) when none exists.
  let lastUserIdx = -1
  let lastNonSteeringUserIdx = -1
  for (let i = budgeted.length - 1; i >= 0; i--) {
    const message = budgeted[i]!
    if (!isRealUserMessage(message)) continue
    if (lastUserIdx < 0) lastUserIdx = i
    if (!message.isSteering) { lastNonSteeringUserIdx = i; break }
  }
  const anchorIdx = lastNonSteeringUserIdx >= 0 ? lastNonSteeringUserIdx : lastUserIdx
  if (anchorIdx < 0) return userText

  const tail = budgeted.slice(anchorIdx + 1)
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

  // Strip stale `usage` from preserved assistant messages. usage.inputTokens
  // describes the FULL pre-compact context (possibly ~180k); if it survives,
  // tokenCountWithEstimation reads it after the compaction and concludes the
  // context is still huge — re-triggering compaction (summarising the summary)
  // and false-positive blocking_limit terminations. Post-compact estimation
  // falls back to roughTokenCount until the next API response restores an
  // accurate figure — the same situation as session start.
  // NOTE: must clone, never mutate — this function also runs on iterations
  // where no compaction happens, and the inputs alias the live history.
  const keptFlat = kept.flat().map(msg => {
    if (msg.role !== 'assistant' || !msg.usage) return msg
    const { usage: _staleUsage, ...rest } = msg
    return rest as KernelMessage
  })

  // Guarantee steering survival: any steering correction in the tail that did
  // NOT make it into a kept unit (dropped by budget, or in leading position
  // before the first assistant reply) is cloned text-only right after the user
  // anchor. Steering inside kept units already survives verbatim in place.
  const keptUuids = new Set(keptFlat.map(message => message.uuid))
  const orphanSteering = tail
    .filter(message =>
      isRealUserMessage(message) && message.isSteering && !keptUuids.has(message.uuid))
    .map(cloneSteeringTextMessage)
    .filter((message): message is KernelMessage => message !== null)

  return [...userText, ...orphanSteering, ...keptFlat]
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

/** Guidance message injected when a provider returns an empty successful turn. */
function buildEmptyResponseRecoveryText(): string {
  return (
    `[系统] 上一步模型调用返回了空响应：没有可见文本，也没有工具调用。\n` +
    `这通常是网络/网关瞬时波动或 provider 返回了异常的空 end_turn。` +
    `请直接重试回答当前用户问题；如果已经掌握足够信息，请给出明确、可见的回复。`
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
const CHECKPOINT_STATE_TOOLS = new Set([
  'todo_write',
  'progress_note',
  'artifacts_register',
])

/**
 * Window length for the A↔B oscillation guard: 6 entries = 3 full ABAB cycles.
 * The consecutive-repeat counter misses a model that alternates between two
 * identical tool batches ("try A… try B… try A…"); requiring three strict
 * period-2 cycles keeps legitimate re-reads (read → edit → re-read) safe.
 */
const ALTERNATION_WINDOW = 6
const AUTO_GATE_MAX_ATTEMPTS_DEFAULT = 2
const AUTO_DRIFT_FAILURE_LIMIT_DEFAULT = 3

/**
 * True when the last ALTERNATION_WINDOW turn signatures form a strict ABAB…
 * period-2 oscillation of two DIFFERENT signatures. Identical consecutive
 * signatures are the consecutive-repeat counter's job, not this guard's.
 */
export function isAlternatingToolSignatures(history: readonly string[]): boolean {
  if (history.length < ALTERNATION_WINDOW) return false
  const recent = history.slice(-ALTERNATION_WINDOW)
  const even = recent[0]!
  const odd = recent[1]!
  if (even === odd) return false
  return recent.every((sig, i) => sig === (i % 2 === 0 ? even : odd))
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? String(value) : encoded
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function errorNote(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(value ?? fallback))
}

// ── Main loop ────────────────────────────────────────────────────────────────

export async function* runKernelLoop(
  ctx: KernelLoopContext,
): AsyncGenerator<KernelEvent, LoopResult> {
  const { config, mutableMessages, abortController, fileCache, sessionId } = ctx
  const signal = abortController.signal
  const canUseTool = config.canUseTool ?? defaultCanUseTool
  const maxTurns = config.maxTurns ?? 100
  const autoRunStartedAt = Date.now()
  const autoInitialToolBatchCount = ctx.initialToolBatchCount ?? 0
  const autoMaxRuntimeMs = config.autoMaxRuntimeMs ?? 2 * 60 * 60 * 1000
  // Auto run bounds: the 2h wall-clock above AND a 300 completed-tool-batch cap.
  // Whichever is hit first ends the run (with a checkpoint, so it can resume).
  const autoMaxToolBatches = config.autoMaxToolBatches ?? 300
  const autoRuntimeTimer = config.autonomousMode && autoMaxRuntimeMs > 0
    ? setTimeout(() => abortController.abort('auto_runtime_limit'), autoMaxRuntimeMs)
    : undefined
  autoRuntimeTimer?.unref?.()

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
  // Auto-mode stall circuit.
  let consecutiveAllErrorTurns = 0   // every tool result errored, N turns running
  let turnsSinceFsProgress = 0       // ran tools but mutated no file, N turns running
  let autoSelfEvalInjected = false   // one-shot self-eval nudge per stall episode
  let verifyRounds = 0               // auto-mode completion-gate rounds consumed
  let consecutiveDriftGateFailures = 0
  let toolBatchCount = ctx.initialToolBatchCount ?? 0
  let checkpointRevision = ctx.initialCheckpointRevision ?? 0
  let lastDriftToolBatchCount = ctx.initialLastDriftToolBatchCount ?? 0
  let lastDriftCheckpointRevision = ctx.initialLastDriftCheckpointRevision ?? 0
  const toolSignatureHistory: string[] = []
  const autoGateFailurePolicy = config.autoGateFailurePolicy ?? 'checkpoint_pause'
  const autoGateMaxAttempts = boundedPositive(
    config.autoGateMaxAttempts,
    AUTO_GATE_MAX_ATTEMPTS_DEFAULT,
  )
  const autoDriftFailureLimit = boundedPositive(
    config.autoDriftFailureLimit,
    AUTO_DRIFT_FAILURE_LIMIT_DEFAULT,
  )

  async function checkpoint(
    event: Omit<CheckpointBoundaryEvent, 'sessionId' | 'toolBatchCount' | 'estimatedCostUsd'>,
  ): Promise<CheckpointBoundaryResult> {
    if (!config.autonomousMode || !config.onCheckpointBoundary) {
      return { updated: false, revision: checkpointRevision }
    }
    try {
      const result = await config.onCheckpointBoundary({
        ...event,
        sessionId,
        toolBatchCount,
        estimatedCostUsd: totalCost,
      })
      checkpointRevision = Math.max(checkpointRevision, result.revision)
      return result
    } catch {
      return { updated: false, revision: checkpointRevision }
    }
  }

  // Phase-hook dispatch (auto-orch, B). No-op unless config.phaseHooks is set,
  // so every existing mode makes ZERO extra calls (zero regression). The hook is
  // advisory: it may inject meta user messages (applied at the next natural
  // boundary, same as drift corrections) and/or request a clean abort. Fail-open:
  // a throwing/hanging hook is swallowed and treated as an empty outcome.
  // Returns true when the loop should terminate after this transition.
  async function runPhaseHook(
    point: import('./PhaseHooks.js').PhaseHookPoint,
    extra?: { toolNames?: readonly string[]; erroredToolNames?: readonly string[] },
  ): Promise<boolean> {
    if (!config.phaseHooks) return false
    try {
      const outcome = await config.phaseHooks({
        point,
        workspaceRoot: config.cwd ?? process.cwd(),
        state: {
          turnCount: toolBatchCount,
          estimatedCostUsd: totalCost,
          toolNames: extra?.toolNames,
          erroredToolNames: extra?.erroredToolNames,
        },
        signal,
      })
      if (outcome.inject?.length) {
        for (const text of outcome.inject) {
          append(makeTextUserMessage(text, { isMeta: true }))
        }
      }
      return outcome.abort === true
    } catch {
      return false
    }
  }

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
    // L3: state.messages already aliases mutableMessages in the common case
    // (only the compact path re-points it, then back again). Skip the per-append
    // object spread unless the reference actually diverged.
    if (state.messages !== mutableMessages) {
      state = { ...state, messages: mutableMessages }
    }
  }

  function done(reason: LoopTerminationReason): LoopResult {
    if (autoRuntimeTimer) clearTimeout(autoRuntimeTimer)
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
      toolBatchCount,
      checkpointRevision,
      lastDriftToolBatchCount,
      lastDriftCheckpointRevision,
    }
  }

  // Wrap the whole loop so the auto-runtime watchdog timer is cleared on EVERY
  // exit path. done() already clears it on normal returns, but a throw (e.g.
  // exhausted stream-error recovery at the `throw streamError` below, or any
  // other unexpected throw) bypasses done(). The timer is unref'd so it never
  // blocks process exit, but in a long-lived host that catches the throw and
  // continues, the abandoned timer would otherwise linger until it fires (up to
  // autoMaxRuntimeMs ≈ 2h). clearTimeout is idempotent, so the redundant clear
  // in done() is harmless.
  try {
  while (true) {
    if (
      config.autonomousMode &&
      autoMaxRuntimeMs > 0 &&
      Date.now() - autoRunStartedAt >= autoMaxRuntimeMs
    ) {
      resultText =
        `Auto run reached its ${autoMaxRuntimeMs}ms wall-clock limit. ` +
        'Progress was checkpointed; resume the session to continue.'
      yield { type: 'text_delta', delta: `\n[auto] ${resultText}\n`, sessionId }
      return done('auto_runtime_limit')
    }
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
      append(makeTextUserMessage(formatSteeringMessage(trimmed), { isMeta: false, isSteering: true }))
    }

    // ── Step 1: applyToolResultBudget ────────────────────────────────────────
    const budgetedMessages = applyToolResultBudget(state.messages, config.tools)

    // ── Step 5: autoCompactIfNeeded ──────────────────────────────────────────
    const messagesForQuery = [...getMessagesAfterCompactBoundary(budgetedMessages)]
    // L1: route through assembleSystemPrompt so "" / undefined are treated
    // identically and there's one canonical place to change the join rule.
    const effectiveSystemPrompt =
      assembleSystemPrompt(config.systemPrompt, config.appendSystemPrompt) ?? ''

    // Probe the same gates autoCompactIfNeeded uses so (a) the "compacting…"
    // indicator only fires when a compaction will actually run, and (b) the
    // keep-set below is only computed when it will actually be consumed.
    const willCompact =
      config.compact?.enabled !== false &&
      shouldAutoCompact(
        messagesForQuery,
        state.currentModel,
        config.compact?.querySource ?? config.querySource,
        state.autoCompactTracking,
        state.maxOutputTokensOverride ?? config.maxOutputTokens,
        config.compact?.model,
      )

    // P2-2: buildMessagesToKeepAfterCompact (incl. a second tool-result-budget
    // pass) used to run on EVERY iteration; it is only meaningful when a
    // compaction actually runs this turn. shouldAutoCompact and
    // autoCompactIfNeeded share the same gates (kept in lockstep — see
    // shouldAutoCompact docstring); if they ever drift, the worst case is a
    // compaction with an empty keep-set (summary-only), never a protocol error.
    const messagesToKeepAfterCompact = willCompact
      ? buildMessagesToKeepAfterCompact(messagesForQuery, config.tools)
      : []

    // Surface a "compacting…" indicator before the slow LLM-backed summarization
    // begins.
    if (willCompact) {
      await checkpoint({ type: 'compact_before' })
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
            originalUserGoal: ctx.originalUserGoal,
            messagesToKeep: messagesToKeepAfterCompact,
            promptProfile: config.compact?.promptProfile,
            autonomyFallback: config.compact?.autonomyFallback,
            abortSignal: signal,
            maxRetries: config.maxRetries,
          },
        )

    state = { ...state, autoCompactTracking: compactResult.tracking }
    if (willCompact) {
      await checkpoint({ type: 'compact_after' })
    }
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

    // ── Phase hook: pre_query (auto-orch B) ───────────────────────────────────
    // Fires right before the model is queried, after any injected messages are
    // already appended so the hook's own inject lands on THIS turn.
    if (await runPhaseHook('pre_query')) {
      resultText = resultText || 'Stopped (auto-orch): a phase hook requested abort before query.'
      return done('phase_hook_abort')
    }

    // ── Steps 7+8: stream API + accumulate messages ───────────────────────────
    const systemPrompt = effectiveSystemPrompt
    const messagesForApi = state.fallbackTriggered
      ? stripThinkingBlocksFromMessages(currentMessagesForQuery)
      : currentMessagesForQuery

    const assistantMessages: KernelMessage[] = []
    const acc = newAccumulator()
    let streamError: unknown = null
    // Declared OUTSIDE the try so retry notifications collected before a
    // terminal stream failure can still be drained (previously they were only
    // yielded when a subsequent stream event arrived — a request that retried
    // N times and then failed surfaced zero api_retry events).
    const retryEvents: KernelEvent[] = []

    // Route to OpenAI-format (DeepSeek) or Anthropic-format wire protocol via
    // the provider registry — baseURL wins, model name is the fallback signal.
    const isDeepSeek = getModelProtocol(state.currentModel, config.baseURL) === 'openai'

    try {
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
      // Surface any retry notifications collected before the terminal failure.
      for (const retryEvent of retryEvents.splice(0)) {
        yield retryEvent
      }
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
              originalUserGoal: ctx.originalUserGoal,
              messagesToKeep: buildMessagesToKeepAfterCompact(currentMessagesForQuery, config.tools),
              promptProfile: config.compact?.promptProfile,
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
            // L6-fix: keep state.messages pointing at the LIVE mutableMessages
            // array (same invariant as append() / the proactive compact path).
            // A copy here silently broke the shared-reference invariant.
            state = { ...state, messages: mutableMessages }
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
      if (signal.reason === 'auto_runtime_limit') {
        resultText =
          `Auto run reached its ${autoMaxRuntimeMs}ms wall-clock limit. ` +
          'Progress was checkpointed; resume the session to continue.'
        return done('auto_runtime_limit')
      }
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
        if (signal.aborted) {
          return done(signal.reason === 'auto_runtime_limit'
            ? 'auto_runtime_limit'
            : 'aborted_streaming')
        }
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

    // ── Phase hook: post_query (auto-orch B) ──────────────────────────────────
    // Fires after the assistant turn is committed, before tool execution. Lets a
    // policy react to what the model just said / decided.
    if (await runPhaseHook('post_query')) {
      resultText = resultText || 'Stopped (auto-orch): a phase hook requested abort after query.'
      return done('phase_hook_abort')
    }

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
          !RuntimeEnv.maxOutputTokensPinned()
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

      // 14c: empty successful response recovery. A provider can occasionally
      // return a syntactically valid end_turn with no visible text and no tool
      // calls after a transient network/gateway disruption. Treating that as a
      // normal success makes the CLI appear to "do nothing": only the footer is
      // printed. Retry a bounded number of times, then stop with a visible error.
      if (assistantText.trim() === '') {
        const maxRecoveries = config.maxStreamErrorRecoveries ?? 2
        if (maxRecoveries > 0 && state.emptyResponseRecoveryCount < maxRecoveries) {
          const attempt = state.emptyResponseRecoveryCount + 1
          yield {
            type: 'system_message',
            subtype: 'warning',
            text:
              `模型返回空响应（第 ${attempt}/${maxRecoveries} 次恢复）：` +
              `没有可见文本，也没有工具调用。将注入提示并重试。`,
            sessionId,
          }
          if (assistantMessages.length > 0) {
            mutableMessages.splice(
              Math.max(0, mutableMessages.length - assistantMessages.length),
              assistantMessages.length,
            )
            state = { ...state, messages: mutableMessages }
          }
          append(makeTextUserMessage(buildEmptyResponseRecoveryText(), { isMeta: true }))
          state = { ...state, emptyResponseRecoveryCount: attempt }
          await delay(Math.min(1000 * attempt, 3000), signal)
          if (signal.aborted) {
            return done(signal.reason === 'auto_runtime_limit'
              ? 'auto_runtime_limit'
              : 'aborted_streaming')
          }
          continue
        }

        resultText =
          `Stopped: the model returned an empty response without text or tool calls ` +
          `after ${maxRecoveries} recovery attempt${maxRecoveries === 1 ? '' : 's'}.`
        yield { type: 'text_delta', delta: resultText, sessionId }
        return done('error')
      }

      if (state.emptyResponseRecoveryCount !== 0) {
        state = { ...state, emptyResponseRecoveryCount: 0 }
      }

      // ── Step 14d: auto-mode completion gate (Verify) ───────────────────────
      // The model thinks it's done (no tool calls). In an unattended run we do
      // NOT trust that judgment blindly — an INDEPENDENT judge (isolated
      // context) checks whether the current top-level goal is actually met. A
      // negative verdict re-injects concrete unfinished items and the loop
      // continues; bounded by MAX_VERIFY_ROUNDS so verify→fix can't spin
      // forever. If the gate is unavailable, auto mode does not report success
      // unless the caller explicitly opts into the legacy fail-open policy.
      if (config.autonomousMode && config.verifyGate && verifyRounds < MAX_VERIFY_ROUNDS) {
        verifyRounds++
        let verdict: VerifyVerdict | undefined
        let unavailableNote: string | null = null
        for (let attempt = 1; attempt <= autoGateMaxAttempts; attempt++) {
          try {
            const candidate = await config.verifyGate({
              workspaceRoot: ctx.cwd,
              turnCount: state.turnCount,
              round: verifyRounds,
              signal,
            })
            if (candidate.skipped) {
              unavailableNote = candidate.note ?? 'verify gate returned skipped'
              continue
            }
            verdict = candidate
            unavailableNote = null
            break
          } catch (err) {
            unavailableNote = errorNote(err)
          }
          if (signal.aborted) break
        }
        if (signal.aborted) {
          return done(signal.reason === 'auto_runtime_limit'
            ? 'auto_runtime_limit'
            : 'aborted_tools')
        }
        if (!verdict && unavailableNote !== null) {
          const msg =
            `[verify] 完成度审核不可用，已尝试 ${autoGateMaxAttempts} 次：${unavailableNote}`
          yield {
            type: 'system_message',
            subtype: 'warning',
            text: msg,
            sessionId,
          }
          if (autoGateFailurePolicy === 'fail_open') {
            // Legacy compatibility only: visible warning, then normal success.
          } else {
            resultText =
              `Stopped (auto mode): completion could not be independently verified. ` +
              `Reason: ${unavailableNote}`
            yield { type: 'text_delta', delta: `\n[auto] ${resultText}\n`, sessionId }
            return done('auto_verify_unavailable')
          }
        }
        if (verdict && !verdict.done) {
          append(makeTextUserMessage(buildVerifyRejectionPrompt(verdict, verifyRounds), { isMeta: true }))
          await checkpoint({ type: 'verify_rejected' })
          yield {
            type: 'text_delta',
            delta: `\n[verify] 第 ${verifyRounds}/${MAX_VERIFY_ROUNDS} 轮：未通过，剩余 ${verdict.unfinished.length} 项，继续推进…\n`,
            sessionId,
          }
          continue
        }
      } else if (
        config.autonomousMode && config.verifyGate && verifyRounds >= MAX_VERIFY_ROUNDS
      ) {
        // Exhausted the verify budget while still not passing — stop honestly
        // rather than loop, leaving the last rejection visible in the summary.
        resultText = 'Stopped (auto mode): completion verification did not pass within the verify round limit.'
        return done('verify_exhausted')
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
    // A↔B oscillation guard: the consecutive counter above resets on every
    // signature change, so a model ping-ponging between two identical tool
    // batches never trips it. Three strict period-2 cycles (ABABAB) = stuck.
    toolSignatureHistory.push(toolRequestSignature)
    if (toolSignatureHistory.length > ALTERNATION_WINDOW) toolSignatureHistory.shift()
    if (isAlternatingToolSignatures(toolSignatureHistory)) {
      resultText =
        'Stopped: the model alternated between the same two tool requests repeatedly without making progress.'
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
      autonomousMode: config.autonomousMode === true,
      askUser: config.askUser,
    }

    const toolByName = new Map(config.tools.map(tool => [tool.name, tool]))
    const externalBefore = [...new Set(
      toolUseRequests
        .filter(req => {
          const boundary = toolByName.get(req.toolName)?.permission?.checkpointBoundary
          return boundary === 'before' || boundary === 'both'
        })
        .map(req => req.toolName),
    )]
    if (externalBefore.length > 0) {
      await checkpoint({ type: 'external_before', externalToolNames: externalBefore })
    }

    // ── Phase hook: pre_tool (auto-orch B) ────────────────────────────────────
    const batchToolNames = toolUseRequests.map(req => req.toolName)
    if (await runPhaseHook('pre_tool', { toolNames: batchToolNames })) {
      resultText = resultText || 'Stopped (auto-orch): a phase hook requested abort before tool execution.'
      return done('phase_hook_abort')
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

    // ── Phase hook: post_tool (auto-orch B) ───────────────────────────────────
    // Fires after the tool batch's results are committed. Surfaces which tools
    // ran and which errored so a policy can react (e.g. inject a recovery hint).
    const erroredToolNameSet = new Set<string>()
    for (const resultMsg of toolsResult.toolResultMessages) {
      for (const block of resultMsg.content) {
        if (block.type !== 'tool_result' || block.is_error !== true) continue
        const name = toolNameByUseId.get(block.tool_use_id)
        if (name) erroredToolNameSet.add(name)
      }
    }
    if (await runPhaseHook('post_tool', { toolNames: batchToolNames, erroredToolNames: [...erroredToolNameSet] })) {
      resultText = resultText || 'Stopped (auto-orch): a phase hook requested abort after tool execution.'
      return done('phase_hook_abort')
    }

    // A kernel "turn" for checkpoint/drift purposes is one completed tool
    // batch, regardless of how many tools the model issued in that batch.
    state = { ...state, turnCount: state.turnCount + 1 }
    toolBatchCount++

    if (
      config.autonomousMode &&
      autoMaxToolBatches > 0 &&
      toolBatchCount - autoInitialToolBatchCount >= autoMaxToolBatches
    ) {
      resultText =
        `Auto run reached its ${autoMaxToolBatches} tool-batch limit. ` +
        'Progress was checkpointed; resume the session to continue.'
      yield { type: 'text_delta', delta: `\n[auto] ${resultText}\n`, sessionId }
      return done('auto_tool_batch_limit')
    }

    const successfulToolNames = new Set<string>()
    const inputByUseId = new Map(toolUseRequests.map(req => [req.toolUseId, req.input]))
    const mutatedPaths: string[] = []
    for (const resultMsg of toolsResult.toolResultMessages) {
      for (const block of resultMsg.content) {
        if (block.type !== 'tool_result' || block.is_error === true) continue
        const name = toolNameByUseId.get(block.tool_use_id)
        if (!name) continue
        successfulToolNames.add(name)
        // Collect the path a successful FS-mutating tool wrote, so the host can
        // accumulate an edit digest across long code-editing stretches.
        if (FS_MUTATING_TOOLS.has(name)) {
          const input = inputByUseId.get(block.tool_use_id) as Record<string, unknown> | undefined
          const path = input?.['file_path'] ?? input?.['notebook_path']
          if (typeof path === 'string' && path) mutatedPaths.push(path)
        }
      }
    }

    const externalAfter = [...new Set(
      toolUseRequests
        .filter(req => {
          const boundary = toolByName.get(req.toolName)?.permission?.checkpointBoundary
          return boundary === 'after' || boundary === 'both'
        })
        .map(req => req.toolName),
    )]
    if (externalAfter.length > 0) {
      await checkpoint({ type: 'external_after', externalToolNames: externalAfter })
    }

    // Durable-progress checkpoint. A batch represents durable progress worth a
    // checkpoint when it either updated explicit state (todo/progress/artifacts)
    // OR successfully mutated a workspace file. The FS arm matters because the
    // auto drift gate below requires the checkpoint revision to advance; without
    // it, a long code-editing stretch that never touches todo/progress would
    // never advance the revision, so mid-task drift/course-correction would never
    // run. Drift cadence stays bounded by DRIFT_TURN_INTERVAL, and the
    // checkpoint-advanced gate still suppresses drift during pure read/plan phases.
    const durableProgressTools = [...successfulToolNames].filter(name =>
      CHECKPOINT_STATE_TOOLS.has(name) || FS_MUTATING_TOOLS.has(name),
    )
    if (durableProgressTools.length > 0) {
      await checkpoint({
        type: 'tool_batch_completed',
        successfulToolNames: durableProgressTools,
        mutatedPaths: mutatedPaths.length > 0 ? [...new Set(mutatedPaths)] : undefined,
      })
    }

    // ── Auto-mode stall circuit ──────────────────────────────────────────────
    // Unattended runs need protection the existing identical-signature /
    // alternation guards don't give:
    //   • all-error stall  — every tool result errors for several turns (even
    //                        with DIFFERENT inputs). HARD-stops at the limit.
    //   • no-FS-progress   — ran tools but changed no file for many turns.
    //                        Only NUDGES (never hard-stops a legit read/plan phase).
    // Before the hard stop, a one-shot self-eval message is injected so the model
    // gets a chance to reconsider ("先注入自评估 turn，再不行则终止").
    if (config.autonomousMode) {
      const hadToolCalls = toolUseRequests.length > 0
      const allErrored = allToolResultsErrored(toolsResult.toolResultMessages)
      const mutatedFs  = turnMutatedFs(toolsResult.toolResultMessages, toolNameByUseId)

      consecutiveAllErrorTurns = allErrored ? consecutiveAllErrorTurns + 1 : 0
      if (mutatedFs) turnsSinceFsProgress = 0
      else if (hadToolCalls) turnsSinceFsProgress++

      // Real progress on either axis clears the one-shot nudge for the next episode.
      if (consecutiveAllErrorTurns === 0 && turnsSinceFsProgress === 0) autoSelfEvalInjected = false

      // Soft: first crossing of either threshold → inject one self-eval, continue.
      const softTrip =
        consecutiveAllErrorTurns === AUTO_STALL_SOFT_LIMIT ||
        turnsSinceFsProgress === AUTO_NO_FS_PROGRESS_LIMIT
      if (softTrip && !autoSelfEvalInjected) {
        autoSelfEvalInjected = true
        append(makeTextUserMessage(SELF_EVAL_PROMPT, { isMeta: true }))
        yield { type: 'text_delta', delta: '\n[auto] 连续无进展，注入一次自评估…\n', sessionId }
      }

      // Hard: persistent all-error → stop instead of burning the whole budget.
      if (consecutiveAllErrorTurns >= AUTO_STALL_FAILURE_LIMIT) {
        resultText =
          `Stopped (auto mode): every tool call failed for ${consecutiveAllErrorTurns} turns in a row — the agent appears stuck.`
        yield { type: 'text_delta', delta: resultText, sessionId }
        return done('no_progress')
      }
    }

    // ── Auto-mode drift / reflection gate (Checkpoint + Learn) ────────────────
    // Drift is deliberately gated by BOTH durable progress and elapsed work:
    //   1. checkpoint revision advanced since the previous drift check;
    //   2. at least DRIFT_TURN_INTERVAL tool batches completed since then.
    // Compaction alone never triggers drift.
    if (config.autonomousMode && config.driftGate) {
      const checkpointAdvanced = checkpointRevision > lastDriftCheckpointRevision
      const enoughBatches =
        toolBatchCount - lastDriftToolBatchCount >= DRIFT_TURN_INTERVAL
      if (checkpointAdvanced && enoughBatches) {
        lastDriftToolBatchCount = toolBatchCount
        lastDriftCheckpointRevision = checkpointRevision
        let drift: DriftVerdict | undefined
        let unavailableNote: string | null = null
        for (let attempt = 1; attempt <= autoGateMaxAttempts; attempt++) {
          try {
            const candidate = await config.driftGate({
              workspaceRoot: ctx.cwd,
              turnCount: toolBatchCount,
              reason: 'turn_interval',
              signal,
            })
            if (candidate.skipped) {
              unavailableNote = candidate.note ?? 'drift gate returned skipped'
              continue
            }
            drift = candidate
            unavailableNote = null
            break
          } catch (err) {
            unavailableNote = errorNote(err)
          }
          if (signal.aborted) break
        }
        if (!signal.aborted && !drift && unavailableNote !== null) {
          consecutiveDriftGateFailures++
          const msg =
            `[drift] 航向检查不可用，已尝试 ${autoGateMaxAttempts} 次` +
            `（连续 ${consecutiveDriftGateFailures}/${autoDriftFailureLimit}）：${unavailableNote}`
          yield {
            type: 'system_message',
            subtype: 'warning',
            text: msg,
            sessionId,
          }
          const shouldStop =
            autoGateFailurePolicy === 'fail_closed' ||
            (
              autoGateFailurePolicy === 'checkpoint_pause' &&
              consecutiveDriftGateFailures >= autoDriftFailureLimit
            )
          if (shouldStop) {
            resultText =
              `Stopped (auto mode): drift checks were unavailable for ` +
              `${consecutiveDriftGateFailures} consecutive scheduled check(s). ` +
              `Reason: ${unavailableNote}`
            yield { type: 'text_delta', delta: `\n[auto] ${resultText}\n`, sessionId }
            return done('auto_drift_unavailable')
          }
        } else if (!signal.aborted && drift) {
          consecutiveDriftGateFailures = 0
        }
        if (!signal.aborted && drift?.drifted) {
          append(makeTextUserMessage(buildDriftCorrectionPrompt(drift), { isMeta: true }))
          await checkpoint({ type: 'drift_corrected' })
          yield { type: 'text_delta', delta: '\n[drift] 检测到航向偏离，注入一次校正…\n', sessionId }
        }
      }
    }

    // ── Step 16: abort after tools ───────────────────────────────────────────
    if (signal.aborted) {
      if (signal.reason === 'auto_runtime_limit') {
        resultText =
          `Auto run reached its ${autoMaxRuntimeMs}ms wall-clock limit. ` +
          'Progress was checkpointed; resume the session to continue.'
        return done('auto_runtime_limit')
      }
      if (signal.reason !== 'interrupt') {
        append(makeInterruptionMessage(true))
      }
      return done('aborted_tools')
    }

    // ── Step 18: max turns check ─────────────────────────────────────────────
    if (state.turnCount >= maxTurns) {
      return done('max_turns')
    }

    // ── Budget check ─────────────────────────────────────────────────────────
    if (config.maxBudgetUsd !== undefined && totalCost >= config.maxBudgetUsd) {
      return done('max_budget_usd')
    }

    // ── Step 19: continue ────────────────────────────────────────────────────
  }
  } finally {
    if (autoRuntimeTimer) clearTimeout(autoRuntimeTimer)
  }
}
