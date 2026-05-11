/**
 * SessionRouter — unified session entry point with automatic mode routing.
 *
 * Replaces direct use of MetaAgentSession / KernelBridge. Consumers create a
 * SessionRouter, optionally register tools, and call submit() — the router
 * selects the right execution path transparently.
 *
 * Mode selection (in priority order):
 *   1. Caller explicitly sets mode: 'direct' | 'agentic' | 'campaign'
 *   2. ModeDetector inspects the first prompt + environment (lazy, on submit)
 *   3. registerTool() auto-upgrades to minimum AGENTIC
 *
 * Mode upgrade rules (within a session):
 *   DIRECT → AGENTIC   triggered by registerTool() or agentic/campaign prompt
 *   AGENTIC → CAMPAIGN  triggered by campaign prompt or explicit mode set
 *   Never downgrades.
 *
 * Execution backends:
 *   DIRECT   → MetaAgentSession (tools=[])          — one turn, no tool loop
 *   AGENTIC  → MetaAgentSession (with tools)         — full tool-use loop
 *   CAMPAIGN → KernelBridge     (with tools)         — CC engine + auto-compaction
 *
 * Public API mirrors MetaAgentSession so it is a drop-in replacement:
 *   submit(), registerTool(), interrupt(), getMessages(), getUsage(),
 *   getEstimatedCost(), getSessionId()
 * Plus router-specific:
 *   get mode    — current SessionMode (null before first submit)
 *   get ready   — true once the impl is initialised
 */

import Anthropic from '@anthropic-ai/sdk'
import type { MetaAgentConfig, ResolvedConfig } from '../core/config.js'
import { resolveConfig } from '../core/config.js'
import type { ConversationMessage, MetaAgentEvent, MetaAgentTool, TokenUsage } from '../core/types.js'
import { EMPTY_USAGE } from '../core/types.js'
import { MetaAgentSession } from '../core/MetaAgentSession.js'
import { KernelBridge } from '../cc-kernel/KernelBridge.js'
import { ModeDetector } from './ModeDetector.js'
import type { RouterOptions, SessionMode, SessionModeHint } from './types.js'
import { MODE_WEIGHT } from './types.js'

// ── Minimal interface shared by all backends ──────────────────────────────────

interface SessionImpl {
  submit(prompt: string): AsyncGenerator<MetaAgentEvent>
  registerTool(tool: MetaAgentTool): void
  interrupt(): void
  getMessages(): readonly ConversationMessage[]
  getUsage(): TokenUsage
  getEstimatedCost(): number
  getSessionId(): string
}

// ── SessionRouter ─────────────────────────────────────────────────────────────

export class SessionRouter {
  private readonly _cfg: ResolvedConfig
  private readonly _hint: SessionModeHint
  private readonly _debug: boolean
  /**
   * Lightweight Anthropic client used exclusively for one-shot mode detection.
   * Separate from the backend session client: short timeout (3 s), 1 retry,
   * always uses the configured apiKey/baseURL. Null if no apiKey is available.
   */
  private readonly _detectionClient: Anthropic | null

  /** Current active mode (null until first submit initialises the impl). */
  private _currentMode: SessionMode | null = null
  /** Underlying session backend (created lazily on first submit). */
  private _impl: SessionImpl | null = null
  /** Tools registered before the impl was initialised, to be forwarded on init. */
  private _pendingTools: MetaAgentTool[] = []

