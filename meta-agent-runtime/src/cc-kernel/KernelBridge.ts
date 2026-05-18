/**
 * KernelBridge — wires @meta-agent/cc-kernel (CC's production QueryEngine)
 * into the MetaAgentSession API surface.
 *
 * CC's QueryEngine provides:
 *   • Full multi-turn tool-use loop (no manual agentic loop needed)
 *   • Auto-compaction (5 strategies when context window fills)
 *   • Session persistence to disk
 *   • Production-grade permission/safety layer (configured permissive here)
 *
 * KernelBridge translates between the two type worlds:
 *   MetaAgentTool ←→ CC Tool (wrapped with minimal interface)
 *   SDKMessage    ←→ MetaAgentEvent
 */

import {
  QueryEngine,
  getDefaultAppState,
  createStore,
  createFileStateCacheWithSizeLimit,
  setOriginalCwd,
  setProjectRoot,
  enableConfigs,
  setSessionPersistenceDisabled,
} from '@meta-agent/cc-kernel'

import type { MetaAgentEvent, MetaAgentTool, TokenUsage, ConversationMessage } from '../core/types.js'
import { EMPTY_USAGE, accumulateUsage } from '../core/types.js'
import { resolveConfig } from '../core/config.js'
import type { MetaAgentConfig, ResolvedConfig } from '../core/config.js'
import { instrumentTool } from '../runtime/instrumentTool.js'
import { MetaAgentContextStore } from '../coordination/MetaAgentContextStore.js'
import { buildCompactInstructions } from '../core/compact/compactPrompt.js'
import {
  saveStateSnapshot,
  loadStateSnapshot,
  cleanupStateSnapshot,
} from '../core/compact/stateSnapshot.js'

// ── Module-level CC environment bootstrap ─────────────────────────────────────
//
// CLAUDE_CODE_SIMPLE=1 ("bare mode") makes CC read ANTHROPIC_API_KEY directly
// from the environment without requiring the interactive auth setup that the
// CLI normally enforces. Must be set before any CC module initializes its lazy
// globals, which is why this runs at module load time rather than per-instance.
if (!process.env['CLAUDE_CODE_SIMPLE']) {
  process.env['CLAUDE_CODE_SIMPLE'] = '1'
}
// NODE_ENV=test: (a) bypasses CC config-access guard, (b) takes the fast auth
// key path in getAnthropicApiKeyWithSource, (c) disables some CC telemetry init.
// NOTE: This also enables CC's VCR layer (withVCR/withStreamingVCR), which
// replays cached API fixtures instead of making real requests. We disable VCR
// via META_AGENT_NO_VCR=1 so KernelBridge always hits the live endpoint (or
// the mock server in tests).
//
// Fix #13: only set NODE_ENV when the host process has not already chosen
// 'production' or 'development' — overwriting those would change behaviour of
// other libraries loaded in the same process (logging, feature flags, etc.).
if (!process.env['NODE_ENV'] ||
    (process.env['NODE_ENV'] !== 'production' && process.env['NODE_ENV'] !== 'development')) {
  process.env['NODE_ENV'] = 'test'
}
// Disable CC's VCR fixture replay — KernelBridge talks directly to ANTHROPIC_BASE_URL.
process.env['META_AGENT_NO_VCR'] = '1'
//
// Fix #13: proxy env vars are intentionally NOT cleared at module load time.
// The host application may be legitimately behind a corporate HTTP proxy.
// Proxy clearing is deferred to _bootstrapEngine() and scoped only to the
// CC Anthropic client, which is controlled via ANTHROPIC_BASE_URL instead.

// ── CC Tool wrapper ───────────────────────────────────────────────────────────
//
// CC's Tool type is a complex interface with 10+ required methods.
// We implement only what QueryEngine actually calls at runtime.
// All the rendering/UI methods (renderToolResultMessage, extractSearchText,
// etc.) are omitted — they're only used by the CLI UI layer.

