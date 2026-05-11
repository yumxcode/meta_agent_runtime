/**
 * MetaAgentSession — the primary entry point for meta-agent conversations.
 *
 * Mirrors the interface of Claude Code's QueryEngine so the two can be
 * swapped as CC internals become more accessible.
 *
 * Ref: claude-code-source-code-main/src/QueryEngine.ts
 *
 * Architecture highlights:
 *  - AsyncGenerator streaming (same pattern as CC's submitMessage)
 *  - AbortController for interrupt()
 *  - Multi-turn conversation state maintained in mutableMessages
 *  - Tool-use loop: model → tool_use → call() → tool_result → model (repeat)
 *  - Per-session cost tracking
 */

import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { resolveConfig, DEFAULT_SYSTEM_PROMPT, type MetaAgentConfig, type ResolvedConfig } from './config.js'
import {
  EMPTY_USAGE,
  accumulateUsage,
  type AssistantMessage,
  type ConversationMessage,
  type MetaAgentEvent,
  type MetaAgentTool,
  type TokenUsage,
  type ToolCallContext,
} from './types.js'
import { instrumentTool } from '../runtime/instrumentTool.js'
import { SectionRegistry } from './systemPromptSections.js'
import { buildStaticSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './staticPrompt.js'
import { buildDynamicSections, type AgentMode, type OutputStyle } from './dynamicPrompt.js'
import { shouldCompact, runCompact } from './compact/autoCompact.js'
import { saveStateSnapshot, cleanupStateSnapshot } from './compact/stateSnapshot.js'

// ─────────────────────────────────────────────────────────────────────────────
// Cost estimation (approximate, based on public pricing)
// ─────────────────────────────────────────────────────────────────────────────

const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-opus-4-6':           { input: 15.0,  output: 75.0  },
  'claude-sonnet-4-6':         { input: 3.0,   output: 15.0  },
  'claude-haiku-4-5-20251001': { input: 0.8,   output: 4.0   },
  // DeepSeek  (https://api.deepseek.com/anthropic)
  'deepseek-v4-flash':         { input: 0.27,  output: 1.10  },
  'deepseek-v4-pro':           { input: 0.55,  output: 2.19  },
  // Legacy aliases (kept for backward compatibility)
  'deepseek-chat':             { input: 0.27,  output: 1.10  },
  'deepseek-reasoner':         { input: 0.55,  output: 2.19  },
  // Qwen — 阿里云百炼  (https://dashscope.aliyuncs.com/apps/anthropic)
  'qwen-max':                  { input: 0.40,  output: 1.20  },
  'qwen-plus':                 { input: 0.08,  output: 0.26  },
  'qwen-turbo':                { input: 0.02,  output: 0.06  },
  // GLM — 智谱  (via compatible proxy)
  'glm-4':                     { input: 0.10,  output: 0.10  },
  'glm-4-flash':               { input: 0.0,   output: 0.0   },
}

