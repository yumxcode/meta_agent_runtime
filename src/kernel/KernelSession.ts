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
import type { KernelMessage } from './types/KernelMessage.js'
import type { KernelTool } from './types/KernelTool.js'
import type { TokenUsage } from './types/TokenUsage.js'
import { emptyUsage, addUsage } from './types/TokenUsage.js'
import { makeTextUserMessage } from './messages/MessageFactory.js'
import { FileStateCache } from './session/FileStateCache.js'
import { createBootstrapState } from './session/BootstrapState.js'
import { runKernelLoop, type LoopResult, type LoopTerminationReason } from './loop/KernelLoop.js'
import type { AutoCompactTrackingState } from './compact/AutoCompact.js'

const VOLATILE_CONTEXT_PREFIX_START = '<context>\n'
const VOLATILE_CONTEXT_PREFIX_END = '\n</context>\n\n---\n\n'

function stripVolatileContextPrefix(text: string): string {
  if (!text.startsWith(VOLATILE_CONTEXT_PREFIX_START)) return text
  const end = text.lastIndexOf(VOLATILE_CONTEXT_PREFIX_END)
  if (end < 0) return text
  return text.slice(end + VOLATILE_CONTEXT_PREFIX_END.length)
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

export class KernelSession {
  private _config: KernelConfig
  private _messages: KernelMessage[] = []
  private _abortController: AbortController = new AbortController()
  private _totalUsage: TokenUsage = emptyUsage()
  private _totalCostUsd = 0
  private _fileCache: FileStateCache
  private _autoCompactTracking: AutoCompactTrackingState | undefined
  private readonly _sessionId: string
  private readonly _cwd: string
  private _permissionDenials: PermissionDenial[] = []
  private _submitInFlight = false

  constructor(config: KernelConfig) {
    this._config = { ...config }
    this._messages = [...(config.initialMessages ?? [])]
    this._fileCache = new FileStateCache()
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
      this._config.onMessagesUpdate?.(this._messages)

      // ── Run the loop. Events are yielded immediately; the terminal result is
      // still emitted even when the loop throws.
      let loopResult: LoopResult | undefined
      let loopError: unknown

      try {
        const gen = runKernelLoop({
          config: this._config,
          mutableMessages: this._messages,
          abortController: this._abortController,
          fileCache: this._fileCache,
          sessionId: this._sessionId,
          cwd: this._cwd,
          cumulativeCostUsd: this._totalCostUsd,
          autoCompactTracking: this._autoCompactTracking,
        })

        let step = await gen.next()
        while (!step.done) {
          yield step.value as KernelEvent
          step = await gen.next()
        }
        // The generator's return value is the LoopResult
        loopResult = step.value as LoopResult | undefined
      } catch (err: unknown) {
        loopError = err
      }

      const resultEvent = this._buildResultEvent(loopResult, loopError)
      stripVolatileContextFromMessages(this._messages)

      // Emit terminal result event
      yield resultEvent

      // Update session cumulative state
      if (loopResult) {
        this._totalUsage = addUsage(this._totalUsage, loopResult.totalUsage)
        this._totalCostUsd = loopResult.costUsd
        this._autoCompactTracking = loopResult.autoCompactTracking
        this._permissionDenials.push(...loopResult.permissionDenials)
        if (loopResult.fallbackTriggered) {
          this._config = { ...this._config, model: loopResult.finalModel }
        }
        this._config.onMessagesUpdate?.(this._messages)
      }
    } finally {
      this._submitInFlight = false
    }
  }

  /** Interrupt the currently-running loop */
  interrupt(): void {
    this._abortController.abort('interrupt')
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

  // ── Private helpers ────────────────────────────────────────────────────────

  private _buildResultEvent(
    loopResult: LoopResult | undefined,
    loopError: unknown,
  ): ResultEvent {
    if (loopResult) {
      type Subtype = ResultEvent['subtype']
        const subtypeMap: Record<LoopTerminationReason, Subtype> = {
          success:           'success',
          max_turns:         'error_max_turns',
          no_progress:       'error_during_execution',
          blocking_limit:    'error_blocking_limit',
        aborted_streaming: 'error_during_execution',
        aborted_tools:     'error_during_execution',
        max_budget_usd:    'error_max_budget_usd',
        error:             'error_during_execution',
      }

      return {
        type: 'result',
        subtype: subtypeMap[loopResult.reason],
        sessionId: this._sessionId,
        usage: loopResult.totalUsage,
        costUsd: loopResult.costUsd,
        numTurns: loopResult.numTurns,
        stopReason: null,
        resultText: loopResult.resultText,
        permissionDenials: loopResult.permissionDenials,
      }
    }

    return {
      type: 'result',
      subtype: 'error_during_execution',
      sessionId: this._sessionId,
      usage: emptyUsage(),
      costUsd: this._totalCostUsd,
      numTurns: 0,
      stopReason: null,
      resultText: '',
      errors: [String(loopError ?? 'Unknown error')],
    }
  }
}