/**
 * Wrap a MetaAgentTool into a CC-compatible Tool object.
 * The `getCallContext` callback is invoked at call time so the wrapper always
 * gets fresh sessionId / runtime-services even after _rebuildEngine().
 * The `getSnapshotArgs` callback provides session metadata for the post-call
 * state snapshot (fire-and-forget — never blocks the tool result).
 */
function wrapMetaAgentTool(
  tool: MetaAgentTool,
  getCallContext: () => import('../core/types.js').ToolCallContext,
  getSnapshotArgs: () => { sessionId: string; rtx: import('../runtime/RuntimeContext.js').RuntimeContext | undefined; sessionStartMs: number },
): any {
  return {
    name: tool.name,
    // CC calls tool.prompt(opts) (via toolToAPISchema) to get the description string
    // and tool.description(input) as a secondary path — both return the static string.
    prompt: async (_opts: unknown) => tool.description,
    description: async (_input: unknown) => tool.description,
    // CC uses inputJSONSchema directly when it's present (preferred over inputSchema).
    // The inputSchema stub also needs safeParse() for partitionToolCalls() and
    // parse() for other CC internals that validate tool input via Zod.
    inputSchema: {
      parse: (x: unknown) => x,
      safeParse: (x: unknown) => ({ success: true, data: x }),
      _def: { typeName: 'ZodObject' },
    } as any,
    inputJSONSchema: tool.inputSchema,
    // The actual tool execution — return { data } which CC then serialises.
    // After each call we fire a non-blocking snapshot so that if CC compacts
    // mid-turn, `buildCompactInstructions` can backfill from the snapshot.
    call: async (input: unknown) => {
      const result = await tool.call(input as Record<string, unknown>, getCallContext())
      // Fire-and-forget: write snapshot with the latest provenance + campaign state
      const { sessionId, rtx, sessionStartMs } = getSnapshotArgs()
      void saveStateSnapshot(sessionId, rtx, sessionStartMs).catch(() => {})
      return { data: result.content, isError: result.isError ?? false }
    },
    // Required predicates
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    isReadOnly: () => false,
    isDestructive: () => false,
    // Converts our { data } result → Anthropic ToolResultBlockParam
    mapToolResultToToolResultBlockParam: (content: string, toolUseID: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content) }],
    }),
    // Auto-classifier input (security classifier) — not needed for meta-agent
    toAutoClassifierInput: () => '',
    // UI rendering — not used without a terminal
    renderToolResultMessage: () => null,
    extractSearchText: () => '',
    interruptBehavior: () => 'block' as const,
  }
}

// ── SDKMessage → MetaAgentEvent translator ────────────────────────────────────

function* translateSDKMessage(
  msg: any,
  sessionId: string,
  startMs: number,
  turnCount: { value: number },
  totalUsage: TokenUsage,
): Generator<MetaAgentEvent> {
  switch (msg.type) {
    case 'assistant': {
      const content: any[] = msg.message?.content ?? []
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          yield { type: 'text', text: block.text, sessionId }
        } else if (block.type === 'tool_use') {
          yield {
            type: 'tool_use',
            toolName: block.name,
            toolInput: block.input ?? {},
            toolUseId: block.id,
            sessionId,
          }
        }
        // thinking blocks and other types are silently skipped
      }
      turnCount.value++
      break
    }
    case 'tool_result': {
      // Standalone tool_result message — unlikely in practice but handled for safety.
      yield {
        type: 'tool_result',
        toolUseId: msg.tool_use_id ?? '',
        content: typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content ?? ''),
        isError: msg.is_error ?? false,
        sessionId,
      }
      break
    }
    case 'user': {
      // CC wraps tool results in user messages (content: [{type:"tool_result",...}]).
      // Extract those and emit tool_result events for callers.
      const userContent: any[] = msg.message?.content ?? []
      for (const block of userContent) {
        if (block.type === 'tool_result') {
          const rawContent = block.content
          const content = typeof rawContent === 'string'
            ? rawContent
            : Array.isArray(rawContent)
              ? rawContent.map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('')
              : JSON.stringify(rawContent ?? '')
          yield {
            type: 'tool_result',
            toolUseId: block.tool_use_id ?? '',
            content,
            isError: block.is_error ?? false,
            sessionId,
          }
        }
      }
      break
    }
    case 'result': {
      const durationMs = Date.now() - startMs
      if (msg.subtype === 'success') {
        yield {
          type: 'result',
          subtype: 'success',
          isError: msg.is_error ?? false,
          result: msg.result ?? '',
          sessionId,
          durationMs,
          numTurns: turnCount.value,
          stopReason: msg.stop_reason ?? null,
          totalCostUsd: 0, // filled in after usage accumulation
          usage: { ...totalUsage },
        }
      } else {
        // error_during_execution | error_max_turns | error_max_budget_usd
        const subtype =
          msg.subtype === 'error_max_turns' ? 'error_max_turns' :
          msg.subtype === 'error_max_budget_usd' ? 'error_max_budget' :
          'error_during_execution'
        yield {
          type: 'result',
          subtype,
          isError: true,
          result: (msg.errors ?? []).join('\n') || msg.subtype,
          sessionId,
          durationMs,
          numTurns: turnCount.value,
          stopReason: null,
          totalCostUsd: 0,
          usage: { ...totalUsage },
        }
      }
      break
    }
    case 'system':
    case 'user':
      // Echo messages — skip; caller doesn't need them
      break
    default:
      // rate_limit_event, compaction boundaries, etc. — skip for now
      break
  }
}

