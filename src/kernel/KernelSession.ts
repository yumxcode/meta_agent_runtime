/**
 * KernelSession — the public entry point.
 * Equivalent to CC's QueryEngine.
 *
 * Manages per-session state:
 *  - Message history (mutableMessages)
 *  - Cumulative token usage / cost
 *  - AbortController lifecycle
 *  - FileStateCache
 *
 * Delegates the actual loop to runKernelLoop().
 */
import type { KernelConfig } from './types/KernelConfig.js'
import type { KernelEvent, ResultEvent, PermissionDenial } from './types/KernelEvent.js'
import type { ContentBlock, KernelMessage } from './types/KernelMessage.js'
import type { KernelTool } from './types/KernelTool.js'
import type { TokenUsage } from './types/TokenUsage.js'
import { emptyUsage, addUsage } from './types/TokenUsage.js'
import { makeTextUserMessage } from './messages/MessageFactory.js'
import { FileStateCache } from './session/FileStateCache.js'
import { createBootstrapState } from './session/BootstrapState.js'
import { runKernelLoop, buildMessagesToKeepAfterCompact, type LoopResult, type LoopTerminationReason } from './loop/KernelLoop.js'
import { clearTimedOutRunningTools } from './tools/ToolExecution.js'
import type { AutoCompactTrackingState } from './compact/AutoCompact.js'
import { compactConversation } from './compact/CompactConversation.js'
import { getMessagesAfterCompactBoundary } from './messages/MessageNormalizer.js'
import { applyToolResultBudget } from './tools/ToolResultBudget.js'
import { tokenCountWithEstimation } from './api/TokenCount.js'
import { assembleSystemPrompt } from './utils/AssembleSystemPrompt.js'
import {
  classifyExecutionFailure,
  serializeExecutionError,
} from '../infra/failures/ExecutionFailure.js'
import { resolveProvider } from '../providers/registry.js'

import { stripVolatileContextPrefix } from './utils/VolatileContext.js'
import { createTelemetryRecorder } from './telemetry/recorder.js'
import { openTrajectory, closeTrajectory, trajectoryEnabled } from '../trajectory/hub.js'
import { captureGitBase, formatGitBase, type GitBase } from '../infra/git/gitBase.js'
import { sha256, summarizeOutput } from '../trajectory/privacy.js'
import type { TrajectoryRecorder } from '../trajectory/recorder.js'
import type { RecordContext, TrajectoryItem, TrajectorySubject } from '../trajectory/types.js'

/** Result of a manual (user-initiated) compaction. */
export interface ManualCompactResult {
  compacted: boolean
  /** Reason when compacted=false (already-compact, in-flight turn, error…). */
  reason?: string
  /** Token estimate of the context BEFORE compaction. */
  previousTokens?: number
  /** Token estimate of the context AFTER compaction. */
  postTokens?: number
}

/**
 * Cap for the captured top-level goal anchor text. Long enough to keep a
 * detailed request verbatim, short enough that the anchor can never meaningfully
 * contribute to context pressure.
 */
const ORIGINAL_GOAL_MAX_CHARS = 2_000
/**
 * How many of the session's earliest real user messages are captured into the
 * default top-level goal anchor. The first message alone often under-specifies
 * the goal (e.g. "帮我看个问题" followed by the actual task in message 2-3), so
 * the first few messages are kept together. Auto mode may replace this anchor
 * when a new task is explicitly detected in the same backend session.
 */
export const ORIGINAL_GOAL_MESSAGE_COUNT = 3
/**
 * Per-message budget for goal messages AFTER the first. Kept small so the
 * combined goal (2000 + 2×700 + labels) stays under the compact pipeline's
 * anchor clip limits (CONTINUITY_MAX_ANCHOR_CHARS 4000 / FALLBACK 3600) and
 * none of the captured messages is silently clipped away downstream.
 */
const ORIGINAL_GOAL_FOLLOWUP_MAX_CHARS = 700

/**
 * Extract the durable goal text from a candidate user message: text blocks
 * only, volatile prefix stripped, meta/steering/compact artifacts excluded.
 */