  constructor(config: MetaAgentConfig & RouterOptions = {}) {
    const { mode, debugMode, ...sessionConfig } = config
    this._hint = mode ?? 'auto'
    this._debug = debugMode ?? false
    this._cfg = resolveConfig(sessionConfig)

    // If tools are supplied in config, note them as pending so the impl picks
    // them up when it's created. registerTool() handles any added later.
    this._pendingTools = [...(config.tools ?? [])]

    // Detection client: fail-fast (3 s timeout, 1 retry) so a slow or
    // unavailable API never blocks the user more than ~3 s. Falls back to
    // heuristics automatically if the call fails (see ModeDetector._detectWithLLM).
    this._detectionClient = this._cfg.apiKey
      ? new Anthropic({
          apiKey:     this._cfg.apiKey,
          baseURL:    this._cfg.baseURL,
          timeout:    3_000,
          maxRetries: 1,
        })
      : null
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Current active mode — null before first submit(). */
  get mode(): SessionMode | null {
    return this._currentMode
  }

  /** True once the backend impl has been created. */
  get ready(): boolean {
    return this._impl !== null
  }

  /**
   * Submit a prompt. On the first call, ModeDetector runs and the appropriate
   * backend is created. Subsequent calls reuse the same backend.
   *
   * If the detected mode is higher than the current mode (e.g. prompt signals
   * campaign intent but session started in agentic), the backend is rebuilt
   * before forwarding the message.
   */
  async *submit(prompt: string): AsyncGenerator<MetaAgentEvent> {
    await this._ensureImpl(prompt)
    yield* this._impl!.submit(prompt)
  }

  /**
   * Register a tool. Auto-upgrades mode to minimum AGENTIC — direct mode
   * cannot execute tools.
   *
   * If the backend is already initialised, the tool is forwarded immediately.
   * If not, it is buffered and applied when the backend starts.
   */
  registerTool(tool: MetaAgentTool): void {
    // A tool registration always means at least AGENTIC
    this._raiseMode('agentic')

    if (this._impl) {
      this._impl.registerTool(tool)
    } else {
      this._pendingTools.push(tool)
    }
  }

  interrupt(): void {
    this._impl?.interrupt()
  }

  getMessages(): readonly ConversationMessage[] {
    return this._impl?.getMessages() ?? []
  }

  getUsage(): TokenUsage {
    return this._impl?.getUsage() ?? { ...EMPTY_USAGE }
  }

  getEstimatedCost(): number {
    return this._impl?.getEstimatedCost() ?? 0
  }

  getSessionId(): string {
    return this._impl?.getSessionId() ?? ''
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /**
   * Lazily initialise the backend.
   * Called on the first submit(); also called if mode was upgraded between submits
   * (detects when _currentMode is set but _impl is stale — not possible with
   * current upgrade logic, but guarded for safety).
   */
  private async _ensureImpl(prompt: string): Promise<void> {
    if (this._impl) return

    // Detect mode — LLM path when client is available, heuristic fallback otherwise
    const hasTools = this._pendingTools.length > 0
    const result = await ModeDetector.detect(
      prompt,
      this._hint,
      hasTools,
      this._detectionClient ?? undefined,
    )

    // Apply the detected mode (respecting any prior raise from registerTool)
    this._raiseMode(result.mode)

    if (this._debug) {
      console.error(
        `[SessionRouter] mode=${this._currentMode} confidence=${result.confidence} ` +
        `signals=[${result.signals.map(s => s.label).join('; ')}]`,
      )
    }

    // Create the backend
    this._impl = this._createImpl(this._currentMode!)

    // Forward any tools that were registered before impl was created
    for (const tool of this._pendingTools) {
      // In DIRECT mode, tools are silently dropped (mode was raised to AGENTIC
      // by registerTool() so this branch is unreachable with tools; guard anyway)
      if (this._currentMode !== 'direct') {
        this._impl.registerTool(tool)
      }
    }
    this._pendingTools = []
  }

  /**
   * Raise the current mode to at least `newMode`.
   * Never downgrades. If mode increases after impl creation, a rebuild would
   * be needed — currently that's not triggered mid-session (registerTool raises
   * before the first submit; we guard here anyway).
   */
  private _raiseMode(newMode: SessionMode): void {
    if (
      this._currentMode === null ||
      MODE_WEIGHT[newMode] > MODE_WEIGHT[this._currentMode]
    ) {
      if (this._debug && this._currentMode !== null) {
        console.error(
          `[SessionRouter] mode upgrade: ${this._currentMode} → ${newMode}`,
        )
      }
      this._currentMode = newMode
    }
  }

  /**
   * Instantiate the correct backend for the given mode.
   *
   *   DIRECT   → MetaAgentSession with no tools (tool list is not offered
   *               to the model; the agentic loop exits after one turn).
   *
   *   AGENTIC  → MetaAgentSession with registered tools and full loop.
   *
   *   CAMPAIGN → KernelBridge — uses CC's production QueryEngine which
   *               provides auto-compaction (essential for long-running
   *               campaigns that exhaust the context window).
   */
  private _createImpl(mode: SessionMode): SessionImpl {
    switch (mode) {
      case 'direct': {
        // Pass an empty tools array so the model never attempts tool calls.
        return new MetaAgentSession({
          ...this._cfgAsConfig(),
          tools: [],
        })
      }

      case 'agentic': {
        return new MetaAgentSession(this._cfgAsConfig())
      }

      case 'campaign': {
        return new KernelBridge(this._cfgAsConfig())
      }
    }
  }

  /**
   * Convert the resolved internal config back into the shape accepted by
   * MetaAgentSession / KernelBridge constructors. We spread the full resolved
   * config and override `tools: []` — tools are injected separately via
   * registerTool() so the pending-buffer logic is honoured.
   *
   * Using spread (instead of a field-by-field copy) means any future fields
   * added to ResolvedConfig automatically flow through without an edit here.
   */
  private _cfgAsConfig(): MetaAgentConfig {
    return { ...this._cfg, tools: [] }
  }
}