function estimateCost(model: string, usage: TokenUsage): number {
  const rates = COST_PER_MILLION[model]
  // Unknown model → return 0 rather than silently billing at Claude Opus rates.
  // Callers can check getEstimatedCost() === 0 to detect "pricing unknown".
  if (!rates) return 0
  return (
    (usage.inputTokens / 1_000_000) * rates.input +
    (usage.outputTokens / 1_000_000) * rates.output
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MetaAgentSession
// ─────────────────────────────────────────────────────────────────────────────

export class MetaAgentSession {
  private config: ResolvedConfig
  private client: Anthropic
  private sessionId: string
  private readonly sessionStartMs = Date.now()
  private mutableMessages: ConversationMessage[]
  private abortController: AbortController
  private totalUsage: TokenUsage
  private toolRegistry: Map<string, MetaAgentTool>

  // ── Prompt engineering ────────────────────────────────────────────────────
  /** Cached once per deployment; never changes within a session. */
  private readonly staticPrompt: string = buildStaticSystemPrompt()
  /** Per-session memoization cache for dynamic sections. */
  private readonly sectionRegistry = new SectionRegistry()
  /**
   * Set to true by callTool() whenever a tool run completes (Fix #4).
   * submit() checks this flag instead of calling provenanceTracker.list() on
   * every turn — eliminating a potentially expensive I/O call from the hot path.
   * The flag is cleared after session_provenance is invalidated.
   */
  private _provenanceDirty = false
  /**
   * True when the caller did NOT provide a custom systemPrompt.
   * Computed once in the constructor from the raw (unresolved) config so the
   * per-turn submit() path never has to reconstruct or compare the default
   * string — eliminating the risk of silent divergence when DEFAULT_SYSTEM_PROMPT
   * is updated in config.ts.
   */
  private readonly _usingDefaultPrompt: boolean

  /**
   * The fully-assembled system prompt from the most recent submit() call.
   * Includes both static (S1-S10) and dynamic (D1-D10) sections, separated
   * by SYSTEM_PROMPT_DYNAMIC_BOUNDARY.  Null until the first submit().
   */
  private _lastSystemPrompt: string | null = null

  /**
   * Guards against concurrent submit() calls on the same session instance.
   *
   * MetaAgentSession is NOT concurrent-safe: mutableMessages is a plain array
   * with no locking.  Two simultaneous submit() calls would interleave their
   * user messages and produce corrupted API payloads.
   *
   * When true, a submit() call is already in progress; new callers receive an
   * immediate error rather than silently corrupting the conversation state.
   */
  private _submitInFlight = false

  constructor(config: MetaAgentConfig = {}) {
    // Capture sentinel BEFORE resolveConfig() fills in the default — this is
    // the only reliable moment where we can distinguish "caller omitted the
    // prompt" (undefined) from "caller explicitly passed the default string".
    this._usingDefaultPrompt =
      config.systemPrompt === undefined || config.systemPrompt === DEFAULT_SYSTEM_PROMPT

    this.config = resolveConfig(config)
    this.sessionId = randomUUID()
    this.mutableMessages = []
    this.abortController = new AbortController()
    this.totalUsage = EMPTY_USAGE
    this.toolRegistry = new Map(
      this.config.tools.map(t => [t.name, t])
    )

    if (!this.config.apiKey) {
      throw new Error(
        'API key is required. Set it via config.apiKey or the ANTHROPIC_API_KEY environment variable.\n' +
        'For third-party providers (DeepSeek, Qwen, GLM…) also set config.baseURL to the provider\'s ' +
        'Anthropic-compatible endpoint (e.g. https://api.deepseek.com/anthropic).'
      )
    }

    // If a RuntimeContext is provided, instrument all initial tools with V&V + provenance
    if (this.config.runtimeContext) {
      const rtx = this.config.runtimeContext
      const sp = this.config.systemPrompt
      this.toolRegistry = new Map(
        this.config.tools.map(t => [
          t.name,
          instrumentTool(t, rtx, { systemPrompt: sp }),
        ])
      )
    }

    this.client = new Anthropic({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
      maxRetries: this.config.maxRetries,
    })
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Submit a prompt and receive a stream of MetaAgentEvents.
   *
   * Usage:
   *   for await (const event of session.submit('Analyse this battery cell')) {
   *     if (event.type === 'text') process.stdout.write(event.text)
   *     if (event.type === 'result') console.log('Done:', event.result)
   *   }
   *
   * @param prompt  — the user message to submit.
   * @param mode    — detected agent mode (direct / agentic / campaign).
   *                  Defaults to 'agentic'. Pass the value from ModeDetector
   *                  when available; MetaAgentSession does not re-detect it.
   */
  async *submit(
    prompt: string,
    mode: AgentMode = 'agentic',
  ): AsyncGenerator<MetaAgentEvent, void, unknown> {
    // ── Concurrency guard ─────────────────────────────────────────────────────
    // MetaAgentSession is single-turn: mutableMessages has no locking.
    // Concurrent submit() calls would interleave messages and corrupt context.
    if (this._submitInFlight) {
      throw new Error(
        `[MetaAgent:${this.sessionId.slice(0, 8)}] Cannot call submit() concurrently on the same session. ` +
        'Wait for the current turn to complete before submitting a new prompt.',
      )
    }
    this._submitInFlight = true

    try {
      yield* this._submitInner(prompt, mode)
    } finally {
      this._submitInFlight = false
    }
  }

  /** Internal generator — extracted so the try/finally above is clean. */
  private async *_submitInner(
    prompt: string,
    mode: AgentMode,
  ): AsyncGenerator<MetaAgentEvent, void, unknown> {
    const startTime = Date.now()
    let turnCount = 0
    let lastStopReason: string | null = null
    let accumulatedText = ''

    // ── Build system prompt via Section Registry ──────────────────────────
    //
    // Invalidate session_provenance when callTool() has written a new record
    // since the last submit().  The dirty flag avoids a provenanceTracker.list()
    // call on every turn (Fix #4 — eliminates redundant I/O from hot path).
    if (this._provenanceDirty) {
      this.sectionRegistry.invalidate('session_provenance')
      this._provenanceDirty = false
    }

    const dynamicSections = buildDynamicSections({
      sessionId: this.sessionId,
      sessionStartMs: this.sessionStartMs,
      tools: [...this.toolRegistry.values()],
      mode,
      rtx: this.config.runtimeContext,
      language: this.config.language,
      mcpServers: this.config.mcpServers,
      outputStyle: this.config.outputStyle,
      // Per-query memory relevance: pass current prompt + client so D1b can
      // select the most relevant topic files via Haiku side-call.
      currentQuery: prompt,
      client: this.client,
    })

    const dynamicPrompt = await this.sectionRegistry.resolveToString(dynamicSections)

    // Honour legacy appendSystemPrompt override when set (backward compatibility).
    // Otherwise use the new layered static + dynamic prompt.
    let systemPrompt: string
    if (!this._usingDefaultPrompt) {
      // Caller provided a custom system prompt — respect it and append dynamic context
      systemPrompt = this.config.systemPrompt
      if (this.config.appendSystemPrompt) {
        systemPrompt += '\n\n' + this.config.appendSystemPrompt
      }
      if (dynamicPrompt) systemPrompt += '\n\n' + dynamicPrompt
    } else {
      // Use the new engineered prompt
      systemPrompt = this.staticPrompt + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + dynamicPrompt
      if (this.config.appendSystemPrompt) {
        systemPrompt += '\n\n' + this.config.appendSystemPrompt
      }
    }

    // Capture the assembled prompt for inspection via getLastSystemPrompt()
    this._lastSystemPrompt = systemPrompt

    // Add user message to history
    this.mutableMessages.push({ role: 'user', content: prompt })

    if (this.config.verbose) {
      console.error(`[MetaAgent:${this.sessionId.slice(0, 8)}] Turn ${turnCount + 1}, prompt: ${prompt.slice(0, 80)}...`)
    }

    // ── Agentic loop ─────────────────────────────────────────────────────────
    while (turnCount < this.config.maxTurns) {
      // Budget guard
      const currentCost = estimateCost(this.config.model, this.totalUsage)
      if (currentCost >= this.config.maxBudgetUsd) {
        yield {
          type: 'result',
          subtype: 'error_max_budget',
          sessionId: this.sessionId,
          result: '',
          isError: true,
          durationMs: Date.now() - startTime,
          numTurns: turnCount,
          stopReason: lastStopReason,
          totalCostUsd: currentCost,
          usage: this.totalUsage,
        }
        return
      }

      turnCount++
      accumulatedText = ''

      // Build Anthropic API messages (convert internal format)
      const apiMessages = this.buildApiMessages()

      // Build tool schemas for the API
      const apiTools = this.buildApiTools()

      // ── Stream one API response ─────────────────────────────────────────
      let toolUseCalls: Anthropic.ToolUseBlock[] = []

      try {
        const streamParams: Anthropic.MessageStreamParams = {
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          system: systemPrompt,
          messages: apiMessages,
          ...(apiTools.length > 0 ? { tools: apiTools } : {}),
        }

        const stream = await this.client.messages.stream(streamParams, {
          signal: this.abortController.signal,
        })

        // Yield streaming text deltas
        for await (const event of stream) {
          if (this.config.includeStreamEvents) {
            yield { type: 'stream_event', event, sessionId: this.sessionId }
          }

          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            accumulatedText += event.delta.text
            yield { type: 'text', text: event.delta.text, sessionId: this.sessionId }
          }
        }

        // Collect final message after stream completes
        const finalMsg = await stream.finalMessage()
        lastStopReason = finalMsg.stop_reason ?? null

        // Accumulate usage
        this.totalUsage = accumulateUsage(this.totalUsage, {
          inputTokens: finalMsg.usage.input_tokens,
          outputTokens: finalMsg.usage.output_tokens,
          cacheCreationInputTokens:
            (finalMsg.usage as unknown as Record<string, number>)['cache_creation_input_tokens'] ?? 0,
          cacheReadInputTokens:
            (finalMsg.usage as unknown as Record<string, number>)['cache_read_input_tokens'] ?? 0,
        })

        // Push assistant message into history.
        // Thinking and redacted_thinking blocks MUST be preserved verbatim —
        // reasoning models (DeepSeek v4, Claude extended-thinking) require them
        // to be echoed back in the next API call or they return HTTP 400.
        const assistantMessage: AssistantMessage = {
          role: 'assistant',
          content: finalMsg.content.map(block => {
            if (block.type === 'text') return { type: 'text' as const, text: block.text }
            if (block.type === 'tool_use') return {
              type: 'tool_use' as const,
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            }
            if (block.type === 'thinking') return {
              type: 'thinking' as const,
              thinking: block.thinking,
              signature: block.signature,
            }
            if (block.type === 'redacted_thinking') return {
              type: 'redacted_thinking' as const,
              data: (block as { type: 'redacted_thinking'; data: string }).data,
            }
            // Unknown block type — preserve as opaque text rather than dropping it,
            // so at least the conversation can continue (though it may be wrong).
            return { type: 'text' as const, text: JSON.stringify(block) }
          }),
        }
        this.mutableMessages.push(assistantMessage)

        // Collect tool_use blocks
        toolUseCalls = finalMsg.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
        )

        // ── Auto-compact check ────────────────────────────────────────────
        // finalMsg.usage.input_tokens is the actual context size used this turn
        // (system prompt + all messages). If it exceeds our threshold, compact
        // the conversation history before the next turn to stay within limits.
        if (shouldCompact(this.config.model, finalMsg.usage.input_tokens)) {
          // Persist current state before compacting so the compact summary
          // can reference all provenance IDs produced in this session.
          await saveStateSnapshot(
            this.sessionId,
            this.config.runtimeContext,
            this.sessionStartMs,
          )
          try {
            const { newMessages } = await runCompact(
              this.client,
              this.config.model,
              this.mutableMessages,
              this.sessionId,
              this.abortController.signal,
            )
            this.mutableMessages = newMessages
            // Invalidate all memoized dynamic sections so they regenerate
            // with accurate context (session_provenance, campaign_context, etc.)
            this.sectionRegistry.invalidateAll()
            if (this.config.verbose) {
              console.error(
                `[MetaAgent:${this.sessionId.slice(0, 8)}] Auto-compact triggered at ` +
                `${finalMsg.usage.input_tokens} tokens; history replaced with summary.`,
              )
            }
            // Compact succeeded — clean up the pre-compact snapshot
            void cleanupStateSnapshot(this.sessionId).catch(() => {})
          } catch (compactErr) {
            // Compact failure is non-fatal — log and continue without compacting.
            //
            // IMPORTANT: do NOT clean up the snapshot on failure.
            // If the snapshot is removed, the next submit() will re-trigger
            // compact on the same oversized context, fail again, and loop
            // forever.  Keeping the snapshot lets the operator recover manually
            // and prevents a compact-death-spiral.
            console.error(
              `[MetaAgent:${this.sessionId.slice(0, 8)}] Auto-compact failed (snapshot preserved for recovery): ` +
              `${compactErr instanceof Error ? compactErr.message : String(compactErr)}`,
            )
          }
        }

      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return  // Clean interrupt — caller called interrupt()
        }
        throw err
      }

      // ── If model stopped naturally, we're done ──────────────────────────
      if (lastStopReason === 'end_turn' || toolUseCalls.length === 0) {
        const totalCost = estimateCost(this.config.model, this.totalUsage)
        yield {
          type: 'result',
          subtype: 'success',
          sessionId: this.sessionId,
          result: accumulatedText,
          isError: false,
          durationMs: Date.now() - startTime,
          numTurns: turnCount,
          stopReason: lastStopReason,
          totalCostUsd: totalCost,
          usage: this.totalUsage,
        }
        return
      }

      // ── Execute tool calls and inject results ───────────────────────────
      // Step 1: yield tool_use events (cannot yield inside Promise.all callbacks)
      for (const tc of toolUseCalls) {
        yield {
          type: 'tool_use' as const,
          toolUseId: tc.id,
          toolName: tc.name,
          toolInput: tc.input as Record<string, unknown>,
          sessionId: this.sessionId,
        }
      }

      // Step 2: execute all tools in parallel.
      // allSettled (vs all) ensures that one tool throwing does not silently
      // abandon the other in-flight calls — every result is accounted for and
      // returned to the model (Fix #11).
      const settled = await Promise.allSettled(
        toolUseCalls.map(async (tc) => ({
          tc,
          result: await this.callTool(tc),
        }))
      )

      // Step 3: yield tool_result events and build the user message.
      // Rejected entries (tool threw unexpectedly past callTool's catch) are
      // surfaced as error tool results so the model can recover gracefully.
      const toolResultContent: ConversationMessage['content'] = []
      for (const outcome of settled) {
        const { tc, result } =
          outcome.status === 'fulfilled'
            ? outcome.value
            : {
                tc: toolUseCalls[settled.indexOf(outcome)]!,
                result: {
                  content: `Tool error: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
                  isError: true,
                },
              }
        yield {
          type: 'tool_result' as const,
          toolUseId: tc.id,
          content: result.content,
          isError: result.isError,
          sessionId: this.sessionId,
        }
        if (Array.isArray(toolResultContent)) {
          toolResultContent.push({
            type: 'tool_result' as const,
            tool_use_id: tc.id,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          })
        }
      }

      const toolResultBlocks: ConversationMessage = {
        role: 'user',
        content: toolResultContent,
      }

      this.mutableMessages.push(toolResultBlocks)

      // Continue the loop with tool results in context
    }

    // Max turns exceeded
    yield {
      type: 'result',
      subtype: 'error_max_turns',
      sessionId: this.sessionId,
      result: accumulatedText,
      isError: true,
      durationMs: Date.now() - startTime,
      numTurns: turnCount,
      stopReason: lastStopReason,
      totalCostUsd: estimateCost(this.config.model, this.totalUsage),
      usage: this.totalUsage,
    }
  }

  /** Abort any in-progress API call. Safe to call multiple times. */
  interrupt(): void {
    this.abortController.abort()
    // Delete any stale snapshot so the next submit() doesn't backfill with
    // records from the cancelled turn.
    void cleanupStateSnapshot(this.sessionId).catch(() => {})
    // Create a new controller so the session can be used again after interrupt
    this.abortController = new AbortController()
  }

  /** Register a new tool at runtime (no restart needed). */
  registerTool(tool: MetaAgentTool): void {
    // Instrument the tool if a RuntimeContext is configured
    const wrapped = this.config.runtimeContext
      ? instrumentTool(tool, this.config.runtimeContext, {
          systemPrompt: this.config.systemPrompt,
        })
      : tool
    this.toolRegistry.set(tool.name, wrapped)
    this.config.tools = [...this.toolRegistry.values()]
  }

  /** All messages in the current conversation. */
  getMessages(): readonly ConversationMessage[] {
    return this.mutableMessages
  }

  /** Accumulated token usage across all turns. */
  getUsage(): TokenUsage {
    return this.totalUsage
  }

  /** Estimated total cost in USD. */
  getEstimatedCost(): number {
    return estimateCost(this.config.model, this.totalUsage)
  }

  getSessionId(): string {
    return this.sessionId
  }

  /**
   * Returns the full system prompt assembled during the most recent submit() call.
   *
   * The string contains:
   *   • Static section (S1-S10): built once by buildStaticSystemPrompt()
   *   • SYSTEM_PROMPT_DYNAMIC_BOUNDARY: the HTML comment separator
   *   • Dynamic section (D1-D10): resolved per-turn by SectionRegistry
   *
   * Returns null if no submit() has been called yet.
   * Useful for debugging context engineering, prompt loading, and memory retrieval.
   */
  getLastSystemPrompt(): string | null {
    return this._lastSystemPrompt
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private buildApiMessages(): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = []

    for (const msg of this.mutableMessages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'user', content: msg.content })
        } else {
          // Convert tool_result blocks
          const blocks: Anthropic.ToolResultBlockParam[] = msg.content
            .filter((b): b is { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean } =>
              b.type === 'tool_result'
            )
            .map(b => ({
              type: 'tool_result' as const,
              tool_use_id: b.tool_use_id,
              content: b.content,
              ...(b.is_error ? { is_error: true } : {}),
            }))
          if (blocks.length > 0) {
            result.push({ role: 'user', content: blocks })
          }
        }
      } else {
        // assistant message — reconstruct API content blocks.
        // thinking / redacted_thinking MUST be passed back verbatim so
        // reasoning models (DeepSeek v4, Claude extended-thinking) accept the next turn.
        const blocks = msg.content.map(b => {
          if (b.type === 'text') return { type: 'text' as const, text: b.text }
          if (b.type === 'tool_use') return {
            type: 'tool_use' as const,
            id: b.id,
            name: b.name,
            input: b.input,
          }
          if (b.type === 'thinking') return {
            type: 'thinking' as const,
            thinking: b.thinking,
            signature: b.signature,
          }
          if (b.type === 'redacted_thinking') return {
            type: 'redacted_thinking' as const,
            data: b.data,
          }
          // Unknown — fallback to text (should not happen after the push guard above)
          return { type: 'text' as const, text: JSON.stringify(b) }
        }) as Anthropic.ContentBlock[]
        result.push({ role: 'assistant', content: blocks })
      }
    }

    return result
  }

  private buildApiTools(): Anthropic.Tool[] {
    return [...this.toolRegistry.values()].map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }))
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async callTool(
    tc: Anthropic.ToolUseBlock,
  ): Promise<{ content: string; isError: boolean }> {
    const tool = this.toolRegistry.get(tc.name)

    if (!tool) {
      return {
        content: `Tool '${tc.name}' is not registered in this session.`,
        isError: true,
      }
    }

    const rtx = this.config.runtimeContext
    const context: ToolCallContext = {
      sessionId: this.sessionId,
      agentId: this.sessionId,
      abortSignal: this.abortController.signal,
      // Inject runtime services so tools can use them directly (e.g. provenance query tools)
      ...(rtx ? {
        jobManager: rtx.jobManager,
        vvChain: rtx.vvChain,
        provenanceTracker: rtx.provenanceTracker,
      } : {}),
    }

    try {
      const result = await tool.call(tc.input as Record<string, unknown>, context)
      // Mark provenance dirty so the next submit() invalidates session_provenance
      // without a redundant provenanceTracker.list() call (Fix #4).
      if (!result.isError && this.config.runtimeContext) {
        this._provenanceDirty = true
      }
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `Tool error: ${message}`, isError: true }
    }
  }
}
