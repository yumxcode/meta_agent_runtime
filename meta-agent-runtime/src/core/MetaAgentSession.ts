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
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveConfig, isAnthropicProvider, DEFAULT_SYSTEM_PROMPT, type MetaAgentConfig, type ResolvedConfig } from './config.js'
import type { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import {
  EMPTY_USAGE,
  accumulateUsage,
  type AssistantMessage,
  type ConversationMessage,
  type MetaAgentEvent,
  type MetaAgentTool,
  type TokenUsage,
  type ToolCallContext,
  type ToolDescriptionContext,
} from './types.js'
import { instrumentTool } from '../runtime/instrumentTool.js'
import { SectionRegistry } from './systemPromptSections.js'
import { buildStaticSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './staticPrompt.js'
import { buildDynamicSections, type AgentMode, type OutputStyle } from './dynamicPrompt.js'
import { shouldCompact, runCompact } from './compact/autoCompact.js'
import { saveStateSnapshot, cleanupStateSnapshot } from './compact/stateSnapshot.js'
import {
  saveRunStateSnapshot,
  cleanupRunStateSnapshot,
} from './compact/runStateSnapshot.js'
import type { TaskContract } from './contract/types.js'

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

  // ── Tool description cache ────────────────────────────────────────────────
  /**
   * Resolved description strings, keyed by tool name.
   *
   * Mirrors CC's toolSchemaCache: descriptions are resolved once per session
   * (the first time buildApiToolsAsync() is called) and then reused.
   * The cache is invalidated (flag set to true) whenever registerTool() adds
   * or replaces a tool, so cross-tool references always reflect the current
   * registry.
   */
  private _descriptionCache = new Map<string, string>()
  /**
   * When true, _descriptionCache must be rebuilt before the next API call.
   * Starts true so the first submit() always populates the cache.
   */
  private _descriptionCacheDirty = true

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
   * Plan-mode flag — shared mutable ref so EnterPlanMode / ExitPlanMode tools
   * can flip it without holding a reference to the session itself.
   * When true, every non-concurrency-safe tool call must be approved by the
   * user via askUser() before it executes.
   */
  readonly _planModeRef: { active: boolean } = { active: false }

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

  /**
   * Optional SubAgentBridge — set via setSubAgentBridge().
   * When present, D11 sub-agent notification section is injected every turn.
   */
  private _subAgentBridge: SubAgentBridge | undefined = undefined

  /**
   * Optional TaskContract — set via setTaskContract().
   * When present, a memoized D0 goal-anchor section is prepended to every
   * prompt turn so the model always sees the original user intent and
   * acceptance criteria, even after compaction.
   * Also embedded in RunStateSnapshots on circuit-breaker exits.
   */
  private _taskContract: TaskContract | undefined = undefined

  constructor(config: MetaAgentConfig = {}) {
    // Capture sentinel BEFORE resolveConfig() fills in the default — this is
    // the only reliable moment where we can distinguish "caller omitted the
    // prompt" (undefined) from "caller explicitly passed the default string".
    this._usingDefaultPrompt =
      config.systemPrompt === undefined || config.systemPrompt === DEFAULT_SYSTEM_PROMPT

    this.config = resolveConfig(config)
    // Allow callers (e.g. RoboticsSession) to pin the session ID so that debug
    // file paths and SessionStore entries are consistent with the outer session.
    this.sessionId = config.sessionId ?? randomUUID()
    // Pre-load history for session resume (config.initialMessages)
    this.mutableMessages = config.initialMessages ? [...config.initialMessages] : []
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
      // Per-query memory relevance: only pass the client for Anthropic-backed
      // sessions.  Third-party providers (DeepSeek, Qwen, custom proxies) do not
      // expose claude-haiku-4-5-20251001, so the side-call would error.
      // findRelevantMemories falls back to keyword matching when client is absent.
      currentQuery: prompt,
      client: isAnthropicProvider(this.config.baseURL) ? this.client : undefined,
      // D11: sub-agent notifications — present when a bridge is attached via
      // setSubAgentBridge().  Drains pending notifications into every prompt.
      subAgentBridge: this._subAgentBridge,
      // D0: task contract goal anchor — present when a contract is attached via
      // setTaskContract().  Injected above all other dynamic sections so the
      // original user intent is never displaced by compaction or volatile context.
      taskContract: this._taskContract,
      // D1c: agent directives — load AGENT.md from the project directory.
      // Falls back to process.cwd() when projectDir is not set in config.
      projectDir: this.config.projectDir,
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
        // Persist a recoverable snapshot before yielding so callers can resume
        // with full context about what was done and what remains.
        void saveRunStateSnapshot({
          sessionId:       this.sessionId,
          taskContractId:  this._taskContract?.contractId,
          stopReason:      'max_budget',
          turnsUsed:       turnCount,
          costUsd:         currentCost,
          accumulatedText: accumulatedText,
          sessionStartMs:  this.sessionStartMs,
          rtx:             this.config.runtimeContext,
        }).catch(() => {})
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

      // Build tool schemas for the API (resolves dynamic descriptions, cached)
      const apiTools = await this.buildApiToolsAsync()

      // ── Stream one API response ─────────────────────────────────────────
      let toolUseCalls: Anthropic.ToolUseBlock[] = []

      // ── Debug: write outbound prompt to file ───────────────────────────
      // Full request stored before the API call so it's available even if the
      // call throws. File: ~/.meta-agent/debug/<sessionId>/turn-NNN-req.json
      // Awaited (not fire-and-forget) so the file is guaranteed on disk before
      // the LLM call starts — useful when debugging timeouts or crashes.
      if (this.config.debugMode) {
        await MetaAgentSession._writeDebugFile(this.sessionId, turnCount, 'req', {
          turn:      turnCount,
          timestamp: new Date().toISOString(),
          session:   this.sessionId,
          model:     this.config.model,
          system:    systemPrompt,
          messages:  apiMessages,
          tools:     apiTools.map(t => ({ name: t.name, description: (t as unknown as Record<string,unknown>)['description'] })),
        })
      }

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

        // ── Debug: write inbound response to file ───────────────────────────
        // File: ~/.meta-agent/debug/<sessionId>/turn-NNN-res.json
        if (this.config.debugMode) {
          await MetaAgentSession._writeDebugFile(this.sessionId, turnCount, 'res', {
            turn:        turnCount,
            timestamp:   new Date().toISOString(),
            session:     this.sessionId,
            stop_reason: finalMsg.stop_reason,
            usage: {
              input_tokens:  finalMsg.usage.input_tokens,
              output_tokens: finalMsg.usage.output_tokens,
            },
            content: finalMsg.content,
          })
        }

        // Collect tool_use blocks
        toolUseCalls = finalMsg.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
        )

        // ── Auto-compact check ────────────────────────────────────────────
        // finalMsg.usage.input_tokens is the actual context size used this turn
        // (system prompt + all messages). If it exceeds our threshold, compact
        // the conversation history before the next turn to stay within limits.
        //
        // CRITICAL SAFETY GUARD: never compact when the model returned tool_use
        // blocks.  At this point the assistant message (with tool_use) has been
        // pushed to history but the corresponding tool_result blocks have NOT
        // yet been appended.  Compacting here would remove the tool_use blocks,
        // leaving orphaned tool_result blocks in the next API call — which
        // violates the Anthropic message protocol and causes HTTP 400 errors.
        // We defer compaction until the start of the NEXT clean turn (where
        // toolUseCalls.length === 0 and all results are already in history).
        if (toolUseCalls.length === 0 && shouldCompact(this.config.model, finalMsg.usage.input_tokens)) {
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
        // On successful completion, delete any stale RunStateSnapshot from a
        // prior circuit-breaker hit so resumed sessions start clean.
        void cleanupRunStateSnapshot(
          this.sessionId, this._taskContract?.contractId,
        ).catch(() => {})
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

      // Step 2: execute tool calls.
      // Mirrors CC's toolOrchestration.ts partitionToolCalls() strategy:
      //   • Consecutive concurrency-safe (read-only) tools run in parallel via
      //     Promise.allSettled — safe because they have no filesystem side-effects.
      //   • Every tool that is NOT concurrency-safe runs serially in its own
      //     micro-batch, preventing write-write races (e.g. two bash commands
      //     editing the same file simultaneously).
      // In plan-mode each non-safe call is additionally gate-checked via askUser().
      type ToolBatch = { concurrent: boolean; calls: Anthropic.ToolUseBlock[] }
      const batches: ToolBatch[] = []
      for (const tc of toolUseCalls) {
        const tool = this.toolRegistry.get(tc.name)
        const safe = tool?.isConcurrencySafe === true
        const last = batches[batches.length - 1]
        if (last && last.concurrent && safe) {
          last.calls.push(tc)
        } else {
          batches.push({ concurrent: safe, calls: [tc] })
        }
      }

      const allResults = new Map<string, { tc: Anthropic.ToolUseBlock; result: { content: string; isError: boolean } }>()

      for (const batch of batches) {
        if (batch.concurrent) {
          // Parallel execution — all are concurrency-safe reads
          const settled = await Promise.allSettled(
            batch.calls.map(async (tc) => ({ tc, result: await this.callTool(tc) }))
          )
          for (const outcome of settled) {
            const { tc, result } =
              outcome.status === 'fulfilled'
                ? outcome.value
                : {
                    tc: batch.calls[settled.indexOf(outcome)]!,
                    result: { content: `Tool error: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`, isError: true },
                  }
            allResults.set(tc.id, { tc, result })
          }
        } else {
          // Serial execution — each call may have side effects
          for (const tc of batch.calls) {
            // Plan-mode gate: ask user before executing non-safe tools
            if (this._planModeRef.active) {
              const tool = this.toolRegistry.get(tc.name)
              const askUserFn = (this.config as Record<string, unknown>)['askUser'] as ((q: string, opts: string[]) => Promise<string>) | undefined
              if (askUserFn) {
                const inputStr = JSON.stringify(tc.input, null, 2).slice(0, 400)
                const answer = await askUserFn(
                  `[Plan Mode] Allow tool "${tc.name}"?\n${inputStr}`,
                  ['yes', 'no']
                )
                if (!answer.toLowerCase().startsWith('y')) {
                  allResults.set(tc.id, {
                    tc,
                    result: { content: `[Plan Mode] Tool "${tc.name}" was not approved by user.`, isError: true },
                  })
                  continue
                }
              }
            }
            const result = await this.callTool(tc).catch(err => ({
              content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            }))
            allResults.set(tc.id, { tc, result })
          }
        }
      }

      // Step 3: yield tool_result events and build the user message.
      // Results are emitted in the original toolUseCalls order so the model
      // receives a consistent, stable message regardless of execution order.
      const toolResultContent: ConversationMessage['content'] = []
      for (const tc of toolUseCalls) {
        const entry = allResults.get(tc.id) ?? {
          tc,
          result: { content: `Internal error: no result for tool "${tc.name}"`, isError: true },
        }
        const { result } = entry
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

    // Max turns exceeded — persist a recoverable snapshot before yielding
    const finalCost = estimateCost(this.config.model, this.totalUsage)
    void saveRunStateSnapshot({
      sessionId:       this.sessionId,
      taskContractId:  this._taskContract?.contractId,
      stopReason:      'max_turns',
      turnsUsed:       turnCount,
      costUsd:         finalCost,
      accumulatedText: accumulatedText,
      sessionStartMs:  this.sessionStartMs,
      rtx:             this.config.runtimeContext,
    }).catch(() => {})
    yield {
      type: 'result',
      subtype: 'error_max_turns',
      sessionId: this.sessionId,
      result: accumulatedText,
      isError: true,
      durationMs: Date.now() - startTime,
      numTurns: turnCount,
      stopReason: lastStopReason,
      totalCostUsd: finalCost,
      usage: this.totalUsage,
    }
  }

  /** Abort any in-progress API call. Safe to call multiple times. */
  interrupt(): void {
    this.abortController.abort()
    // Delete any stale snapshots so the next submit() doesn't backfill with
    // records from the cancelled turn.
    void cleanupStateSnapshot(this.sessionId).catch(() => {})
    void cleanupRunStateSnapshot(
      this.sessionId, this._taskContract?.contractId,
    ).catch(() => {})
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
    // Invalidate description cache: a new sibling tool may change other
    // tools' cross-tool guidance (e.g. BashTool learns about a new grep).
    this._descriptionCacheDirty = true
  }

  /**
   * Dynamically update the appendSystemPrompt.
   *
   * Called by RoboticsSession (and other session wrappers) to inject
   * per-turn context (R1-R5 sections) without rebuilding the entire session.
   * The new value takes effect on the NEXT submit() call.
   */
  setAppendSystemPrompt(text: string): void {
    this.config.appendSystemPrompt = text
  }

  /**
   * Attach a SubAgentBridge to this session so that sub-agent completion
   * notifications are automatically injected into the system prompt on every
   * submit() turn (D11 section).
   *
   * Call this once after the bridge is created, before the first submit().
   * The bridge is held by reference — notifications are drained from it lazily
   * just before each API call so stale state never accumulates.
   */
  setSubAgentBridge(bridge: SubAgentBridge): void {
    this._subAgentBridge = bridge
  }

  /**
   * Attach a TaskContract to this session so that:
   *   1. A memoized D0 goal-anchor section is prepended to every prompt turn.
   *   2. The contract ID is embedded in RunStateSnapshots on circuit-breaker exits,
   *      enabling callers to resume with the full original user intent.
   *
   * Call this when a task becomes long-running (campaign launch, sub-agent spawn,
   * or explicit multi-step user request).  The contract is immutable — updates
   * must go through TaskContractStore.update() and then re-set here.
   */
  setTaskContract(contract: TaskContract): void {
    this._taskContract = contract
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

  // ─── Debug file helper ─────────────────────────────────────────────────────

  /**
   * Write a debug snapshot to ~/.meta-agent/debug/<sessionId>/turn-NNN-<kind>.json
   * Called fire-and-forget (void) — errors are silently swallowed so debug I/O
   * never interrupts the main conversation flow.
   *
   * Files are full-fidelity (no truncation) so they can be diffed / inspected
   * offline. The debug dir path is printed by the CLI at startup when --debug.
   */
  static async _writeDebugFile(
    sessionId: string,
    turn: number,
    kind: 'req' | 'res',
    payload: unknown,
  ): Promise<void> {
    try {
      const dir = join(homedir(), '.meta-agent', 'debug', sessionId)
      await mkdir(dir, { recursive: true })
      const filename = `turn-${String(turn).padStart(3, '0')}-${kind}.json`
      await writeFile(join(dir, filename), JSON.stringify(payload, null, 2), 'utf8')
    } catch (err) {
      // Print to stderr so debug-mode users can see I/O failures.
      // Never throw — debug writes must not crash the session.
      process.stderr.write(
        `[meta-agent DEBUG] ⚠ 写入调试文件失败: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  /** Return the debug log directory for this session (may not exist yet). */
  getDebugDir(): string {
    return join(homedir(), '.meta-agent', 'debug', this.sessionId)
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

  /**
   * Resolve all tool descriptions (static strings pass through; async functions
   * are called with ToolDescriptionContext) and return Anthropic-format tool
   * schemas.
   *
   * Results are memoised in _descriptionCache for the lifetime of the tool
   * registry snapshot — mirrors CC's per-session toolSchemaCache.  The cache
   * is invalidated by registerTool() so cross-tool references stay accurate.
   */
  private async buildApiToolsAsync(): Promise<Anthropic.Tool[]> {
    if (this._descriptionCacheDirty) {
      const tools = [...this.toolRegistry.values()]
      const ctx: ToolDescriptionContext = {
        tools,
        toolNames: new Set(tools.map(t => t.name)),
        sessionId: this.sessionId,
        domain: this.config.domain,
      }
      // Resolve all descriptions in parallel (same as CC's Promise.all pattern)
      await Promise.all(
        tools.map(async t => {
          const desc = typeof t.description === 'function'
            ? await t.description(ctx)
            : t.description
          this._descriptionCache.set(t.name, desc)
        })
      )
      this._descriptionCacheDirty = false
    }

    return [...this.toolRegistry.values()].map(t => ({
      name: t.name,
      description: this._descriptionCache.get(t.name) ?? t.name,
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
      planMode: this._planModeRef.active,
      // Inject runtime services so tools can use them directly (e.g. provenance query tools)
      ...(rtx ? {
        jobManager: rtx.jobManager,
        vvChain: rtx.vvChain,
        provenanceTracker: rtx.provenanceTracker,
      } : {}),
    }

    // ── Tool execution guard ────────────────────────────────────────────────
    // Fires before every tool call when the CLI (or any caller) registers a
    // beforeToolCall hook — e.g. interactive TTY confirmation for destructive ops.
    if (this.config.beforeToolCall) {
      const guard = await this.config.beforeToolCall(
        tc.name,
        tc.input as Record<string, unknown>,
      )
      if (guard.action === 'deny') {
        return {
          content:
            `[操作已拒绝] ${guard.reason ?? '用户拒绝了此操作。'} ` +
            `请尝试其他方式完成任务，或等待用户进一步指示。`,
          isError: true,
        }
      }
      if (guard.action === 'redirect') {
        return {
          content:
            `[用户提供替代指导]\n${guard.instructions}\n\n` +
            `请完全按照上述指导重新规划并执行，不要再尝试原来的方案。`,
          isError: false,
        }
      }
      // action === 'allow': fall through to normal execution
    }

    try {
      const result = await tool.call(tc.input as Record<string, unknown>, context)
      // Mark provenance dirty so the next submit() invalidates session_provenance
      // without a redundant provenanceTracker.list() call (Fix #4).
      //
      // P2 fix: dirty flag must fire on BOTH success and error results —
      // instrumentTool records failed calls too, so a failed tool call also
      // produces a new provenance entry that must appear in the next turn's
      // session_provenance section.  The previous `!result.isError` guard
      // caused failures to be silently omitted from the next prompt.
      if (this.config.runtimeContext) {
        this._provenanceDirty = true
      }
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `Tool error: ${message}`, isError: true }
    }
  }
}
