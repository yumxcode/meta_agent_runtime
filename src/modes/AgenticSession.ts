/**
 * AgenticSession — full multi-turn agentic session backed by KernelSession.
 *
 * This is the main replacement for MetaAgentSession when running with the
 * new cc-kernel. Supports:
 *   - Multi-turn tool-use loop (up to maxTurns)
 *   - Auto-compact (flash model summariser)
 *   - Streaming events
 *   - Tool registration / upsert
 *   - Interrupt
 *   - Budget enforcement (maxBudgetUsd)
 */
import { KernelSession } from '../kernel/index.js'
import type { ConversationMessage, MetaAgentEvent, MetaAgentTool, TokenUsage } from '../core/types.js'
import type { MetaAgentConfig } from '../core/config.js'
import { resolveConfig } from '../core/config.js'
import { instrumentTool } from '../runtime/instrumentTool.js'
import { toKernelTool } from './toolAdapter.js'
import { translateKernelEvent, type TranslationState } from './eventAdapter.js'
import { createPermissionPolicy } from '../kernel/permissions/PermissionPolicy.js'
import { toKernelMessages } from './messageBridge.js'
import { ToolRuntimeGuards } from './toolRuntimeGuards.js'
import { resolveConfiguredWriteAllowPaths } from '../sandbox/configuredWritePaths.js'

