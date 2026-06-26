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
import type { AutonomyProfile, ConversationMessage, MetaAgentEvent, MetaAgentTool, TokenUsage } from '../core/types.js'
import { EMPTY_USAGE } from '../core/types.js'
import { MetaAgentSession } from '../core/MetaAgentSession.js'
import { CampaignSession } from '../modes/CampaignSession.js'
import { runPostSessionMemoryWriter } from '../core/memory/memoryWriter.js'
import { prefetchRelevantMemories, getMemoryRecallTimeoutMs } from '../core/memory/findRelevantMemories.js'
import { getMemoryPendingStore } from '../core/memory/MemoryPendingStore.js'
import { deleteJobsForSession } from '../tools/system/cronStore.js'
import { ModeDetector } from './ModeDetector.js'
import { readAutoCheckpoint, writeAutoCheckpoint, buildAutoResumePreamble, AUTO_CHECKPOINT_SCHEMA_VERSION } from '../core/auto/AutoCheckpointStore.js'
import { AutoCheckpointCoordinator } from '../core/auto/AutoCheckpointCoordinator.js'
import { deleteTodosForSession } from '../tools/ui/todo_write/index.js'
import { deleteProgressNoteForSession } from '../tools/ui/progress_note/index.js'
import { deleteArtifactsForSession } from '../tools/ui/artifacts_register/index.js'
import { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import { createAgenticBackend } from './AgenticBackendFactory.js'
import { clearWebFetchCache } from '../tools/network/web_fetch/index.js'
import { clearAnthropicClientCache } from '../kernel/api/AnthropicClient.js'
import { clearDeepSeekClientCache } from '../kernel/api/DeepSeekClient.js'
import { pruneStaleDebug } from '../kernel/api/DebugWriter.js'
import type { RouterOptions, SessionMode, SessionModeHint } from './types.js'
import { MODE_WEIGHT } from './types.js'
import { MODE_PROFILES } from '../core/modes.js'

// The robotics capability contracts live in the robotics package (so
// RoboticsSession can `implements` them and the compiler verifies the surface).
// Imported for internal use here and re-exported for backward compatibility —
// cli/teamPlannerExecutor imports RoboticsTeamController from this module.
import type { RoboticsCapabilities, RoboticsTeamController } from '../robotics/contracts.js'
export type { RoboticsCapabilities, RoboticsTeamController }

// ── Minimal interface shared by all backends ──────────────────────────────────

interface SessionImpl {
  submit(prompt: string): AsyncGenerator<MetaAgentEvent>
  registerTool(tool: MetaAgentTool): void
  interrupt(): void
  steer?(text: string): boolean
  reanchorOriginalGoal?(goal: string): void
  compactNow?(): Promise<import('../kernel/index.js').ManualCompactResult>
  getMessages(): readonly ConversationMessage[]
  getUsage(): TokenUsage
  getEstimatedCost(): number
  getSessionId(): string
}

// ── SessionRouter ─────────────────────────────────────────────────────────────

/** Short continuation markers — a prompt asking to keep going, not a new goal. */
const AUTO_CONTINUATION_MARKERS = [
  '继续', '接着', '继续推进', '继续完成', '接着做', '接着干',
  'continue', 'go on', 'keep going', 'carry on', 'proceed', 'resume',
]

/**
 * Whether an auto-mode prompt is a "continue the current run" signal rather than
 * a NEW goal. Empty input, or a short prompt that is exactly / starts with a
 * continuation marker, counts as continuation. Anything longer is treated as a
 * real new requirement so it becomes the goal.
 */
export function isAutoContinuationPrompt(prompt: string): boolean {
  const p = prompt.trim().toLowerCase()
  if (p === '') return true
  if (p.length > 24) return false
  return AUTO_CONTINUATION_MARKERS.some(m => p === m || p.startsWith(m))
}

export class SessionRouter {
  private readonly _cfg: ResolvedConfig
  private readonly _hint: SessionModeHint
  private readonly _debug: boolean
  /** P0-1: lazy side-call client used only by the memory-recall prefetch. */
  private readonly _recallClient: Anthropic | null = null
  /** Robot/platform name forwarded to RoboticsSession (undefined = no hardware binding). */
  private readonly _robot: string | undefined
  /** Whether user explicitly resumed a prior session — forwarded to RoboticsSession. */
  private readonly _explicitResume: boolean
  private readonly _resumeSessionId?: string
  /** Confirmation callback for multi-agent escalation — forwarded to RoboticsSession. */
  private readonly _onEscalationRequest: ((reason: string) => Promise<boolean>) | undefined
  /**
   * Lightweight Anthropic client used exclusively for one-shot mode detection.
   * Separate from the backend session client: 30 s timeout, 1 retry, always
   * uses the configured apiKey/baseURL. Null if no apiKey is available (or the
   * provider isn't Anthropic-protocol — see the construction site below).
   */
  private readonly _detectionClient: Anthropic | null

  /**
   * Shared plan-mode flag. ONE object drives both (a) the enter_plan_mode /
   * exit_plan_mode tools the CLI registers and (b) the kernel permission gate
   * inside whichever backend is built later. Exposed via `planModeRef` so the
   * CLI can hand this exact object to createStandardTools({ system }), and
   * injected into every backend via _cfgAsConfig() so the backend adopts it
   * instead of minting its own — without this single source, the tools flipped
   * a private ref the permission policy never read, and plan mode never gated.
   */
  private readonly _planModeRef: { active: boolean } = { active: false }

  /** Current active mode (null until first submit initialises the impl). */
  private _currentMode: SessionMode | null = null
  /** Underlying session backend (created lazily on first submit). */
  private _impl: SessionImpl | null = null
  /** Tools registered before the impl was initialised, to be forwarded on init. */
  private _pendingTools: MetaAgentTool[] = []
  /** Ensures post-session memory extraction runs at most once. */
  private _memoryWriterDone = false

  /** Auto mode: the first prompt, captured once as the durable goal anchor. */
  private _autoGoal: string | null = null
  /** Auto mode: sub-agent bridge ref, for checkpointing active sub-agent IDs. */
  private _autoBridge: SubAgentBridge | null = null
  /** Auto mode: single-writer durable checkpoint coordinator. */
  private _autoCheckpointCoordinator: AutoCheckpointCoordinator | null = null

  constructor(config: MetaAgentConfig & RouterOptions = {}) {
    const { mode, debugMode, robot, explicitResume, resumeSessionId, onEscalationRequest, ...sessionConfig } = config
    // Default hint is 'detect' (run ModeDetector). 'auto' is now a real mode.
    this._hint = mode ?? 'detect'
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
    // Flash side-call timeout: 30 s, 1 retry. Slow providers such as GLM may
    // take 15-30 s to complete, but still fall back safely on timeout.
    this._detectionClient = (this._cfg.apiKey && isAnthropicProvider(this._cfg.baseURL))
      ? new Anthropic({
          apiKey:     this._cfg.apiKey,
          baseURL:    this._cfg.baseURL,
          timeout:    30_000,
          maxRetries: 1,
        })
      : null

    // P0-1: dedicated client for the memory-recall prefetch. Mirrors the
    // condition under which MetaAgentSession's D1b section gets a client
    // (protocol === 'anthropic'), so the prefetch compatibility check matches.
    // SDK timeout tracks the recall timeout (env-tunable for slow providers)
    // instead of the detection client's hard 3 s.
    this._recallClient = (this._cfg.apiKey && this._cfg.protocol === 'anthropic')
      ? new Anthropic({
          apiKey:     this._cfg.apiKey,
          baseURL:    this._cfg.baseURL,
          timeout:    getMemoryRecallTimeoutMs() + 2_000,
          maxRetries: 0,
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
   * experience summaries, etc.).  This client uses the shared flash side-call
   * timeout (30 s) and always
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
    // P0-1: start the per-query memory recall NOW so it overlaps mode
    // detection and backend initialisation instead of running serially after
    // them. Single-flight + consume-once + compatibility-checked inside
    // findRelevantMemories — when anything mismatches, the prompt build simply
    // recomputes fresh, so correctness never depends on this call.
    prefetchRelevantMemories({
      query:       prompt,
      client:      this._recallClient ?? undefined,
      sessionMode: this._currentMode ?? undefined,
      domainScope: this._cfg.domain,
      flashModel:  this._cfg.flashModel,
    })
    await this._ensureImpl(prompt)

    // Auto mode, first turn: remember the durable goal anchor, and — when this is
    // an explicit --resume — re-inject the prior checkpoint (goal / done /
    // pending / artifacts / in-flight sub-agents) into the model's context so the
    // resumed run continues instead of restarting. The CLI banner is shown only
    // to the human; this preamble is what the model actually sees.
    let effectivePrompt = prompt
    if (this._currentMode === 'auto') {
      const isFirstTurn = this._autoGoal === null
      const isContinuation = isAutoContinuationPrompt(prompt)

      if (isFirstTurn && this._explicitResume && isContinuation) {
        // Resumed to CONTINUE: the user gave no new requirement (empty or a
        // "继续"/"continue"-type prompt), so keep the prior goal and re-inject the
        // progress snapshot so the run picks up where it stopped.
        const cp = readAutoCheckpoint(this._cfg.projectDir ?? process.cwd())
        const preamble = buildAutoResumePreamble(cp)
        if (preamble) {
          effectivePrompt = `${preamble}\n\n[本次用户输入]\n${prompt}`
          this._autoGoal = cp?.goal ?? null
        }
        if (this._autoGoal === null) this._autoGoal = prompt
      } else if (isFirstTurn) {
        // Fresh session OR resumed-with-a-NEW-requirement: the user's input is
        // the goal — NOT the old checkpoint's. On resume we additionally clear
        // the prior run's durable state (todos + checkpoint) so verify/drift
        // judge THIS goal cleanly; the prior conversation is already preloaded
        // for context, so we deliberately skip the "continue the old goal"
        // preamble that would otherwise mis-anchor the gates.
        if (this._explicitResume) {
          await this._reanchorAutoGoal(prompt)
        } else {
          this._autoGoal = prompt
        }
      } else if (!isContinuation) {
        // NEW task in an already-running session. One submit() drives the auto
        // KernelLoop to terminal before control returns here, so a fresh prompt
        // is a NEW goal — re-anchor it. Without this, the verify and drift gates
        // (which read the goal lazily via getGoal) keep judging against the
        // FIRST task's goal. We also clear the run-scoped state they consult so
        // the new task does not inherit the previous one's progress record.
        await this._reanchorAutoGoal(prompt)
      }
      // else: an in-session "继续"/"continue" prompt — keep the current goal and
      // run state untouched so the model carries on the same task.
    }

    for await (const ev of this._impl!.submit(effectivePrompt)) {
      yield ev
    }
  }

  /**
   * Re-anchor the auto-mode goal to a new top-level task and clear the
   * run-scoped state that the verify/drift gates and checkpoint snapshot read,
   * so a second task in the same session is judged on its own terms:
   *   • _autoGoal      — the lazily-read goal the gates judge against.
   *   • session todos  — the AutoCheckpoint snapshot is built from them; stale
   *                      "completed" steps would otherwise leak into the new run.
   *   • progress/artifacts — volatile user-facing state; stale notes or
   *                      artifacts would otherwise be snapshotted into the new goal.
   *   • durable checkpoint — drift reads done/pending from disk; overwrite it
   *                      immediately so a gate that fires before the new run's
   *                      first flush sees the NEW goal with an empty record.
   */
  private async _reanchorAutoGoal(prompt: string): Promise<void> {
    this._autoGoal = prompt
    this._impl?.reanchorOriginalGoal?.(prompt)
    const sessionId = this.getSessionId()
    try { deleteTodosForSession(sessionId) } catch { /* best-effort */ }
    try { deleteProgressNoteForSession(sessionId) } catch { /* best-effort */ }
    try { deleteArtifactsForSession(sessionId) } catch { /* best-effort */ }
    // Clear the coordinator's in-memory run-scoped state (run-health counters, FS
    // digest streak, pending digest) so the prior task's signals are not written
    // back into the new goal's checkpoint on the next flush.
    this._autoCheckpointCoordinator?.resetRunScopedState()
    // Hard reset (not a merge): a fresh checkpoint with empty completedSteps /
    // pendingTodos so drift never compares the NEW goal against the prior task's
    // progress. updateAutoCheckpoint would union the old steps back in, so we
    // overwrite the whole record here.
    //
    // CRITICAL: keep the revision MONOTONIC (use the coordinator's current value,
    // not 0). Zeroing it desyncs from KernelSession's persisted checkpointRevision
    // — the next flush would write rev 1, Math.max(oldLarge, 1) stays oldLarge,
    // so drift's checkpointAdvanced gate stays false for ~oldLarge checkpoints
    // (drift starvation on the new task).
    await writeAutoCheckpoint(this._cfg.projectDir ?? process.cwd(), {
      schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
      sessionId,
      updatedAt: Date.now(),
      revision: this._autoCheckpointCoordinator?.latestRevision ?? 0,
      goal: prompt,
    })
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

  /**
   * Manual compaction (/compact) — forwards to the backend. Returns a
   * not-compacted result when no backend exists yet (nothing to compact).
   */
  async compactNow(): Promise<import('../kernel/index.js').ManualCompactResult> {
    if (!this._impl?.compactNow) {
      return { compacted: false, reason: '会话尚未开始，没有可压缩的上下文。' }
    }
    return this._impl.compactNow()
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
    // Global memory is read-only in auto mode. Skip both the post-session
    // proposal writer and the pending-store flush so an unattended session
    // never causes writes under ~/.meta-agent/memory.
    if (impl && this._currentMode !== 'auto' && !this._memoryWriterDone) {
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
    // Durable isolated-write worktrees intentionally survive dispose so a
    // resumed session can finalize/merge/conflict-recover them.
    if (impl && this._currentMode === 'auto') {
      try {
        await this._autoCheckpointCoordinator?.flushDispose(impl.getSessionId())
      } catch { /* best-effort */ }
    }
    this._autoBridge = null
    this._autoCheckpointCoordinator = null
    if (impl?.dispose) {
      try { await impl.dispose() } catch { /* best-effort */ }
    }
    const sessionId = impl?.getSessionId()
    if (sessionId) {
      try { deleteTodosForSession(sessionId) } catch { /* best-effort */ }
      try { deleteJobsForSession(sessionId) } catch { /* best-effort */ }
      try { deleteProgressNoteForSession(sessionId) } catch { /* best-effort */ }
      try { deleteArtifactsForSession(sessionId) } catch { /* best-effort */ }
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
   * Narrow the active backend to the robotics capability surface, or null when
   * the session is not in robotics mode (or no backend yet).
   *
   * ONE typed cast, guarded by mode, replaces the former per-accessor `as any`.
   * Because `RoboticsSession implements RoboticsCapabilities`, the cast is
   * compile-checked at the implementation site: removing/renaming a capability
   * now fails the build instead of silently returning `undefined` at runtime.
   */
  private _roboticsImpl(): RoboticsCapabilities | null {
    return this._currentMode === 'robotics' && this._impl
      ? (this._impl as unknown as RoboticsCapabilities)
      : null
  }

  /**
   * Return the robotics session's pending experience buffer (if mode=robotics).
   * Returns null in all other modes or before the first submit().
   */
  getPendingExperiences(): import('../robotics/ExperiencePendingStore.js').ExperiencePendingStore | null {
    return this._roboticsImpl()?.pendingExperiences ?? null
  }

  /**
   * Return the robotics session's pending physical anchor buffer (if mode=robotics).
   * Returns null in all other modes or before the first submit().
   */
  getPendingPhysicalAnchors(): import('../robotics/PhysicalAnchorPendingStore.js').PhysicalAnchorPendingStore | null {
    return this._roboticsImpl()?.pendingPhysicalAnchors ?? null
  }

  /**
   * Return the robotics session's pending principle buffer (if mode=robotics).
   * Returns null in all other modes or before the first submit().
   */
  getPendingPrinciples(): import('../robotics/PrinciplePendingStore.js').PrinciplePendingStore | null {
    return this._roboticsImpl()?.pendingPrinciples ?? null
  }

  async proposePrincipleForExperience(
    experienceId: string,
    reason: 'confidence_threshold' | 'explicit_user_request',
  ): Promise<unknown | null> {
    return this._roboticsImpl()?.proposePrincipleForExperience(experienceId, reason) ?? null
  }

  async reinforcePrinciplesFromExperience(
    experienceId: string,
  ): Promise<Array<{ principleId: string; signal: 'observation' | 'contradiction' }>> {
    return this._roboticsImpl()?.reinforcePrinciplesFromExperience(experienceId) ?? []
  }

  async evaluatePromotionForExperience(experienceId: string): Promise<unknown | null> {
    return this._roboticsImpl()?.evaluatePromotionForExperience(experienceId) ?? null
  }

  /** Drop the memoized R6 anchor section so newly committed anchors appear next turn. */
  invalidateAnchors(): void {
    this._roboticsImpl()?.invalidateAnchors()
  }

  getRoboticsTeamController(): RoboticsTeamController | null {
    return this._roboticsImpl()?.getTeamController() ?? null
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
    // Explicit-mode lock: when the caller declared a concrete mode
    // (hint !== 'detect'), that mode always wins and is never changed by
    // weight-based raises. This is essential for 'auto', whose weight (1) equals
    // 'agentic': without the lock, a pre-submit registerTool('agentic') would
    // pin the session to agentic and the later raise to 'auto' (1 > 1 === false)
    // would be ignored — dropping the jail. A campaign/robotics detection signal
    // must likewise never upgrade an explicit auto session.
    if (this._hint !== 'detect') {
      this._currentMode = this._hint
      return
    }
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
      case 'agentic':
      case 'auto':
        // Both run on the shared agentic backend (same loop + research wiring).
        // AUTO differs only in its permission/sandbox posture (autonomous +
        // config-locked workspace jail) and the AUTO prompt section — all carried
        // by MODE_PROFILES[mode].agenticOverrides (undefined for plain agentic).
        return this._createAgenticBackend(MODE_PROFILES[mode].agenticOverrides)

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
   * Build the agentic backend by delegating to {@link createAgenticBackend}.
   * The Router only supplies its config/lifecycle inputs and stores the auto
   * artifacts (bridge + checkpoint coordinator) it needs for later submit-time
   * checkpointing and teardown — all the actual wiring lives in the factory.
   */
  private async _createAgenticBackend(
    overrides?: { autonomy?: AutonomyProfile; promptMode?: import('../core/dynamicPrompt.js').AgentMode },
  ): Promise<SessionImpl> {
    const projectDir = this._cfg.projectDir ?? process.cwd()
    const { session, bridge, checkpointCoordinator } = await createAgenticBackend({
      baseConfig: this._cfgAsConfig(),
      projectDir,
      resumeSessionId: this._resumeSessionId,
      explicitResume: this._explicitResume,
      overrides,
      getGoal: () => this._autoGoal,
    })
    this._autoCheckpointCoordinator = checkpointCoordinator
    if (overrides?.autonomy) this._autoBridge = bridge
    return session
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
    // planModeRef is injected explicitly (not relied upon from the spread) so
    // the backend's permission policy and the CLI-registered plan-mode tools
    // share THIS router's single ref object.
    return { ...this._cfg, tools: [], planModeRef: this._planModeRef }
  }

  /**
   * The shared plan-mode ref. The CLI wires this into the system tools it
   * registers (`createStandardTools({ system: { planModeRef } })`) so
   * enter_plan_mode / exit_plan_mode flip the same object the backend's kernel
   * permission policy reads.
   */
  get planModeRef(): { active: boolean } {
    return this._planModeRef
  }
}