// ── KernelBridge ─────────────────────────────────────────────────────────────

export class KernelBridge {
  private cfg: ResolvedConfig
  private tools = new Map<string, MetaAgentTool>()
  private engine: any // QueryEngine instance — typed as any to avoid CC type coupling
  private abortController = new AbortController()
  private totalUsage: TokenUsage = { ...EMPTY_USAGE }
  private cwd: string
  private sessionId: string
  private readonly sessionStartMs = Date.now()
  private _effectiveSystemPrompt: string | undefined
  /**
   * True while submit() is iterating.  Guards _rebuildEngine() so that
   * registerTool() called concurrently with an active submit() doesn't replace
   * the engine under the live generator (Fix #3).  The deferred rebuild fires
   * after the current submit() finishes.
   */
  private _isSubmitting = false
  private _rebuildPending = false

  constructor(config: MetaAgentConfig) {
    this.cfg = resolveConfig(config)
    this.cwd = process.cwd()
    this.sessionId = crypto.randomUUID()
    this._bootstrapEngine()
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private _bootstrapEngine() {
    // Inject API credentials into env — CC's getAnthropicClient() reads these.
    // CLAUDE_CODE_SIMPLE is already set at module load time (bare mode).
    if (this.cfg.apiKey) process.env['ANTHROPIC_API_KEY'] = this.cfg.apiKey
    if (this.cfg.baseURL && this.cfg.baseURL !== 'https://api.anthropic.com') {
      process.env['ANTHROPIC_BASE_URL'] = this.cfg.baseURL
    }

    // Suppress ambient proxy env vars that would be picked up by CC's undici
    // HTTP client during QueryEngine construction.  We drive the Anthropic
    // endpoint directly via ANTHROPIC_BASE_URL so an intermediate proxy only
    // causes connection failures.
    //
    // Save → delete → construct → restore so the deletion is scoped to the
    // narrowest possible window and the host process's proxy configuration for
    // every other HTTP client is preserved (Fix #13).
    const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'] as const
    const savedProxy: Partial<Record<string, string>> = {}
    for (const k of PROXY_KEYS) {
      if (process.env[k] !== undefined) {
        savedProxy[k] = process.env[k]
        delete process.env[k]
      }
    }

    // Bootstrap CC globals (must happen before QueryEngine instantiation)
    setOriginalCwd(this.cwd)
    setProjectRoot(this.cwd)
    // Unlock config subsystem — CC guards config reads until this is called
    enableConfigs()
    // Disable disk persistence — meta-agent manages its own session state
    setSessionPersistenceDisabled(true)

    // Functional AppState store
    const appState = createStore(getDefaultAppState())

    // Permissive canUseTool — allow everything (meta-agent controls tools itself)
    const canUseTool = async () => ({
      behavior: 'allow' as const,
      decisionReason: { type: 'mode' as const, mode: 'default' as const },
    })

    // Minimal file-state cache (required by QueryEngine)
    const readFileCache = createFileStateCacheWithSizeLimit(100)

    const rtx = this.cfg.runtimeContext
    const getCallContext = (): import('../core/types.js').ToolCallContext => ({
      sessionId: this.sessionId,
      agentId: this.sessionId,
      abortSignal: this.abortController.signal,
      ...(rtx ? {
        jobManager: rtx.jobManager,
        vvChain: rtx.vvChain,
        provenanceTracker: rtx.provenanceTracker,
      } : {}),
    })

    const getSnapshotArgs = () => ({
      sessionId: this.sessionId,
      rtx: this.cfg.runtimeContext,
      sessionStartMs: this.sessionStartMs,
    })
    const toolList = [...this.tools.values()].map(t => wrapMetaAgentTool(t, getCallContext, getSnapshotArgs))

    this.engine = new QueryEngine({
      cwd: this.cwd,
      tools: toolList,
      commands: [],
      mcpClients: [],
      agents: [],
      canUseTool,
      getAppState: () => appState.getState(),
      setAppState: (f: any) => appState.setState(f),
      readFileCache,
      customSystemPrompt: this._effectiveSystemPrompt ?? this.cfg.systemPrompt,
      userSpecifiedModel: this.cfg.model,
      maxTurns: this.cfg.maxTurns,
      abortController: this.abortController,
      verbose: false,
    })

    // Restore saved proxy vars so the host process is not permanently affected
    for (const k of PROXY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(savedProxy, k)) {
        process.env[k] = savedProxy[k]
      }
    }
  }

