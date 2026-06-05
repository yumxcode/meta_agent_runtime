/**
 * SessionRouter — unified session entry point with automatic mode routing.
 *
 * Replaces direct use of MetaAgentSession / CampaignSession. Consumers create a
 * SessionRouter, optionally register tools, and call submit() — the router
 * selects the right execution path transparently.
 *
 * Mode selection (in priority order):
 *   1. Caller explicitly sets mode: 'agentic' | 'campaign' | 'robotics'
 *   2. ModeDetector inspects the first prompt + environment (lazy, on submit)
 *   3. registerTool() auto-upgrades to minimum AGENTIC
 *
 * Mode selection is intentionally single-shot:
 *   - Mode is detected once on the FIRST submit() call.
 *   - registerTool() before the first submit() can raise mode to minimum AGENTIC.
 *   - After the backend is initialised, mode is FIXED for the session lifetime.
 *   - There is no mid-session mode upgrade (agentic → campaign mid-conversation).
 *
 * Rationale: backends (MetaAgentSession, CampaignSession, RoboticsSession) maintain
 * internal conversation state.  Transparently rebuilding a backend mid-session
 * would require history migration with no safe guarantee — it is better to start
 * a new session explicitly when mode needs to change.
 *
 * Execution backends:
 *   AGENTIC  → MetaAgentSession (with tools)         — full tool-use loop
 *   CAMPAIGN → CampaignSession  (with tools)         — cc-kernel TS rewrite + auto-compaction
 *   ROBOTICS → RoboticsSession  (with tools)         — ExperienceStore + WorkflowLoader
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
import { resolveConfig, isAnthropicProvider } from '../core/config.js'
import type { ConversationMessage, MetaAgentEvent, MetaAgentTool, TokenUsage } from '../core/types.js'
import { EMPTY_USAGE } from '../core/types.js'
import { MetaAgentSession } from '../core/MetaAgentSession.js'
import { CampaignSession } from '../modes/CampaignSession.js'
import { runPostSessionMemoryWriter } from '../core/memory/memoryWriter.js'
import { getMemoryPendingStore } from '../core/memory/MemoryPendingStore.js'
import { deleteTodosForSession } from '../tools/ui/todo_write/index.js'
import { deleteJobsForSession } from '../tools/system/cronStore.js'
import { ModeDetector } from './ModeDetector.js'
import { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import { clearWebFetchCache } from '../tools/network/web_fetch/index.js'
import { clearAnthropicClientCache } from '../kernel/api/AnthropicClient.js'
import { clearDeepSeekClientCache } from '../kernel/api/DeepSeekClient.js'
import { pruneStaleDebug } from '../kernel/api/DebugWriter.js'
import type { RouterOptions, SessionMode, SessionModeHint } from './types.js'
import { MODE_WEIGHT } from './types.js'

// ── Formal TeamController interface (D2) ─────────────────────────────────────
// Typed contract between SessionRouter and the CLI team commands.
// All methods are optional so the controller can be returned safely before the
// RoboticsSession has fully initialised.

export interface RoboticsTeamController {
  // Lifecycle
  teamInit?(github?: string): Promise<import('../robotics/team/TeamStore.js').TeamState>
  teamJoin?(github?: string, human?: string): Promise<import('../robotics/team/TeamStore.js').TeamState>
  teamStatus?(): Promise<import('../robotics/team/TeamStore.js').TeamState | null>

  // Task mutation (v2.0 collaboration log)
  teamTaskAdd?(input: import('../robotics/team/TeamStore.js').TeamTaskAddInput): Promise<{ state: import('../robotics/team/TeamStore.js').TeamState; task: import('../robotics/team/TeamStore.js').TeamTask }>
  teamTake?(taskId: string): Promise<{ state: import('../robotics/team/TeamStore.js').TeamState; task: import('../robotics/team/TeamStore.js').TeamTask }>
  teamDrop?(taskId?: string): Promise<{ state: import('../robotics/team/TeamStore.js').TeamState; task: import('../robotics/team/TeamStore.js').TeamTask }>
  teamSteal?(taskId: string, reason?: string): Promise<{ state: import('../robotics/team/TeamStore.js').TeamState; task: import('../robotics/team/TeamStore.js').TeamTask; previousOwner?: string }>
  teamNote?(input: import('../robotics/team/TeamStore.js').TeamNoteInput): Promise<{ state: import('../robotics/team/TeamStore.js').TeamState; task: import('../robotics/team/TeamStore.js').TeamTask; attempt: import('../robotics/team/TeamStore.js').TeamAttempt }>
  teamTaskStatus?(taskId: string, status: import('../robotics/team/TeamStore.js').TeamTaskStatus): Promise<{ state: import('../robotics/team/TeamStore.js').TeamState; task: import('../robotics/team/TeamStore.js').TeamTask }>

  // Git transport
  teamSync?(): Promise<import('../robotics/team/TeamStore.js').TeamSyncSummary>
  teamPull?(): Promise<import('../robotics/team/TeamStore.js').TeamPullResult>
  teamConflicts?(): Promise<import('../robotics/team/TeamStore.js').MergeConflictReport>
  teamResolveTeamJson?(): Promise<import('../robotics/team/TeamStore.js').TeamJsonResolveResult>

  // Prompt boundary + watcher
  teamSetContextBoundary?(mode: 'background' | 'unrelated', taskId: string): Promise<void>
  teamWatcherPoll?(): Promise<import('../robotics/team/TeamWatcher.js').TeamWatcherEvent[]>
  teamWatcherEvents?(): import('../robotics/team/TeamWatcher.js').TeamWatcherEvent[]
}

// ── Minimal interface shared by all backends ──────────────────────────────────

interface SessionImpl {
  submit(prompt: string): AsyncGenerator<MetaAgentEvent>
  registerTool(tool: MetaAgentTool): void
  interrupt(): void
  steer?(text: string): boolean
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
  /** Robot/platform name forwarded to RoboticsSession (undefined = no hardware binding). */
  private readonly _robot: string | undefined
  /** Whether user explicitly resumed a prior session — forwarded to RoboticsSession. */
  private readonly _explicitResume: boolean
  private readonly _resumeSessionId?: string
  /** Confirmation callback for multi-agent escalation — forwarded to RoboticsSession. */
  private readonly _onEscalationRequest: ((reason: string) => Promise<boolean>) | undefined
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
  /** Ensures post-session memory extraction runs at most once. */
  private _memoryWriterDone = false

  constructor(config: MetaAgentConfig & RouterOptions = {}) {
    const { mode, debugMode, robot, explicitResume, resumeSessionId, onEscalationRequest, ...sessionConfig } = config
    this._hint = mode ?? 'auto'
    this._debug = debugMode ?? false
    this._robot = robot
    this._explicitResume = explicitResume ?? false
    this._resumeSessionId = resumeSessionId
    this._onEscalationRequest = onEscalationRequest
    // Re-inject debugMode so resolveConfig() passes it down to MetaAgentSession.
    // Without this, destructuring above strips debugMode from sessionConfig,
    // making this.config.debugMode always undefined inside MetaAgentSession.
    this._cfg = resolveConfig({ ...sessionConfig, debugMode })

    // If tools are supplied in config, note them as pending so the impl picks
    // them up when it's created. registerTool() handles any added later.
    this._pendingTools = [...(config.tools ?? [])]

    // Detection client: only create when (a) an API key is available AND (b)
    // the provider is Anthropic.  Third-party providers (DeepSeek, Qwen, custom
    // proxies) do not expose claude-haiku-4-5-20251001 (the Anthropic flash model),
    // so sending the flash model side-call there would fail with a 404/400.
    // The detector falls back to regex heuristics automatically when this client
    // is null (Task #22 fix).
    // Fail-fast: 3 s timeout, 1 retry so a slow API never stalls session start.
    this._detectionClient = (this._cfg.apiKey && isAnthropicProvider(this._cfg.baseURL))
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

  /**
   * Return the lightweight Anthropic client used for side-calls (mode detection,
   * experience summaries, etc.).  This client is short-timeout (3 s) and always
   * targets the configured provider's API — it is intentionally separate from the
   * main session client so side-calls never pollute conversation history.
   *
   * Returns null when no API key is available or the provider is non-Anthropic
   * (third-party proxies don't expose claude-haiku-4-5-20251001, the Anthropic flash model).
   *
   * Callers that need a side-call model should use resolvedConfig.flashModel
   * (cheap + low-latency, provider-agnostic) — callers are responsible for choosing the model string.
   */
  getSideCallClient(): Anthropic | null {
    return this._detectionClient
  }

  /**
   * Return a minimal config snapshot needed for constructing a side-call client
   * when getSideCallClient() returns null (e.g. non-Anthropic provider that still
   * supports the messages API).  Exposes apiKey, baseURL, and resolved model.
   */
  getProviderConfig(): { apiKey: string | undefined; baseURL: string | undefined; model: string; flashModel: string } {
    return {
      apiKey:     this._cfg.apiKey,
      baseURL:    this._cfg.baseURL,
      model:      this._cfg.model,
      flashModel: this._cfg.flashModel,
    }
  }

  /** True once the backend impl has been created. */
  get ready(): boolean {
    return this._impl !== null
  }

  /** Initialise the selected backend without submitting a user prompt. */
  async ensureReady(prompt = 'initialize session for CLI command'): Promise<void> {
    await this._ensureImpl(prompt)
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
   * Register a tool. Auto-upgrades mode to minimum AGENTIC.
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

  /**
   * Inject a mid-turn user correction ("steering") into the running turn.
   * The correction is appended as a user message at the next loop boundary; the
   * model is NOT interrupted. Returns true if accepted (a turn is in flight and
   * the backend supports steering), false otherwise — in which case the caller
   * should fall back to submit() as a fresh message.
   */
  steer(text: string): boolean {
    return this._impl?.steer?.(text) ?? false
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

  /**
   * Run mode detection for `prompt` without initialising the backend.
   * Returns the resolved SessionMode.
   *
   * Idempotent: once mode is fixed after the first submit(), subsequent calls
   * return immediately.  Intended for CLI callers that need to know mode
   * BEFORE streaming the first response — e.g. to prompt for a hardware
   * profile in robotics mode so the first AI turn already has hardware context.
   */
  async primeMode(prompt: string): Promise<SessionMode> {
    if (this._currentMode !== null) return this._currentMode
    const hasTools = this._pendingTools.length > 0
    const result = await ModeDetector.detect(
      prompt,
      this._hint,
      hasTools,
      this._detectionClient ?? undefined,
      this._cfg.flashModel,
    )
    this._raiseMode(result.mode)
    return this._currentMode!
  }

  /**
   * Gracefully dispose the active backend (if any).
   *
   * Called by signal handlers in the CLI so heartbeat timers, sandbox handles,
   * sub-agent runners, and git worktrees are cleaned up on SIGTERM /
   * uncaughtException without relying on GC.
   */
  async dispose(): Promise<void> {
    const impl = this._impl as (SessionImpl & { dispose?: () => Promise<void> }) | null
    if (impl && !this._memoryWriterDone) {
      this._memoryWriterDone = true
      try {
        await runPostSessionMemoryWriter({
          client: this._detectionClient,
          mode: this._currentMode ?? 'agentic',
          domain: this._cfg.domain,
          messages: impl.getMessages(),
          // Thread the configured flashModel so pure-Anthropic setups don't
          // silently skip memory writing because of a missing DeepSeek key.
          model: this._cfg.flashModel,
          apiKey: this._cfg.apiKey,
          baseURL: this._cfg.baseURL,
        })
        // Drain the pending-memory persistence tail so auto-queued proposals
        // survive shutdown and are visible to the next `/memory review`.
        try { await getMemoryPendingStore().flush() } catch { /* best-effort */ }
      } catch {
        // Best-effort: memory extraction must never block shutdown.
      }
    }
    if (impl?.dispose) {
      try { await impl.dispose() } catch { /* best-effort */ }
    }
    const sessionId = impl?.getSessionId()
    if (sessionId) {
      try { deleteTodosForSession(sessionId) } catch { /* best-effort */ }
      try { deleteJobsForSession(sessionId) } catch { /* best-effort */ }
      // S6: kill any SubAgentBridge that was created for this session but
      // whose owner forgot to call destroy() (e.g. CampaignSession callers
      // who never dispose).  Idempotent — does nothing when already destroyed.
      try { await SubAgentBridge.getBridge(sessionId)?.dispose() } catch { /* best-effort */ }
    }
    // Drop the impl reference so the GC can reclaim the whole session graph.
    this._impl = null
    this._pendingTools = []
    this._currentMode = null
    // S10: scrub module-level caches that were populated during this session.
    // These are static singletons so we only clear (rather than per-session
    // partition) — for hosts running multiple SessionRouters concurrently the
    // caches will simply re-warm on the next call.
    try { clearWebFetchCache() } catch { /* best-effort */ }
    try { clearAnthropicClientCache() } catch { /* best-effort */ }
    try { clearDeepSeekClientCache() } catch { /* best-effort */ }
    // S4: best-effort debug log purge.  Quick (one readdir over the global
    // debug dir) and only deletes age- or size-eligible files.
    void pruneStaleDebug().catch(() => undefined)
  }

  /**
   * Return the robotics session's pending experience buffer (if mode=robotics).
   * Returns null in all other modes or before the first submit().
   * Uses duck-typing so SessionRouter does not import RoboticsSession directly.
   */
  getPendingExperiences(): import('../robotics/ExperiencePendingStore.js').ExperiencePendingStore | null {
    const impl = this._impl as any
    if (impl && typeof impl.pendingExperiences === 'object' && impl.pendingExperiences !== null) {
      return impl.pendingExperiences
    }
    return null
  }

  /**
   * Return the robotics session's pending physical anchor buffer (if mode=robotics).
   * Returns null in all other modes or before the first submit().
   * Uses duck-typing so SessionRouter does not import RoboticsSession directly.
   */
  getPendingPhysicalAnchors(): import('../robotics/PhysicalAnchorPendingStore.js').PhysicalAnchorPendingStore | null {
    const impl = this._impl as any
    if (impl && typeof impl.pendingPhysicalAnchors === 'object' && impl.pendingPhysicalAnchors !== null) {
      return impl.pendingPhysicalAnchors
    }
    return null
  }

  /**
   * Return the robotics session's pending principle buffer (if mode=robotics).
   * Returns null in all other modes or before the first submit().
   */
  getPendingPrinciples(): import('../robotics/PrinciplePendingStore.js').PrinciplePendingStore | null {
    const impl = this._impl as any
    if (impl && typeof impl.pendingPrinciples === 'object' && impl.pendingPrinciples !== null) {
      return impl.pendingPrinciples
    }
    return null
  }

  async proposePrincipleForExperience(
    experienceId: string,
    reason: 'confidence_threshold' | 'explicit_user_request',
  ): Promise<unknown | null> {
    const impl = this._impl as any
    if (impl && typeof impl.proposePrincipleForExperience === 'function') {
      return impl.proposePrincipleForExperience(experienceId, reason)
    }
    return null
  }

  getRoboticsTeamController(): RoboticsTeamController | null {
    if (this._currentMode !== 'robotics') return null
    const impl = this._impl as RoboticsTeamController | undefined
    return impl ?? null
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /**
   * Lazily initialise the backend on the first submit().
   * Mode is detected once here and fixed for the session lifetime.
   * Subsequent submit() calls skip this entirely (_impl is already set).
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
      this._cfg.flashModel,
    )

    // Apply the detected mode (respecting any prior raise from registerTool)
    this._raiseMode(result.mode)

    if (this._debug) {
      console.error(
        `[SessionRouter] mode=${this._currentMode} confidence=${result.confidence} ` +
        `signals=[${result.signals.map(s => s.label).join('; ')}]`,
      )
    }

    // Create the backend (async for lazy-loaded backends like RoboticsSession)
    this._impl = await this._createImpl(this._currentMode!)

    // Forward any tools that were registered before impl was created
    for (const tool of this._pendingTools) {
      this._impl.registerTool(tool)
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
   *   AGENTIC  → MetaAgentSession with registered tools and full loop.
   *
   *   CAMPAIGN → CampaignSession — uses the cc-kernel TypeScript rewrite
   *               which provides auto-compaction (essential for long-running
   *               campaigns that exhaust the context window).
   *
   *   ROBOTICS → RoboticsSession — wires ExperienceStore, GitWorkspaceManager,
   *               WorkflowLoader, and multi-agent orchestration for robot
   *               algorithm development. Imported lazily to avoid circular
   *               deps during bootstrap.
   */
  private async _createImpl(mode: SessionMode): Promise<SessionImpl> {
    switch (mode) {
      case 'agentic': {
        return new MetaAgentSession({
          ...this._cfgAsConfig(),
          sessionId: this._resumeSessionId,
        })
      }

      case 'campaign': {
        return new CampaignSession({
          ...this._cfgAsConfig(),
          sessionId: this._resumeSessionId,
        })
      }

      case 'robotics': {
        // RoboticsSession wires ExperienceStore, GitWorkspaceManager, WorkflowLoader etc.
        // Imported lazily to avoid circular deps during bootstrap.
        const { RoboticsSession } = await import('../robotics/RoboticsSession.js')
        const roboticsSession = new RoboticsSession({
          ...this._cfgAsConfig(),
          robot: this._robot,
          explicitResume: this._explicitResume,
          resumeSessionId: this._resumeSessionId,
          onEscalationRequest: this._onEscalationRequest,
        })
        // init() restores or creates project state, registers tools, and primes
        // R1-R5 dynamic sections.  Must complete before first submit().
        await roboticsSession.init()
        return roboticsSession
      }
    }
  }

  /**
   * Convert the resolved internal config back into the shape accepted by
   * MetaAgentSession / CampaignSession constructors. We spread the full resolved
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