export class AgenticSession {
  private readonly _engine: KernelSession
  private readonly _config: MetaAgentConfig
  private readonly _sessionId: string
  private readonly _runtimeGuards: ToolRuntimeGuards
  private readonly _registeredTools: MetaAgentTool[] = []
  /** S1: guard against double dispose. */
  private _disposed = false
  private _totalCostUsd = 0
  private _usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }

  constructor(config: MetaAgentConfig) {
    this._config = config
    const resolved = resolveConfig(config)
    const apiKey = resolved.apiKey
    const baseURL = resolved.baseURL
    const caps = resolved.capabilities
    this._runtimeGuards = new ToolRuntimeGuards({
      projectDir: resolved.projectDir ?? process.cwd(),
      autonomy: config.autonomy,
      extraWriteAllowPaths: resolveConfiguredWriteAllowPaths(resolved.projectDir ?? process.cwd()),
    })
    // Anthropic-format providers that don't accept the thinking param (e.g. Qwen)
    // must not receive it; OpenAI-protocol providers map thinking → reasoning_effort
    // downstream, so leave their config untouched.
    const thinkingConfig = resolved.protocol === 'anthropic' && !caps.anthropicThinkingParam
      ? { type: 'disabled' as const }
      : resolved.thinkingConfig

    this._engine = new KernelSession({
      apiKey,
      baseURL,
      model: resolved.model,
      fallbackModel: resolved.fallbackModel,
      fallbackThinkingConfig: resolved.fallbackThinkingConfig,
      fallbackBetas: resolved.fallbackBetas,
      fallbackIncludeDefaultBetas: resolved.fallbackIncludeDefaultBetas,
      sessionId: config.sessionId,         // honour caller-pinned session ID
      cwd: resolved.projectDir ?? process.cwd(),
      systemPrompt: resolved.systemPrompt,
      appendSystemPrompt: resolved.appendSystemPrompt,
      initialMessages: toKernelMessages(resolved.initialMessages),
      tools: [],
      canUseTool: createPermissionPolicy({
        workspaceRoot: resolved.projectDir ?? process.cwd(),
        beforeToolCall: config.beforeToolCall,
        planModeRef: config.planModeRef,
        askUser: config.askUser,
        permissionConfig: config.permissionConfig,
        // Auto mode: autonomous (in-workspace ops skip the confirm guard) + hard
        // jail (cannot be unlocked by permissions.json). Absent for other modes.
        autonomy: config.autonomy,
      }),
      planModeRef: config.planModeRef,
      askUser: config.askUser,
      // Auto mode: enable the unattended stall circuit (consecutive all-error turns).
      autonomousMode: config.autonomy !== undefined,
      // Auto mode: independent completion gate (Verify). Only consulted by the
      // loop when autonomousMode is set; built by the router (owns goal+bridge).
      verifyGate: config.verifyGate,
      // Auto mode: mid-flight drift/reflection gate. Same gating + provenance.
      driftGate: config.driftGate,
      // Auto-orch: main-loop phase hooks (B). Inert unless set, so other modes
      // are unaffected.
      phaseHooks: config.phaseHooks,
      autoGateFailurePolicy: config.autoGateFailurePolicy,
      autoGateMaxAttempts: config.autoGateMaxAttempts,
      autoDriftFailureLimit: config.autoDriftFailureLimit,
      onCheckpointBoundary: config.onCheckpointBoundary,
      initialToolBatchCount: config.initialToolBatchCount,
      initialCheckpointRevision: config.initialCheckpointRevision,
      maxTurns: resolved.maxTurns,
      maxBudgetUsd: resolved.maxBudgetUsd,
      onMainCostUsd: resolved.onMainCostUsd,
      getAdditionalBudgetUsd: resolved.getAdditionalBudgetUsd,
      maxOutputTokens: resolved.maxTokens,
      maxRetries: resolved.maxRetries,
      compact: {
        enabled: true,
        model: resolved.compactModel,
        // Lazy thunk (or string) forwarded from the caller; resolved at
        // compaction time inside compactConversation(). RoboticsSession uses
        // this to route its mode-specific compact instructions here instead of
        // the every-turn volatile prefix.
        customInstructions: config.compact?.customInstructions,
        // Deterministic state anchors appended to the compact output in every
        // path; RoboticsSession routes its live-state anchor block here.
        deterministicAnchors: config.compact?.deterministicAnchors,
        // Per-mode compact section template. RoboticsSession/MetaAgentSession
        // forward 'robotics'/'agentic' through config.compact; bare agentic
        // sessions default to the generic 9-section template.
        promptProfile: config.compact?.promptProfile ?? 'agentic',
        // Auto mode: enable the no-model structural-truncation fallback so an
        // unattended run never grows into the blocking limit if the model
        // compactor's circuit breaker opens.
        autonomyFallback: config.autonomy !== undefined,
      },
      // Thinking on the primary model — sourced from resolved.thinkingConfig
      // (default `{ type: 'adaptive' }`, set in resolveConfig).  When the
      // caller hasn't disabled it, the kernel:
      //   • Anthropic → sends `thinking: { type: 'enabled', budget_tokens: 16k }`
      //   • DeepSeek  → sends `reasoning_effort: 'max'`
      //   • Qwen      → goes through Anthropic-compat endpoint, thinking enabled
      // Fallback model still honours fallbackThinkingConfig (default disabled).
      thinkingConfig,
      // Anthropic-only betas: token-efficient-tools + interleaved-thinking.
      // Gated by provider capability — third-party providers (GLM, DeepSeek,
      // Qwen, …) return 400 when these betas are present.
      includeDefaultBetas: caps.anthropicBetas ? undefined : false,
      betas: caps.anthropicBetas ? ['token-efficient-tools-2025-02-19'] : [],
      querySource: 'main',
      debug: resolved.debugMode,
    })

    this._sessionId = this._engine.getSessionId()

    for (const tool of resolved.tools) {
      this.registerTool(tool)
    }
  }

  // ── Tool registration ─────────────────────────────────────────────────────

  registerTool(tool: MetaAgentTool): void {
    const existingIdx = this._registeredTools.findIndex(t => t.name === tool.name)
    if (existingIdx >= 0) {
      this._registeredTools[existingIdx] = tool
    } else {
      this._registeredTools.push(tool)
    }

    const guarded = this._runtimeGuards.wrapTool(tool)

    // Instrument with RuntimeContext if provided
    const wrapped = this._config.runtimeContext
      ? instrumentTool(guarded, this._config.runtimeContext, {
          systemPrompt: this._config.systemPrompt,
        })
      : guarded

    // Build extensions for KernelToolContext
    const extensions: Record<string, unknown> = {}
    const rtx = this._config.runtimeContext
    if (rtx) {
      extensions['jobManager'] = rtx.jobManager
      extensions['vvChain'] = rtx.vvChain
      extensions['provenanceTracker'] = rtx.provenanceTracker
    }

    this._engine.upsertTool(toKernelTool(wrapped, extensions, () => ({
      tools: this._registeredTools,
      toolNames: new Set(this._registeredTools.map(t => t.name)),
      sessionId: this._sessionId,
      domain: this._config.domain,
    })))
  }

  /**
   * Snapshot of all currently-registered tools, keyed by tool name.
   *
   * Used to hand the sub-agent dispatcher (SubAgentBridge) a registry so that
   * sub-agents can resolve the tools listed in their `allowedTools`. Returns a
   * fresh Map each call — callers may not mutate the internal tool list.
   */
  getToolRegistry(): Map<string, MetaAgentTool> {
    return new Map(this._registeredTools.map(t => [t.name, t]))
  }

  // ── Submission ────────────────────────────────────────────────────────────

  async *submit(prompt: string): AsyncGenerator<MetaAgentEvent> {
    const state: TranslationState = {
      sessionId: this._sessionId,
      startMs: Date.now(),
      turnCount: 0,
      totalCostUsd: this._totalCostUsd,
      usage: { ...this._usage },
    }

    for await (const event of this._engine.submitMessage(prompt)) {
      if (event.type === 'tool_use') state.turnCount++
      if (event.type === 'result') {
        this._totalCostUsd = event.costUsd
        this._usage = {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cacheCreationInputTokens: event.usage.cacheWriteTokens,
          cacheReadInputTokens: event.usage.cacheReadTokens,
        }
        state.totalCostUsd = event.costUsd
      }

      for (const translated of translateKernelEvent(event, state)) {
        yield translated
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  interrupt(): void { this._engine.interrupt() }

  /** Inject a mid-turn user correction. See KernelSession.steer(). */
  steer(text: string): boolean { return this._engine.steer(text) }

  /** Replace the deterministic compact goal anchor for a new top-level task. */
  reanchorOriginalGoal(goal: string): void { this._engine.reanchorOriginalGoal(goal) }

  /** Manual compaction (/compact) — same pipeline as auto-compact, forced. */
  async compactNow(): Promise<import('../kernel/index.js').ManualCompactResult> {
    return this._engine.compactNow()
  }

  /**
   * S1 + S9: Release all per-session resources.  Forwards to the inner
   * KernelSession dispose (which clears messages / fileCache / tools closures),
   * and empties our own _registeredTools array so any caller-supplied tools —
   * with their potentially heavy closures — become unreachable.
   *
   * Safe to call multiple times.  Once called the session must not be reused.
   *
   * Async so the caller can AWAIT sandbox/runtime-guard teardown — the runtime
   * guards release sandbox handles asynchronously, and a fire-and-forget here
   * would let handles leak when the process exits quickly or sessions churn.
   */
  async dispose(): Promise<void> {
    if (this._disposed) return
    this._disposed = true
    try { await this._runtimeGuards.dispose() } catch { /* best-effort */ }
    try { this._engine.dispose() } catch { /* best-effort */ }
    this._registeredTools.length = 0
  }

  getMessages() { return this._engine.getMessages() }
  getSessionId() { return this._sessionId }
  getUsage(): TokenUsage { return { ...this._usage } }
  getEstimatedCost(): number { return this._totalCostUsd }

  /**
   * Update the system prompt suffix that is appended on every submit.
   * The full effective prompt is: systemPrompt + '\n\n' + appendSystemPrompt.
   * Used by MetaAgentSession to inject dynamic sections per-submit, and by
   * RoboticsSession to inject R1-R5 sections.
   */
  setAppendSystemPrompt(suffix: string): void {
    this._engine.setAppendSystemPrompt(suffix)
  }
}