  private _rebuildEngine() {
    if (this._isSubmitting) {
      // Defer until submit() finishes — rebuilding now would swap the engine
      // under the live generator (Fix #3).
      this._rebuildPending = true
      return
    }
    this._rebuildPending = false
    this._bootstrapEngine()
  }

  // ── Public API (mirrors MetaAgentSession) ─────────────────────────────────

  registerTool(tool: MetaAgentTool): void {
    // Instrument if RuntimeContext is configured
    const wrapped = this.cfg.runtimeContext
      ? instrumentTool(tool, this.cfg.runtimeContext, {
          systemPrompt: this.cfg.systemPrompt,
        })
      : tool
    this.tools.set(tool.name, wrapped)
    this._rebuildEngine() // rebuild so new tool list is passed to QueryEngine
  }

  interrupt(): void {
    this.abortController.abort()
    this.abortController = new AbortController()
    // Delete any stale snapshot so the next submit() doesn't backfill with
    // records from the cancelled turn.
    void cleanupStateSnapshot(this.sessionId).catch(() => {})
    // Rebuild engine with fresh abort controller for next submit
    this._rebuildEngine()
  }

  getMessages(): readonly ConversationMessage[] {
    // CC stores messages internally — we surface them as raw ConversationMessages
    const msgs = this.engine.getMessages?.() ?? []
    return msgs as ConversationMessage[]
  }

  getUsage(): TokenUsage {
    return { ...this.totalUsage }
  }

