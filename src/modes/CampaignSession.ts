/**
 * CampaignSession — KernelSession-backed replacement for KernelBridge.
 *
 * Compared to KernelBridge, this session:
 *   - Uses KernelSession (our TypeScript rewrite) instead of CC's QueryEngine
 *   - Doesn't require CC global bootstrapping (setOriginalCwd, enableConfigs, etc.)
 *   - Still builds the same enriched system prompt suffix with campaign context
 *     and ## Compact Instructions
 *   - Handles dynamic tool registration without engine rebuilds (KernelSession.upsertTool)
 *
 * Public API is intentionally compatible with KernelBridge so CampaignSession
 * can be swapped in as a drop-in replacement.
 */
import { KernelSession } from '../kernel/index.js'
import type { ConversationMessage, MetaAgentEvent, MetaAgentTool, TokenUsage } from '../core/types.js'
import type { MetaAgentConfig } from '../core/config.js'
import { resolveConfig, detectProvider } from '../core/config.js'
import { instrumentTool } from '../runtime/instrumentTool.js'
import { MetaAgentContextStore } from '../campaign/index.js'
import { buildCompactInstructions } from '../core/compact/compactPrompt.js'
import { saveStateSnapshot, loadStateSnapshot, cleanupStateSnapshot } from '../core/compact/stateSnapshot.js'
import { toKernelTool } from './toolAdapter.js'
import { translateKernelEvent, type TranslationState } from './eventAdapter.js'
import { createPermissionPolicy } from '../kernel/permissions/PermissionPolicy.js'
import type { KernelMessage } from '../kernel/index.js'

function toKernelMessages(messages: readonly ConversationMessage[] | undefined): KernelMessage[] {
  return (messages ?? []).map(message => ({
    uuid: crypto.randomUUID(),
    role: message.role,
    content: typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content as KernelMessage['content'],
  }))
}