function extractUserGoalText(
  message: KernelMessage,
  maxChars: number = ORIGINAL_GOAL_MAX_CHARS,
): string | null {
  if (
    message.role !== 'user' ||
    message.isMeta ||
    message.isCompactSummary ||
    message.isCompactBoundary ||
    message.isSteering ||
    // Keep-set clones are mid-session requests re-emitted by compaction; on a
    // resumed history they sit at the front and must not be mistaken for the
    // session's original goal.
    message.isKeepSetClone ||
    message.sourceToolAssistantUUID
  ) return null
  const text = message.content
    .filter((block): block is ContentBlock & { type: 'text'; text: string } =>
      block.type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map(block => stripVolatileContextPrefix(block.text))
    .join('\n')
    .trim()
  if (!text) return null
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars - 14)}… [truncated]`
}

/**
 * Collect goal parts from the earliest real user messages (up to `limit`).
 * Used on the resume path; the live path appends incrementally in submitMessage.
 */
export function collectOriginalUserGoalParts(
  messages: readonly KernelMessage[],
  limit: number = ORIGINAL_GOAL_MESSAGE_COUNT,
): string[] {
  const parts: string[] = []
  for (const message of messages) {
    if (parts.length >= limit) break
    const maxChars = parts.length === 0
      ? ORIGINAL_GOAL_MAX_CHARS
      : ORIGINAL_GOAL_FOLLOWUP_MAX_CHARS
    const goal = extractUserGoalText(message, maxChars)
    if (goal) parts.push(goal)
  }
  return parts
}

/**
 * Format captured goal parts into the single anchor string consumed by the
 * compact pipeline. A single part is returned bare (back-compat with the
 * pre-existing single-message format); multiple parts are labelled and
 * indented so they render as one bullet in the continuity anchors.
 */
export function formatOriginalUserGoal(parts: readonly string[]): string | null {
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0] ?? null
  return parts.map((part, i) => `[user message ${i + 1}] ${part}`).join('\n  ')
}

function stripVolatileContextFromMessages(messages: KernelMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== 'user') continue
    let changed = false
    const content = msg.content.map(block => {
      if (block.type !== 'text') return block
      const stripped = stripVolatileContextPrefix(block.text)
      if (stripped === block.text) return block
      changed = true
      return { ...block, text: stripped }
    })
    if (changed) msg.content = content
  }
}

function stripThinkingBlocksFromMutableMessages(messages: KernelMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    let changed = false
    const content = msg.content.filter((block: ContentBlock) => {
      const keep = block.type !== 'thinking' && block.type !== 'redacted_thinking'
      if (!keep) changed = true
      return keep
    })
    if (!changed) continue
    if (msg.role === 'assistant' && content.length === 0) {
      messages.splice(i, 1)
    } else {
      msg.content = content
    }
  }
}

export class KernelSession {
  private _config: KernelConfig
  private _messages: KernelMessage[] = []
  private _abortController: AbortController = new AbortController()
  private _totalUsage: TokenUsage = emptyUsage()
  private _totalCostUsd = 0
  private _fileCache: FileStateCache
  private _autoCompactTracking: AutoCompactTrackingState | undefined
  /** Session-lifetime completed tool-batch count (survives submitMessage calls). */
  private _toolBatchCount: number
  private _checkpointRevision: number
  private _lastDriftToolBatchCount: number
  private _lastDriftCheckpointRevision: number
  private readonly _sessionId: string
  private readonly _cwd: string
  private _permissionDenials: PermissionDenial[] = []
  private _submitInFlight = false
  /**
   * Queue of mid-turn user corrections ("steering"). Pushed by steer() while a
   * turn is in flight; drained by the kernel loop at each iteration boundary.
   */
  private _steerQueue: string[] = []
  /** S16: cap permission-denial buffer so a million-turn session can't grow it forever. */
  private static readonly MAX_PERMISSION_DENIALS = 1_000
  /** S1: guard against double dispose. */
  private _disposed = false
  /**
   * The durable top-level user-goal anchor captured before compaction can fold
   * it into a summary. Normal sessions keep the initial goal for the kernel
   * lifetime; auto mode can explicitly re-anchor this when a user starts a new
   * task in the same backend session. Multiple initial messages are kept
   * because the first message alone often under-specifies the goal
   * (greeting/context first, actual task in message 2-3).
   */
  private _originalUserGoalParts: string[] = []
  private _trajectoryPromise: Promise<TrajectoryRecorder | null> | undefined
  private _trajectoryRecorder: TrajectoryRecorder | null = null
  private _trajectoryPersistenceDegraded = false

  constructor(config: KernelConfig) {
    this._config = { ...config }
    this._totalCostUsd =
      Number.isFinite(config.initialCostUsd) && (config.initialCostUsd ?? 0) > 0
        ? config.initialCostUsd!
        : 0
    this._messages = [...(config.initialMessages ?? [])]
    // Resume path: recover the goal from the earliest real user messages in
    // the restored history (best available source; pre-compact history is gone).
    this._originalUserGoalParts = collectOriginalUserGoalParts(this._messages)
    this._fileCache = new FileStateCache()
    this._toolBatchCount = Math.max(0, config.initialToolBatchCount ?? 0)
    this._checkpointRevision = Math.max(0, config.initialCheckpointRevision ?? 0)
    // A resumed session starts a fresh 30-batch drift window from the durable
    // recovery point. This avoids an immediate duplicate drift check caused by
    // comparing restored cumulative counters against zero.
    this._lastDriftToolBatchCount = this._toolBatchCount
    this._lastDriftCheckpointRevision = this._checkpointRevision
    const bootstrap = createBootstrapState(config.cwd, config.sessionId)
    this._sessionId = bootstrap.sessionId
    this._cwd = bootstrap.cwd
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Submit a new user message and run the agentic loop until completion.
   * Yields KernelEvents; the last event is always a 'result' event.
   */
  async *submitMessage(
    prompt: string | Array<{ type: string; [key: string]: unknown }>,
  ): AsyncGenerator<KernelEvent> {
    if (this._submitInFlight) {
      throw new Error(
        `[KernelSession:${this._sessionId.slice(0, 8)}] Cannot call submitMessage() concurrently on the same session. ` +
        'Wait for the current turn to complete before submitting a new prompt.',
      )
    }
    this._submitInFlight = true
    // Drop any steering queued while idle — it would otherwise be injected
    // before the model has even seen this submit's prompt.
    this._steerQueue.length = 0

    const runId = crypto.randomUUID()
    const turnId = crypto.randomUUID()
    const runStartedAt = Date.now()
    const runStartedCostUsd = this._totalCostUsd
    // Probed once per run and reused for both the descriptor (first run only)
    // and this run's run_started item, so a turn never pays for two git probes.
    //
    // Skipped entirely when trajectory recording is off: the probe spawns git,
    // and paying that on every turn to produce a value nothing will record is
    // pure cost. It also keeps the pre-run await window — during which an
    // interrupt() has no controller to cancel — no wider than it already was.
    const gitBase = trajectoryEnabled(this._config.trajectory?.enabled)
      ? await captureGitBase(this._cwd)
      : undefined
    const trajectory = await this._getTrajectoryRecorder(gitBase)
    let trajectoryRecordChain: Promise<void> = Promise.resolve()
    const record = (item: TrajectoryItem, context: RecordContext = {}): void => {
      if (!trajectory) return
      trajectoryRecordChain = trajectoryRecordChain
        .then(() => trajectory.record(item, { runId, turnId, ...context }))
        .catch(error => {
          this._markTrajectoryDegraded(trajectory, error)
        })
    }
    const flushCheckpoint = this._config.onCheckpointBoundary
      ? async (event: Parameters<NonNullable<KernelConfig['onCheckpointBoundary']>>[0]) => {
          const result = await this._config.onCheckpointBoundary!(event)
          if (result.updated && result.checkpoint) {
            record({
              type: 'state_checkpoint',
              mode: result.checkpoint.mode,
              stateSchemaVersion: result.checkpoint.stateSchemaVersion,
              revision: result.revision,
              contentHash: result.checkpoint.contentHash,
              storeRef: result.checkpoint.storeRef,
            })
          }
          return result
        }
      : undefined
    let runResultRecorded = false

    if (trajectory) {
      try {
        await trajectory.record({
          type: 'run_started',
          reason: this._config.querySource ?? 'submit',
          budget: {
            maxTurns: finiteOrNull(this._config.maxTurns),
            maxBudgetUsd: finiteOrNull(this._config.maxBudgetUsd),
            maxOutputTokens: finiteOrNull(this._config.maxOutputTokens),
          },
          ...(gitBase ? { gitBase } : {}),
        }, { runId, turnId })
        const provider = resolveProvider({
          apiKey: this._config.apiKey,
          baseURL: this._config.baseURL,
          model: this._config.model,
        }).provider
        await trajectory.record({
          type: 'turn_context',
          model: this._config.model,
          provider,
          approvalPolicy: this._config.canUseTool ? 'configured' : 'allow_all',
          sandboxMode: this._config.autonomousMode ? 'autonomous_workspace_jail' : 'configured',
          tools: this._config.tools.map(tool => ({
            name: tool.name,
            schemaHash: sha256(stableJson(tool.inputJSONSchema)),
          })),
          budgetRemaining: {
            costUsd: finiteOrNull(
              (this._config.maxBudgetUsd ?? Infinity) - this._totalCostUsd,
            ),
          },
          policyVersion: sha256(stableJson({
            systemPrompt: this._config.systemPrompt ?? '',
            appendSystemPrompt: this._config.appendSystemPrompt ?? '',
            querySource: this._config.querySource ?? 'main',
          })),
        }, { runId, turnId })
      } catch (error) {
        this._markTrajectoryDegraded(trajectory, error)
      }
    }

    // One recorder per submitMessage() call: `runId` scopes a single
    // request→result cycle, which is the unit the summary counters describe.
    // Null when telemetry is disabled, which is the default.
    const telemetry = createTelemetryRecorder(this._sessionId, this._config.telemetry)

    try {
      // Fresh abort controller for this submitMessage call
      this._abortController = new AbortController()
      stripVolatileContextFromMessages(this._messages)

      // Build user message
      const userMessage: KernelMessage =
        typeof prompt === 'string'
          ? makeTextUserMessage(prompt)
          : {
              uuid: crypto.randomUUID(),
              role: 'user',
              content: prompt as KernelMessage['content'],
            }

      this._messages.push(userMessage)
      record({ type: 'message', message: userMessage as unknown as Record<string, unknown> })
      if (this._originalUserGoalParts.length < ORIGINAL_GOAL_MESSAGE_COUNT) {
        const maxChars = this._originalUserGoalParts.length === 0
          ? ORIGINAL_GOAL_MAX_CHARS
          : ORIGINAL_GOAL_FOLLOWUP_MAX_CHARS
        const goal = extractUserGoalText(userMessage, maxChars)
        if (goal) this._originalUserGoalParts.push(goal)
      }
      this._config.onMessagesUpdate?.(this._messages)

      // ── Run the loop. Events are yielded immediately; the terminal result is
      // still emitted even when the loop throws.
      let loopResult: LoopResult | undefined
      let loopError: unknown

      try {
        const gen = runKernelLoop({
          config: flushCheckpoint
            ? { ...this._config, onCheckpointBoundary: flushCheckpoint }
            : this._config,
          mutableMessages: this._messages,
          abortController: this._abortController,
          fileCache: this._fileCache,
          sessionId: this._sessionId,
          cwd: this._cwd,
          cumulativeCostUsd: this._totalCostUsd,
          autoCompactTracking: this._autoCompactTracking,
          initialToolBatchCount: this._toolBatchCount,
          initialCheckpointRevision: this._checkpointRevision,
          initialLastDriftToolBatchCount: this._lastDriftToolBatchCount,
          initialLastDriftCheckpointRevision: this._lastDriftCheckpointRevision,
          drainSteering: () => this._steerQueue.splice(0),
          originalUserGoal: formatOriginalUserGoal(this._originalUserGoalParts) ?? undefined,
          onMessagesAppended: messages => {
            for (const message of messages) {
              record({
                type: 'message',
                message: message as unknown as Record<string, unknown>,
              })
            }
          },
          onCompaction: event => {
            record({
              type: 'compaction',
              previousTokens: event.previousTokens,
              summaryTokens: event.summaryTokens,
              replacementHistory: event.replacementHistory as unknown as Array<Record<string, unknown>>,
            })
          },
          onTrajectoryItems: items => {
            for (const item of items) record(item)
          },
        })

        let step = await gen.next()
        while (!step.done) {
          const event = step.value as KernelEvent
          // Observe BEFORE yielding: the consumer may take arbitrarily long (a
          // terminal render, a network push) or throw, and the record of what
          // the kernel emitted must not depend on what the consumer did with it.
          telemetry?.observe(event)
          if (event.type === 'tool_result') {
            if (event.permissionDecision) {
              record({
                type: 'approval',
                toolUseId: event.id,
                toolName: event.toolName,
                decision: event.permissionDecision.decision,
                decidedBy: event.permissionDecision.decidedBy,
                reason: event.permissionDecision.reason,
              })
            }
            const output = summarizeOutput(event.content)
            record({
              type: 'tool_outcome',
              toolUseId: event.id,
              toolName: event.toolName,
              input: event.input,
              durationMs: event.durationMs ?? 0,
              isError: event.isError,
              ...output,
              command: event.execution?.command,
              cwd: event.execution?.cwd,
              exitCode: event.execution?.exitCode,
              signal: event.execution?.signal,
              timedOut: event.execution?.timedOut,
              aborted: event.execution?.aborted,
              ...(event.execution?.shellSessionId
                ? { shellSessionId: event.execution.shellSessionId }
                : {}),
            })
          }
          yield event
          step = await gen.next()
        }
        // The generator's return value is the LoopResult
        loopResult = step.value as LoopResult | undefined
      } catch (err: unknown) {
        loopError = err
      }

      // Every natural loop exit is a hard checkpoint boundary. This runs before
      // the result event is emitted so a consumer observing completion can rely
      // on the durable state already being updated.
      if (this._config.autonomousMode && flushCheckpoint) {
        try {
          const boundary = await flushCheckpoint({
            type: 'termination',
            sessionId: this._sessionId,
            toolBatchCount: loopResult?.toolBatchCount ?? this._toolBatchCount,
            estimatedCostUsd: loopResult?.costUsd ?? this._totalCostUsd,
            stopReason: loopResult?.reason ?? 'error',
          })
          this._checkpointRevision = Math.max(this._checkpointRevision, boundary.revision)
          if (loopResult) loopResult.checkpointRevision = this._checkpointRevision
        } catch {
          // Best-effort: checkpoint failure must not replace the actual result.
        }
      }

      const resultEvent = this._buildResultEvent(loopResult, loopError)
      stripVolatileContextFromMessages(this._messages)
      stripThinkingBlocksFromMutableMessages(this._messages)

      // The result carries the counters the summary reports (cost, turns,
      // usage, denials), so it must be folded in before `finish()` builds it.
      telemetry?.observe(resultEvent)

      await trajectoryRecordChain
      await this._recordTurnDiff(trajectory, runId, turnId)
      if (trajectory) {
        try {
          await trajectory.record({
            type: 'run_result',
            outcome: resultEvent.subtype,
            isError: resultEvent.subtype !== 'success' && resultEvent.subtype !== 'parked',
            stopReason: resultEvent.stopReason,
            usage: {
              inputTokens: loopResult?.totalUsage.inputTokens ?? 0,
              outputTokens: loopResult?.totalUsage.outputTokens ?? 0,
              cacheReadTokens: loopResult?.totalUsage.cacheReadTokens ?? 0,
              cacheWriteTokens: loopResult?.totalUsage.cacheWriteTokens ?? 0,
            },
            costUsd: Math.max(0, resultEvent.costUsd - runStartedCostUsd),
            durationMs: Math.max(0, Date.now() - runStartedAt),
            resultSummary: summarizeOutput(resultEvent.resultText).outputSummary,
          }, { runId, turnId })
          runResultRecorded = true
          await trajectory.barrier('run_result')
        } catch (error) {
          this._markTrajectoryDegraded(trajectory, error)
        }
      }

      // Emit terminal result event
      yield resultEvent

      // Update session cumulative state
      if (loopResult) {
        this._totalUsage = addUsage(this._totalUsage, loopResult.totalUsage)
        this._totalCostUsd = loopResult.costUsd
        this._autoCompactTracking = loopResult.autoCompactTracking
        this._toolBatchCount = loopResult.toolBatchCount
        this._checkpointRevision = loopResult.checkpointRevision
        this._lastDriftToolBatchCount = loopResult.lastDriftToolBatchCount
        this._lastDriftCheckpointRevision = loopResult.lastDriftCheckpointRevision
        this._permissionDenials.push(...loopResult.permissionDenials)
        // S16: cap the denial buffer so a long-running session that gets
        // repeatedly denied tools doesn't grow this array indefinitely.
        const overflow = this._permissionDenials.length - KernelSession.MAX_PERMISSION_DENIALS
        if (overflow > 0) this._permissionDenials.splice(0, overflow)
        if (loopResult.fallbackTriggered) {
          this._config = { ...this._config, model: loopResult.finalModel }
        }
        this._config.onMessagesUpdate?.(this._messages)
      }
    } finally {
      this._submitInFlight = false
      // Async generators can be abandoned by their consumer before the normal
      // result path. Close the run explicitly so the trajectory never contains
      // a permanently ambiguous half-run after the generator's finally runs.
      if (trajectory && !runResultRecorded) {
        try {
          await trajectoryRecordChain
          await trajectory.record({
            type: 'run_result',
            outcome: this._abortController.signal.aborted ? 'interrupted' : 'abandoned',
            isError: true,
            stopReason: this._abortController.signal.aborted ? 'interrupted' : 'consumer_abandoned',
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            costUsd: Math.max(0, this._totalCostUsd - runStartedCostUsd),
            durationMs: Math.max(0, Date.now() - runStartedAt),
          }, { runId, turnId })
          runResultRecorded = true
          await trajectory.barrier('abandoned_run_result')
        } catch (error) {
          this._markTrajectoryDegraded(trajectory, error)
        }
      }
      // In `finally` so a run that threw, was aborted, or was abandoned by a
      // consumer that stopped iterating still writes its summary. A telemetry
      // record that only exists for clean runs would be missing exactly the
      // runs worth investigating.
      await telemetry?.finish()
      if (trajectory && this._trajectoryPersistenceDegraded) {
        await trajectory.barrier('persistence_degraded_retry').catch(() => undefined)
      }
    }
  }

  /** Interrupt the currently-running loop */
  interrupt(): void {
    this._abortController.abort('interrupt')
  }

  /**
   * Inject a mid-turn user correction ("steering"). The text is queued and the
   * running loop appends it as a user message at its next iteration boundary —
   * the in-flight stream is NOT aborted. Returns true if the correction was
   * accepted (a turn is in flight), false otherwise (nothing is running, so the
   * caller should submit it as a normal message instead).
   */
  steer(text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed || !this._submitInFlight) return false
    this._steerQueue.push(trimmed)
    return true
  }

  /**
   * Replace the deterministic compact goal anchor with a new top-level task.
   *
   * Auto mode calls this when the user starts a NEW goal in an existing session
   * so verify/drift/checkpoint and compaction all agree on the same current
   * objective. Normal agentic/robotics sessions never call it; they keep the
   * initial-goal behaviour.
   */
  reanchorOriginalGoal(goal: string): void {
    const sanitized = extractUserGoalText(makeTextUserMessage(goal))
    this._originalUserGoalParts = sanitized ? [sanitized] : []
    // A NEW top-level task starts a fresh drift window from the current durable
    // point: the new goal must produce its OWN checkpoint advance + 30 new tool
    // batches before drift fires, instead of inheriting the prior task's drift
    // cadence (which could fire immediately or never). Mirrors the resume-path
    // baseline reset in the constructor. Revision itself stays monotonic.
    this._lastDriftToolBatchCount = this._toolBatchCount
    this._lastDriftCheckpointRevision = this._checkpointRevision
  }

  /**
   * Manual (user-initiated) compaction — `/compact`.
   *
   * Runs the SAME pipeline as auto-compact (summary side-call, keep-set,
   * deterministic anchors, top-level goal anchor, quality gate + fallback) but
   * bypasses the token-threshold check: the user decides WHEN, the pipeline
   * decides HOW. Refuses while a turn is in flight — compaction mutates the
   * message history the loop is iterating.
   */
  async compactNow(): Promise<ManualCompactResult> {
    if (this._submitInFlight) {
      return { compacted: false, reason: '当前轮次仍在执行中，请等待完成后再压缩。' }
    }

    stripVolatileContextFromMessages(this._messages)
    const budgeted = applyToolResultBudget(this._messages, this._config.tools)
    const messagesForQuery = [...getMessagesAfterCompactBoundary(budgeted)]

    const hasRealUser = messagesForQuery.some(extractUserGoalText)
    if (messagesForQuery.length < 2 || !hasRealUser) {
      return { compacted: false, reason: '当前上下文过短，没有可压缩的内容。' }
    }

    const previousTokens = tokenCountWithEstimation(messagesForQuery)
    const effectiveSystemPrompt =
      assembleSystemPrompt(this._config.systemPrompt, this._config.appendSystemPrompt) ?? ''

    try {
      if (this._config.autonomousMode && this._config.onCheckpointBoundary) {
        try {
          const boundary = await this._config.onCheckpointBoundary({
            type: 'compact_before',
            sessionId: this._sessionId,
            toolBatchCount: this._toolBatchCount,
            estimatedCostUsd: this._totalCostUsd,
          })
          this._checkpointRevision = Math.max(this._checkpointRevision, boundary.revision)
        } catch { /* best-effort */ }
      }
      const result = await compactConversation(messagesForQuery, this._fileCache, {
        model: this._config.compact?.model,
        apiKey: this._config.apiKey,
        baseURL: this._config.baseURL,
        systemPrompt: effectiveSystemPrompt,
        customInstructions: this._config.compact?.customInstructions,
        deterministicAnchors: this._config.compact?.deterministicAnchors,
        originalUserGoal: formatOriginalUserGoal(this._originalUserGoalParts) ?? undefined,
        messagesToKeep: buildMessagesToKeepAfterCompact(messagesForQuery, this._config.tools),
        promptProfile: this._config.compact?.promptProfile,
        maxRetries: this._config.maxRetries,
      })

      this._messages.splice(0, this._messages.length, ...result.postCompactMessages)
      this._autoCompactTracking = {
        compacted: true,
        turnId: crypto.randomUUID(),
        turnCounter: 0,
        consecutiveFailures: 0,
      }
      this._config.onMessagesUpdate?.(this._messages)
      const trajectory = await this._getTrajectoryRecorder()
      if (trajectory) {
        try {
          await trajectory.record({
            type: 'compaction',
            previousTokens,
            summaryTokens: result.summaryTokenEstimate ?? 0,
            replacementHistory: result.postCompactMessages as unknown as Array<Record<string, unknown>>,
          })
          await trajectory.barrier('manual_compaction')
        } catch (error) {
          this._markTrajectoryDegraded(trajectory, error)
        }
      }
      if (this._config.autonomousMode && this._config.onCheckpointBoundary) {
        try {
          const boundary = await this._config.onCheckpointBoundary({
            type: 'compact_after',
            sessionId: this._sessionId,
            toolBatchCount: this._toolBatchCount,
            estimatedCostUsd: this._totalCostUsd,
          })
          this._checkpointRevision = Math.max(this._checkpointRevision, boundary.revision)
        } catch { /* best-effort */ }
      }

      return {
        compacted: true,
        previousTokens,
        postTokens: tokenCountWithEstimation(getMessagesAfterCompactBoundary(this._messages)),
      }
    } catch (err) {
      if (this._config.autonomousMode && this._config.onCheckpointBoundary) {
        try {
          const boundary = await this._config.onCheckpointBoundary({
            type: 'compact_after',
            sessionId: this._sessionId,
            toolBatchCount: this._toolBatchCount,
            estimatedCostUsd: this._totalCostUsd,
          })
          this._checkpointRevision = Math.max(this._checkpointRevision, boundary.revision)
        } catch { /* best-effort */ }
      }
      return {
        compacted: false,
        reason: `压缩失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /** Read-only view of the full message history */
  getMessages(): readonly KernelMessage[] {
    return this._messages
  }

  getSessionId(): string {
    return this._sessionId
  }

  getTotalUsage(): TokenUsage {
    return { ...this._totalUsage }
  }

  getTotalCostUsd(): number {
    return this._totalCostUsd
  }

  /** Change the main model for future submitMessage calls */
  setModel(model: string): void {
    this._config = { ...this._config, model }
  }

  /**
   * Set or update the suffix appended to the system prompt.
   * Used by CampaignSession to inject dynamic context before each submit.
   */
  setAppendSystemPrompt(suffix: string): void {
    this._config = { ...this._config, appendSystemPrompt: suffix }
  }

  /** Add a tool (no-op if tool with same name already exists) */
  addTool(tool: KernelTool): void {
    if (this._config.tools.some(t => t.name === tool.name)) return
    this._config = { ...this._config, tools: [...this._config.tools, tool] }
  }

  /** Add or replace a tool by name */
  upsertTool(tool: KernelTool): void {
    const idx = this._config.tools.findIndex(t => t.name === tool.name)
    if (idx < 0) {
      this._config = { ...this._config, tools: [...this._config.tools, tool] }
    } else {
      const tools = [...this._config.tools]
      tools[idx] = tool
      this._config = { ...this._config, tools }
    }
  }

  getPermissionDenials(): readonly PermissionDenial[] {
    return this._permissionDenials
  }

  isTrajectoryPersistenceDegraded(): boolean {
    return this._trajectoryPersistenceDegraded ||
      this._trajectoryRecorder?.isCanonicalDegraded() === true ||
      this._trajectoryRecorder?.isProjectionDegraded() === true
  }

  /**
   * A canonical write the session could not complete. The in-memory flag serves
   * this process; pushing it into the recorder puts the same fact in
   * `health.json`, which is what survives a crash and what `sessions list` and
   * the resume picker actually read. Two views, one truth.
   */
  private _markTrajectoryDegraded(recorder: TrajectoryRecorder | null, error?: unknown): void {
    this._trajectoryPersistenceDegraded = true
    recorder?.markExternalCanonicalFailure(error ?? new Error('trajectory write failed'))
  }

  /**
   * S1: Release all per-session state so the GC can reclaim the message buffer,
   * file-state cache, tool list and config closures.  Idempotent and safe to
   * call from finally blocks.
   *
   *   • Aborts any in-flight loop via the abort controller.
   *   • Empties _messages / _permissionDenials in-place so any holder still
   *     iterating sees a consistent empty view.
   *   • Drops the FileStateCache and clears the tools array on the config copy
   *     so wrapped/instrumented closures (which transitively pin
   *     RuntimeContext, ProvenanceTracker, JobManager) become unreachable.
   *   • Clears onMessagesUpdate so external owners don't pin this session
   *     through their own closures.
   */
  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    try { this._abortController.abort('dispose') } catch { /* ignore */ }
    this._messages.length = 0
    this._permissionDenials.length = 0
    this._steerQueue.length = 0
    this._fileCache.clear()
    // Detach external callback so the consumer's closure (UI, DB writer) no
    // longer keeps this session alive via the callback.
    this._config = {
      ...this._config,
      tools: [],
      onMessagesUpdate: undefined,
      onCheckpointBoundary: undefined,
    }
    this._autoCompactTracking = undefined
    clearTimedOutRunningTools(this._sessionId)
    void closeTrajectory(this._trajectorySubject(), this._trajectoryOptions()).catch(() => undefined)
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _trajectorySubject(): TrajectorySubject {
    return this._config.trajectory?.subject ?? { kind: 'session', sessionId: this._sessionId }
  }

  private _trajectoryOptions(): { enabled?: boolean; rootDir?: string } {
    return {
      enabled: this._config.trajectory?.enabled,
      rootDir: this._config.trajectory?.rootDir,
    }
  }

  /**
   * @param gitBase Starting point of the run that is opening this trajectory.
   *   Only consumed when the trajectory is created, which is the first run —
   *   the descriptor field describes where the whole trajectory began. Later
   *   runs record their own base on `run_started`, which is the granularity a
   *   replay actually needs.
   */
  private _getTrajectoryRecorder(gitBase?: GitBase): Promise<TrajectoryRecorder | null> {
    if (!this._trajectoryPromise) {
      const resolvedProvider = resolveProvider({
        apiKey: this._config.apiKey,
        baseURL: this._config.baseURL,
        model: this._config.model,
      })
      this._trajectoryPromise = openTrajectory({
        subject: this._trajectorySubject(),
        mode: this._config.trajectory?.mode ?? (this._config.autonomousMode ? 'auto' : 'agentic'),
        rootTrajectoryId: this._config.trajectory?.rootTrajectoryId,
        parentTrajectoryId: this._config.trajectory?.parentTrajectoryId,
        workspace: this._cwd,
        workspaceId: this._config.trajectory?.workspaceId,
        provider: resolvedProvider.provider,
        // The field has existed since A3 with no assignment anywhere in the
        // repository; this is it. Encoded as a string because the descriptor
        // type predates the structured form.
        gitBase: formatGitBase(gitBase),
        source: this._config.trajectory?.source ?? 'kernel_session',
      }, this._trajectoryOptions()).then(recorder => {
        this._trajectoryRecorder = recorder
        return recorder
      })
    }
    return this._trajectoryPromise
  }

  private async _recordTurnDiff(
    recorder: TrajectoryRecorder | null,
    runId: string,
    turnId: string,
  ): Promise<void> {
    if (!recorder || !this._config.turnDiff) return
    try {
      const summary = await this._config.turnDiff.summary()
      await recorder.record({
        type: 'turn_diff',
        filesChanged: summary.filesChanged,
        linesAdded: summary.linesAdded,
        linesRemoved: summary.linesRemoved,
        files: summary.entries
          .filter(entry => entry.status !== 'unchanged')
          .map(entry => ({
            path: entry.path,
            status: entry.status,
            added: entry.added,
            removed: entry.removed,
            contentHash: entry.after === null ? undefined : sha256(entry.after),
          })),
      }, { runId, turnId })
    } catch (error) {
      this._markTrajectoryDegraded(recorder, error)
    }
  }

  private _buildResultEvent(
    loopResult: LoopResult | undefined,
    loopError: unknown,
  ): ResultEvent {
    const providerId = resolveProvider({
      apiKey: this._config.apiKey,
      baseURL: this._config.baseURL,
      model: this._config.model,
    }).provider
    if (loopResult) {
      type Subtype = ResultEvent['subtype']
        const subtypeMap: Record<LoopTerminationReason, Subtype> = {
          success:           'success',
          parked:            'parked',
          max_turns:         'error_max_turns',
          no_progress:       'error_during_execution',
          blocking_limit:    'error_blocking_limit',
        aborted_streaming: 'error_during_execution',
        aborted_tools:     'error_during_execution',
        max_budget_usd:    'error_max_budget_usd',
        max_output_tokens: 'error_max_output_tokens',
        verify_exhausted:  'error_during_execution',
        auto_verify_unavailable: 'error_during_execution',
        auto_drift_unavailable: 'error_during_execution',
        auto_runtime_limit: 'error_during_execution',
        auto_tool_batch_limit: 'error_during_execution',
        // A phase hook requesting abort is an INTENTIONAL clean stop by the
        // orchestration layer, not a failure — surface it as success.
        phase_hook_abort:  'success',
        // A phase hook flagging FAILURE (e.g. auto_orch launch when the plan run
        // did not complete) is a real error — surface it as such so callers that
        // inspect result.subtype don't mistake a failed orchestration for success.
        phase_hook_fail:   'error_during_execution',
        error:             'error_during_execution',
      }

      const subtype = subtypeMap[loopResult.reason]
      const failure = subtype === 'success' || subtype === 'parked'
        ? undefined
        : classifyExecutionFailure({
            subtype,
            stopReason: loopResult.reason,
            resultText: loopResult.resultText,
            providerId,
          })
      return {
        type: 'result',
        subtype,
        sessionId: this._sessionId,
        // M3: report CUMULATIVE usage so it matches costUsd, which the loop
        // already returns cumulatively (seeded with cumulativeCostUsd). The
        // session's running _totalUsage is added to this loop's usage here
        // because _totalUsage isn't folded in until after this event is built.
        usage: addUsage(this._totalUsage, loopResult.totalUsage),
        costUsd: loopResult.costUsd,
        numTurns: loopResult.numTurns,
        stopReason: loopResult.reason === 'success' ? null : loopResult.reason,
        resultText: loopResult.resultText,
        permissionDenials: loopResult.permissionDenials,
        ...(loopResult.parkRequest ? { parkRequest: loopResult.parkRequest } : {}),
        ...(failure ? { failure } : {}),
      }
    }

    const errors = serializeExecutionError(loopError)
    const failure = classifyExecutionFailure({
      subtype: 'error_during_execution',
      errors,
      providerId,
    })
    return {
      type: 'result',
      subtype: 'error_during_execution',
      sessionId: this._sessionId,
      usage: emptyUsage(),
      costUsd: this._totalCostUsd,
      numTurns: 0,
      stopReason: null,
      resultText: '',
      errors,
      failure,
    }
  }
}

function finiteOrNull(value: number | undefined): number {
  return Number.isFinite(value) ? value! : -1
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}
