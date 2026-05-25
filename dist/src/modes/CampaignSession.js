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
import { KernelSession } from '../kernel/index.js';
import { resolveConfig, detectProvider } from '../core/config.js';
import { instrumentTool } from '../runtime/instrumentTool.js';
import { MetaAgentContextStore } from '../campaign/index.js';
import { buildCompactInstructions } from '../core/compact/compactPrompt.js';
import { saveStateSnapshot, loadStateSnapshot, cleanupStateSnapshot } from '../core/compact/stateSnapshot.js';
import { toKernelTool } from './toolAdapter.js';
import { translateKernelEvent } from './eventAdapter.js';
import { createPermissionPolicy } from '../kernel/permissions/PermissionPolicy.js';
export class CampaignSession {
    _engine;
    _config;
    _sessionId;
    _sessionStartMs = Date.now();
    _totalCostUsd = 0;
    _usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
    };
    constructor(config) {
        this._config = config;
        const resolved = resolveConfig(config);
        const { apiKey, baseURL } = detectProvider(config);
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
                model: resolved.baseURL.includes('anthropic.com') ? 'claude-haiku-4-5-20251001' : resolved.model,
                // ## Compact Instructions injected via appendSystemPrompt each submit()
            },
            thinkingConfig: { type: 'adaptive' },
            querySource: 'main',
            // token-efficient-tools reduces schema token overhead for multi-tool sessions
            betas: ['token-efficient-tools-2025-02-19'],
        });
        this._sessionId = this._engine.getSessionId();
    }
    // ── Tool registration (no engine rebuild needed) ──────────────────────────
    registerTool(tool) {
        const wrapped = this._config.runtimeContext
            ? instrumentTool(tool, this._config.runtimeContext, {
                systemPrompt: this._config.systemPrompt,
            })
            : tool;
        // Build extensions map for KernelToolContext
        const extensions = {};
        const rtx = this._config.runtimeContext;
        if (rtx) {
            extensions['jobManager'] = rtx.jobManager;
            extensions['vvChain'] = rtx.vvChain;
            extensions['provenanceTracker'] = rtx.provenanceTracker;
        }
        // Thread the snapshot fire-and-forget through onMessage extension
        extensions['onSnapshotFireAndForget'] = async () => {
            await saveStateSnapshot(this._sessionId, this._config.runtimeContext, this._sessionStartMs).catch(() => { });
        };
        this._engine.upsertTool(toKernelTool(wrapped, extensions));
    }
    // ── Submission ────────────────────────────────────────────────────────────
    async *submit(prompt) {
        // Build enriched suffix (campaign context + compact instructions)
        const suffix = await this._buildEnrichedSuffix();
        this._engine.setAppendSystemPrompt(suffix);
        const state = {
            sessionId: this._sessionId,
            startMs: Date.now(),
            turnCount: 0,
            totalCostUsd: this._totalCostUsd,
            usage: { ...this._usage },
        };
        for await (const event of this._engine.submitMessage(prompt)) {
            if (event.type === 'tool_use')
                state.turnCount++;
            if (event.type === 'result') {
                this._totalCostUsd = event.costUsd;
                this._usage = {
                    inputTokens: event.usage.inputTokens,
                    outputTokens: event.usage.outputTokens,
                    cacheCreationInputTokens: event.usage.cacheWriteTokens,
                    cacheReadInputTokens: event.usage.cacheReadTokens,
                };
                state.totalCostUsd = event.costUsd;
            }
            for (const translated of translateKernelEvent(event, state)) {
                yield translated;
            }
        }
    }
    // ── Lifecycle ─────────────────────────────────────────────────────────────
    interrupt() {
        this._engine.interrupt();
        void cleanupStateSnapshot(this._sessionId).catch(() => { });
    }
    getMessages() {
        // KernelMessage is structurally compatible with ConversationMessage
        // (same role/content shape); cast avoids a round-trip conversion.
        return this._engine.getMessages();
    }
    getSessionId() { return this._sessionId; }
    getUsage() { return { ...this._usage }; }
    getEstimatedCost() { return this._totalCostUsd; }
    // ── Enriched suffix builder (identical to KernelBridge._buildEnrichedSuffix) ─
    async _buildEnrichedSuffix() {
        const parts = [];
        // Part 1: active campaign context block
        try {
            const campaignContext = await MetaAgentContextStore.buildInjectionBlock();
            if (campaignContext)
                parts.push(campaignContext);
        }
        catch { /* swallow */ }
        // Part 2: ## Compact Instructions (instructs compact agent to preserve
        // provenance IDs, campaign state, and V&V events)
        try {
            const [snapshot, liveRecords] = await Promise.all([
                loadStateSnapshot(this._sessionId),
                this._config.runtimeContext?.provenanceTracker
                    .list({ since: this._sessionStartMs })
                    .catch(() => undefined),
            ]);
            const compactInstructions = await buildCompactInstructions(this._config.runtimeContext, this._sessionId, this._sessionStartMs, snapshot, liveRecords);
            if (compactInstructions)
                parts.push(compactInstructions);
        }
        catch { /* swallow */ }
        return parts.join('\n\n');
    }
}
//# sourceMappingURL=CampaignSession.js.map