export class CampaignSession {
  private readonly _engine: KernelSession
  private readonly _config: MetaAgentConfig
  private readonly _sessionId: string
  private readonly _sessionStartMs = Date.now()
  private readonly _registeredTools: MetaAgentTool[] = []
  private _totalCostUsd = 0
  /** #11: Guard against concurrent submit() calls on the same session. */
  private _submitInFlight = false
  private _usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }

  constructor(config: MetaAgentConfig) {
    this._config = config
    const resolved = resolveConfig(config)
    const { apiKey, baseURL } = detectProvider(config)

    this._engine = new KernelSession({
      apiKey,
      baseURL,
      model: resolved.model,
      fallbackModel: resolved.fallbackModel,
      fallbackThinkingConfig: resolved.fallbackThinkingConfig,
      fallbackBetas: resolved.fallbackBetas,
      fallbackIncludeDefaultBetas: resolved.fallbackIncludeDefaultBetas,
      cwd: resolved.projectDir ?? process.cwd(),
      systemPrompt: resolved.systemPrompt,
      initialMessages: toKernelMessages(resolved.initialMessages),
      tools: [],
      canUseTool: createPermissionPolicy({
        workspaceRoot: resolved.projectDir ?? process.cwd(),
        beforeToolCall: config.beforeToolCall,
        planModeRef: config.planModeRef,
        askUser: config.askUser,
        permissionConfig: config.permissionConfig,
      }),
      planModeRef: config.planModeRef,
      askUser: config.askUser,
      maxTurns: resolved.maxTurns === Infinity ? 500 : resolved.maxTurns,
      maxBudgetUsd: resolved.maxBudgetUsd,
      maxOutputTokens: resolved.maxTokens,
      maxRetries: resolved.maxRetries,
      compact: {
        enabled: true,
        model: resolved.flashModel,
        // ## Compact Instructions injected via appendSystemPrompt each submit()
      },
      thinkingConfig: { type: 'adaptive' },
      querySource: 'main',
      // token-efficient-tools reduces schema token overhead for multi-tool sessions
      betas: ['token-efficient-tools-2025-02-19'],
    })

    this._sessionId = this._engine.getSessionId()

    for (const tool of resolved.tools) {
      this.registerTool(tool)
    }
  }

  // ── Tool registration (no engine rebuild needed) ──────────────────────────

  registerTool(tool: MetaAgentTool): void {
    const existingIdx = this._registeredTools.findIndex(t => t.name === tool.name)
    if (existingIdx >= 0) {
      this._registeredTools[existingIdx] = tool
    } else {
      this._registeredTools.push(tool)
    }

    const wrapped = this._config.runtimeContext
      ? instrumentTool(tool, this._config.runtimeContext, {
          systemPrompt: this._config.systemPrompt,
        })
      : tool

    // Build extensions map for KernelToolContext
    const extensions: Record<string, unknown> = {}
    const rtx = this._config.runtimeContext
    if (rtx) {
      extensions['jobManager'] = rtx.jobManager
      extensions['vvChain'] = rtx.vvChain
      extensions['provenanceTracker'] = rtx.provenanceTracker
    }
    // Thread the snapshot fire-and-forget through onMessage extension
    extensions['onSnapshotFireAndForget'] = async () => {
      await saveStateSnapshot(
        this._sessionId,
        this._config.runtimeContext,
        this._sessionStartMs,
      ).catch(() => {})
    }

    this._engine.upsertTool(toKernelTool(wrapped, extensions, () => ({
      tools: this._registeredTools,
      toolNames: new Set(this._registeredTools.map(t => t.name)),
      sessionId: this._sessionId,
      domain: this._config.domain,
    })))
  }

  // ── Submission ────────────────────────────────────────────────────────────

  async *submit(prompt: string): AsyncGenerator<MetaAgentEvent> {
    // #11: Friendlier reentrancy check at the CampaignSession level.
    if (this._submitInFlight) {
      throw new Error(
        '[CampaignSession] Cannot submit a new prompt while a campaign turn is already in progress. ' +
        'Wait for the current multi-turn loop to complete before calling submit() again.',
      )
    }
    this._submitInFlight = true

    // Build enriched suffix (campaign context + compact instructions)
    const suffix = await this._buildEnrichedSuffix()
    this._engine.setAppendSystemPrompt(suffix)

    const state: TranslationState = {
      sessionId: this._sessionId,
      startMs: Date.now(),
      turnCount: 0,
      totalCostUsd: this._totalCostUsd,
      usage: { ...this._usage },
    }

    try {
      for await (const event of this._engine.submitMessage(prompt)) {
        if (event.type === 'tool_use') state.turnCount++
        if (event.type === 'result') {
          this._totalCostUsd = event.costUsd
          this._usage = {
            inputTokens:              event.usage.inputTokens,
            outputTokens:             event.usage.outputTokens,
            cacheCreationInputTokens: event.usage.cacheWriteTokens,
            cacheReadInputTokens:     event.usage.cacheReadTokens,
          }
          state.totalCostUsd = event.costUsd
        }

        for (const translated of translateKernelEvent(event, state)) {
          yield translated
        }
      }
    } finally {
      this._submitInFlight = false
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  interrupt(): void {
    this._engine.interrupt()
    void cleanupStateSnapshot(this._sessionId).catch(() => {})
  }

  getMessages(): readonly ConversationMessage[] {
    // KernelMessage is structurally compatible with ConversationMessage
    // (same role/content shape); cast avoids a round-trip conversion.
    return this._engine.getMessages() as unknown as ConversationMessage[]
  }
  getSessionId() { return this._sessionId }
  getUsage(): TokenUsage { return { ...this._usage } }
  getEstimatedCost(): number { return this._totalCostUsd }

  // ── Enriched suffix builder (identical to KernelBridge._buildEnrichedSuffix) ─

  private async _buildEnrichedSuffix(): Promise<string> {
    const parts: string[] = []

    // Part 1: active campaign context block
    try {
      const campaignContext = await MetaAgentContextStore.buildInjectionBlock()
      if (campaignContext) parts.push(campaignContext)
    } catch { /* swallow */ }

    // Part 2: ## Compact Instructions (instructs compact agent to preserve
    // provenance IDs, campaign state, and V&V events)
    try {
      const [snapshot, liveRecords] = await Promise.all([
        loadStateSnapshot(this._sessionId),
        this._config.runtimeContext?.provenanceTracker
          .list({ since: this._sessionStartMs })
          .catch(() => undefined),
      ])
      const compactInstructions = await buildCompactInstructions(
        this._config.runtimeContext,
        this._sessionId,
        this._sessionStartMs,
        snapshot,
        liveRecords,
      )
      if (compactInstructions) parts.push(compactInstructions)
    } catch { /* swallow */ }

    return parts.join('\n\n')
  }
}