  getEstimatedCost(): number {
    const { inputTokens, outputTokens } = this.totalUsage
    // Model-aware cost lookup (USD per million tokens, as of 2025-04).
    // Returns 0 for unknown models rather than silently overcharging.
    const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
      'claude-opus-4-6':           { input: 15.0,  output: 75.0  },
      'claude-sonnet-4-6':         { input: 3.0,   output: 15.0  },
      'claude-haiku-4-5-20251001': { input: 0.8,   output: 4.0   },
      'deepseek-chat':             { input: 0.27,  output: 1.10  },
      'deepseek-reasoner':         { input: 0.55,  output: 2.19  },
      'qwen-max':                  { input: 0.40,  output: 1.20  },
      'qwen-plus':                 { input: 0.08,  output: 0.26  },
      'qwen-turbo':                { input: 0.02,  output: 0.06  },
      'glm-4':                     { input: 0.10,  output: 0.10  },
      'glm-4-flash':               { input: 0.0,   output: 0.0   },
    }
    const rates = COST_PER_MILLION[this.cfg.model]
    if (!rates) return 0
    return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000
  }

  getSessionId(): string {
    return this.sessionId
  }

  /**
   * Build the enriched system prompt suffix to append before each submit.
   *
   * Includes two blocks:
   *   1. Active campaign context (NEXT_ACTION, Pareto summary, phase)
   *   2. ## Compact Instructions (picked up by CC's auto-compact when it runs)
   *
   * CC's compact prompt explicitly looks for "## Compact Instructions" in the
   * conversation context and follows those instructions — so anything we put
   * here will be preserved in the compact summary without any CC code changes.
   *
   * Never throws — failures are silently swallowed.
   */
  private async _buildEnrichedSuffix(): Promise<string> {
    const parts: string[] = []

    // Part 1: active campaign context (pre-existing behaviour)
    try {
      const campaignContext = await MetaAgentContextStore.buildInjectionBlock()
      if (campaignContext) parts.push(campaignContext)
    } catch { /* swallow */ }

    // Part 2: ## Compact Instructions (instructs CC's compact to preserve
    // provenance IDs, campaign state, and V&V events in its summary).
    // Load the most recent snapshot so that records produced after the LAST
    // call to _buildEnrichedSuffix() are backfilled into the instructions.
    // Pre-fetch provenance records once and pass them in so buildCompactInstructions
    // doesn't make a redundant second list() call (Fix #10).
    try {
      const [snapshot, liveRecords] = await Promise.all([
        loadStateSnapshot(this.sessionId),
        this.cfg.runtimeContext?.provenanceTracker
          .list({ since: this.sessionStartMs })
          .catch(() => undefined),
      ])
      const compactInstructions = await buildCompactInstructions(
        this.cfg.runtimeContext,
        this.sessionId,
        this.sessionStartMs,
        snapshot,
        liveRecords,
      )
      if (compactInstructions) parts.push(compactInstructions)
    } catch { /* swallow */ }

    return parts.join('\n\n')
  }

  async *submit(prompt: string): AsyncGenerator<MetaAgentEvent> {
    const startMs = Date.now()
    const turnCount = { value: 0 }

    // Inject active campaign context + compact instructions into system prompt.
    // QueryEngine reads customSystemPrompt at construction time, so we rebuild
    // the engine with an enriched prompt whenever the suffix changes.
    const suffix = await this._buildEnrichedSuffix()
    const basePrompt = this.cfg.systemPrompt ?? ''
    const enriched = suffix
      ? (basePrompt ? `${basePrompt}\n\n${suffix}` : suffix)
      : basePrompt || undefined
    if (enriched !== this._effectiveSystemPrompt) {
      this._effectiveSystemPrompt = enriched
      this._rebuildEngine()
    }

    this._isSubmitting = true
    try {
      for await (const sdkMsg of this.engine.submitMessage(prompt)) {
        // Accumulate usage from result messages
        if (sdkMsg.type === 'result' && sdkMsg.usage) {
          this.totalUsage = accumulateUsage(this.totalUsage, {
            inputTokens: sdkMsg.usage.input_tokens ?? 0,
            outputTokens: sdkMsg.usage.output_tokens ?? 0,
            cacheCreationInputTokens: sdkMsg.usage.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens: sdkMsg.usage.cache_read_input_tokens ?? 0,
          })
        }
        // Translate and yield events
        for (const event of translateSDKMessage(sdkMsg, this.sessionId, startMs, turnCount, this.totalUsage)) {
          yield event
        }
      }
    } finally {
      this._isSubmitting = false
      // If registerTool() was called while we were submitting, apply the
      // deferred rebuild now that the generator has finished (Fix #3).
      if (this._rebuildPending) {
        this._rebuildEngine()
      }
    }
  }
}
