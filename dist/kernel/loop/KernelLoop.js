import { emptyUsage, addUsage } from '../types/TokenUsage.js';
import { initialLoopState } from './LoopState.js';
import { applyToolResultBudget } from '../tools/ToolResultBudget.js';
import { autoCompactIfNeeded } from '../compact/AutoCompact.js';
import { streamMessages } from '../api/AnthropicClient.js';
import { streamDeepSeekMessages } from '../api/DeepSeekClient.js';
import { normalizeMessagesForAPI, getMessagesAfterCompactBoundary, stripThinkingBlocksFromMessages, } from '../messages/MessageNormalizer.js';
import { normalizeMessagesForDeepSeek } from '../messages/DeepSeekMessageNormalizer.js';
import { makeAssistantMessage, makeInterruptionMessage, makeMaxOutputTokensRecoveryMessage, } from '../messages/MessageFactory.js';
import { runTools, buildMissingToolResultMessages, } from '../tools/ToolOrchestration.js';
import { defaultCanUseTool } from '../permissions/CanUseTool.js';
import { calculateTokenWarningState, ESCALATED_MAX_TOKENS, MAX_OUTPUT_TOKENS_RECOVERY_LIMIT, } from '../utils/Context.js';
import { tokenCountWithEstimation } from '../api/TokenCount.js';
import { isMaxOutputTokensStopReason, PROMPT_TOO_LONG_ERROR_MESSAGE, PromptTooLongError, FallbackTriggeredError, } from '../api/Errors.js';
import { calcCostUsd } from '../utils/CostTracker.js';
function newAccumulator() {
    return {
        blocks: [],
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        stopReason: null,
    };
}
function finaliseAccumulator(acc) {
    const content = [];
    for (const block of acc.blocks) {
        if (!block)
            continue;
        if (block.type === 'text') {
            if (block.text)
                content.push({ type: 'text', text: block.text });
        }
        else if (block.type === 'thinking') {
            content.push({ type: 'thinking', thinking: block.thinking });
        }
        else if (block.type === 'redacted_thinking') {
            content.push({ type: 'redacted_thinking', data: block.data });
        }
        else if (block.type === 'tool_use') {
            let parsed = {};
            try {
                parsed = JSON.parse(block.input || '{}');
            }
            catch { /* ok */ }
            content.push({ type: 'tool_use', id: block.id, name: block.name, input: parsed });
        }
    }
    return {
        content,
        usage: {
            inputTokens: acc.inputTokens,
            outputTokens: acc.outputTokens,
            cacheReadTokens: acc.cacheReadTokens,
            cacheWriteTokens: acc.cacheWriteTokens,
        },
        stopReason: acc.stopReason,
    };
}
const NO_PROGRESS_REPEAT_LIMIT = 3;
function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        const encoded = JSON.stringify(value);
        return encoded === undefined ? String(value) : encoded;
    }
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(',')}]`;
    const record = value;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
// ── Main loop ────────────────────────────────────────────────────────────────
export async function* runKernelLoop(ctx) {
    const { config, mutableMessages, abortController, fileCache, sessionId } = ctx;
    const signal = abortController.signal;
    const canUseTool = config.canUseTool ?? defaultCanUseTool;
    const maxTurns = config.maxTurns ?? 100;
    let state = initialLoopState([...mutableMessages], config.model);
    let totalUsage = emptyUsage();
    let totalCost = ctx.cumulativeCostUsd;
    let allPermissionDenials = [];
    let resultText = '';
    let lastToolRequestSignature = '';
    let repeatedToolRequestCount = 0;
    // Helper: push messages to both mutableMessages and state
    function append(...msgs) {
        mutableMessages.push(...msgs);
        state = { ...state, messages: [...mutableMessages] };
    }
    function done(reason) {
        return {
            reason,
            totalUsage,
            costUsd: totalCost,
            numTurns: state.turnCount,
            resultText,
            finalModel: state.currentModel,
            fallbackTriggered: state.fallbackTriggered,
            permissionDenials: allPermissionDenials,
            finalMessages: [...mutableMessages],
        };
    }
    while (true) {
        // ── Step 1: applyToolResultBudget ────────────────────────────────────────
        const budgetedMessages = applyToolResultBudget(state.messages, config.tools);
        // ── Step 5: autoCompactIfNeeded ──────────────────────────────────────────
        const messagesForQuery = [...getMessagesAfterCompactBoundary(budgetedMessages)];
        const compactResult = config.compact?.enabled === false
            ? {
                wasCompacted: false,
                tracking: state.autoCompactTracking ?? {
                    compacted: false,
                    turnId: crypto.randomUUID(),
                    turnCounter: 0,
                    consecutiveFailures: 0,
                },
            }
            : await autoCompactIfNeeded(messagesForQuery, state.currentModel, fileCache, config.querySource, state.autoCompactTracking, state.maxOutputTokensOverride ?? config.maxOutputTokens, {
                model: config.compact?.model,
                apiKey: config.apiKey,
                baseURL: config.baseURL,
                systemPrompt: config.systemPrompt,
                customInstructions: config.compact?.customInstructions,
                abortSignal: signal,
                maxRetries: config.maxRetries,
            });
        state = { ...state, autoCompactTracking: compactResult.tracking };
        let currentMessagesForQuery;
        if (compactResult.wasCompacted && compactResult.postCompactMessages) {
            const compactMsgs = compactResult.postCompactMessages;
            // Replace mutableMessages + state with compacted version. The compact
            // summary is now the authoritative continuation; keeping pre-compact
            // messages here would preserve the memory/persistence growth that compact
            // is meant to relieve.
            mutableMessages.splice(0, mutableMessages.length, ...compactMsgs);
            state = { ...state, messages: [...mutableMessages] };
            currentMessagesForQuery = [...getMessagesAfterCompactBoundary(state.messages)];
            yield {
                type: 'compact_boundary',
                compactMetadata: { summaryTokens: 0, previousTokens: tokenCountWithEstimation(messagesForQuery) },
                sessionId,
            };
        }
        else {
            currentMessagesForQuery = messagesForQuery;
        }
        // ── Step 6: blocking limit check ─────────────────────────────────────────
        const tokenCount = tokenCountWithEstimation(currentMessagesForQuery);
        const { isAtBlockingLimit } = calculateTokenWarningState(tokenCount, state.currentModel, state.maxOutputTokensOverride ?? config.maxOutputTokens);
        if (isAtBlockingLimit) {
            resultText = PROMPT_TOO_LONG_ERROR_MESSAGE;
            yield { type: 'text_delta', delta: PROMPT_TOO_LONG_ERROR_MESSAGE, sessionId };
            return done('blocking_limit');
        }
        // ── Steps 7+8: stream API + accumulate messages ───────────────────────────
        const systemPrompt = [config.systemPrompt, config.appendSystemPrompt]
            .filter(Boolean)
            .join('\n\n');
        const messagesForApi = state.fallbackTriggered
            ? stripThinkingBlocksFromMessages(currentMessagesForQuery)
            : currentMessagesForQuery;
        const assistantMessages = [];
        const acc = newAccumulator();
        let streamError = null;
        // Route to DeepSeek or Anthropic based on model prefix
        const isDeepSeek = state.currentModel.startsWith('deepseek-');
        try {
            const retryEvents = [];
            const retryCallback = (attempt, maxRetries, retryDelayMs, errorStatus) => {
                retryEvents.push({ type: 'api_retry', attempt, maxRetries, retryDelayMs, errorStatus, sessionId });
            };
            const eventStream = isDeepSeek
                ? streamDeepSeekMessages({
                    model: state.currentModel,
                    sessionId,
                    messages: normalizeMessagesForDeepSeek(messagesForApi, systemPrompt || undefined),
                    tools: config.tools,
                    thinkingConfig: state.fallbackTriggered
                        ? (config.fallbackThinkingConfig ?? { type: 'disabled' })
                        : config.thinkingConfig,
                    maxOutputTokens: state.maxOutputTokensOverride ?? config.maxOutputTokens,
                    abortSignal: signal,
                }, config, retryCallback)
                : streamMessages({
                    model: state.currentModel,
                    sessionId,
                    messages: normalizeMessagesForAPI(messagesForApi),
                    systemPrompt: systemPrompt || undefined,
                    tools: config.tools,
                    thinkingConfig: state.fallbackTriggered
                        ? (config.fallbackThinkingConfig ?? { type: 'disabled' })
                        : config.thinkingConfig,
                    maxOutputTokens: state.maxOutputTokensOverride ?? config.maxOutputTokens,
                    abortSignal: signal,
                    betas: state.fallbackTriggered
                        ? (config.fallbackBetas ?? [])
                        : config.betas,
                    includeDefaultBetas: state.fallbackTriggered
                        ? (config.fallbackIncludeDefaultBetas ?? false)
                        : (config.includeDefaultBetas ?? true),
                }, config, retryCallback);
            for await (const event of eventStream) {
                // Drain any pending retry events
                for (const retryEvent of retryEvents.splice(0)) {
                    yield retryEvent;
                }
                switch (event.type) {
                    case 'message_start': {
                        // usage may be absent on non-Anthropic providers (DeepSeek, Qwen)
                        acc.inputTokens = event.usage?.input_tokens ?? 0;
                        acc.cacheReadTokens = event.usage?.cache_read_input_tokens ?? 0;
                        acc.cacheWriteTokens = event.usage?.cache_creation_input_tokens ?? 0;
                        break;
                    }
                    case 'content_block_start': {
                        const cb = event.content_block;
                        if (cb.type === 'text') {
                            acc.blocks[event.index] = { type: 'text', text: '' };
                        }
                        else if (cb.type === 'thinking') {
                            acc.blocks[event.index] = { type: 'thinking', thinking: '' };
                        }
                        else if (cb.type === 'redacted_thinking') {
                            acc.blocks[event.index] = { type: 'redacted_thinking', data: cb.data ?? '' };
                        }
                        else if (cb.type === 'tool_use') {
                            acc.blocks[event.index] = {
                                type: 'tool_use',
                                id: cb.id,
                                name: cb.name,
                                input: '',
                            };
                        }
                        break;
                    }
                    case 'content_block_delta': {
                        const block = acc.blocks[event.index];
                        if (!block)
                            break;
                        const delta = event.delta;
                        if (delta['type'] === 'text_delta' && block.type === 'text') {
                            const text = String(delta['text'] ?? '');
                            block.text += text;
                            yield { type: 'text_delta', delta: text, sessionId };
                        }
                        else if (delta['type'] === 'thinking_delta' && block.type === 'thinking') {
                            const thinkingChunk = String(delta['thinking'] ?? '');
                            block.thinking += thinkingChunk;
                            if (thinkingChunk) {
                                yield { type: 'thinking_delta', delta: thinkingChunk, sessionId };
                            }
                        }
                        else if (delta['type'] === 'input_json_delta' && block.type === 'tool_use') {
                            block.input += String(delta['partial_json'] ?? '');
                        }
                        break;
                    }
                    case 'message_delta': {
                        acc.stopReason = event.delta?.stop_reason ?? null;
                        acc.outputTokens = event.usage?.output_tokens ?? 0;
                        break;
                    }
                    case 'message_stop': {
                        const { content, usage, stopReason } = finaliseAccumulator(acc);
                        const assistantMsg = makeAssistantMessage(content, { usage, stopReason });
                        assistantMessages.push(assistantMsg);
                        totalUsage = addUsage(totalUsage, usage);
                        totalCost += calcCostUsd(usage, state.currentModel);
                        // Reset accumulator for potential next message in same stream
                        Object.assign(acc, newAccumulator());
                        break;
                    }
                }
            }
        }
        catch (err) {
            if (err instanceof PromptTooLongError) {
                resultText = PROMPT_TOO_LONG_ERROR_MESSAGE;
                yield { type: 'text_delta', delta: PROMPT_TOO_LONG_ERROR_MESSAGE, sessionId };
                return done('blocking_limit');
            }
            // ── Fallback model switch ─────────────────────────────────────────────
            // When the primary model cannot handle the request (e.g. thinking quota
            // exceeded), switch to fallbackModel and retry this loop iteration.
            // The tombstone flag prevents infinite recursion if the fallback model
            // also triggers a FallbackTriggeredError.
            if (err instanceof FallbackTriggeredError &&
                config.fallbackModel &&
                !state.fallbackTriggered) {
                state = {
                    ...state,
                    currentModel: config.fallbackModel,
                    fallbackTriggered: true, // tombstone: don't fall back again
                    maxOutputTokensOverride: undefined, // reset escalation for fresh model
                };
                continue; // retry this turn with the fallback model
            }
            streamError = err;
        }
        // ── Step 12: abort after streaming ───────────────────────────────────────
        if (signal.aborted) {
            const missingResults = buildMissingToolResultMessages(assistantMessages, 'Interrupted by user');
            append(...assistantMessages, ...missingResults);
            if (signal.reason !== 'interrupt') {
                append(makeInterruptionMessage(false));
            }
            return done('aborted_streaming');
        }
        if (streamError) {
            throw streamError;
        }
        // Commit assistant messages to history
        append(...assistantMessages);
        // ── Collect tool_use blocks ──────────────────────────────────────────────
        const toolUseRequests = assistantMessages.flatMap(msg => msg.content
            .filter((b) => b.type === 'tool_use')
            .map(b => ({
            toolUseId: b.id,
            toolName: b.name,
            input: b.input,
            assistantMessageUuid: msg.uuid,
        })));
        const lastMsg = assistantMessages[assistantMessages.length - 1];
        const stopReason = lastMsg?.stopReason ?? null;
        const assistantText = assistantMessages
            .flatMap(m => m.content)
            .filter((b) => b.type === 'text')
            .map(b => b.text)
            .join('');
        // ── Step 14: no-tools path ───────────────────────────────────────────────
        if (toolUseRequests.length === 0) {
            resultText = assistantText;
            // 14b: max_output_tokens recovery
            if (isMaxOutputTokensStopReason(stopReason)) {
                if (state.maxOutputTokensOverride === undefined &&
                    !process.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS']) {
                    // Phase 1: escalate to 64k
                    state = { ...state, maxOutputTokensOverride: ESCALATED_MAX_TOKENS };
                    continue;
                }
                if (state.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
                    // Phase 2: multi-turn recovery
                    append(makeMaxOutputTokensRecoveryMessage());
                    state = { ...state, maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount + 1 };
                    continue;
                }
                // Phase 3: exhausted → surface to user and exit
                return done('success');
            }
            // 14e: normal completion
            return done('success');
        }
        const toolRequestSignature = toolUseRequests
            .map(req => `${req.toolName}:${stableStringify(req.input)}`)
            .join('\n');
        if (toolRequestSignature === lastToolRequestSignature && assistantText.trim().length === 0) {
            repeatedToolRequestCount++;
        }
        else {
            lastToolRequestSignature = toolRequestSignature;
            repeatedToolRequestCount = 1;
        }
        if (repeatedToolRequestCount >= NO_PROGRESS_REPEAT_LIMIT) {
            resultText =
                `Stopped: the model repeated the same tool request ${repeatedToolRequestCount} times without making progress.`;
            yield { type: 'text_delta', delta: resultText, sessionId };
            return done('no_progress');
        }
        // Emit tool_use events
        for (const req of toolUseRequests) {
            yield { type: 'tool_use', id: req.toolUseId, name: req.toolName, input: req.input, sessionId };
        }
        // ── Step 15: runTools ────────────────────────────────────────────────────
        const toolCtx = {
            sessionId,
            abortSignal: signal,
            readFileState: fileCache,
            messages: state.messages,
            workspaceRoot: ctx.cwd,
            planMode: config.planModeRef?.active ?? false,
            askUser: config.askUser,
        };
        const toolsResult = await runTools(toolUseRequests, config.tools, toolCtx, canUseTool);
        const toolNameByUseId = new Map(toolUseRequests.map(req => [req.toolUseId, req.toolName]));
        // Emit tool_result events
        for (const resultMsg of toolsResult.toolResultMessages) {
            for (const block of resultMsg.content) {
                if (block.type === 'tool_result') {
                    const content = typeof block.content === 'string'
                        ? block.content
                        : JSON.stringify(block.content);
                    yield {
                        type: 'tool_result',
                        id: block.tool_use_id,
                        toolName: toolNameByUseId.get(block.tool_use_id) ?? '',
                        content,
                        isError: block.is_error ?? false,
                        sessionId,
                    };
                }
            }
        }
        allPermissionDenials.push(...toolsResult.permissionDenials);
        for (const denial of toolsResult.permissionDenials) {
            config.onPermissionDenial?.(denial);
        }
        append(...toolsResult.toolResultMessages, ...toolsResult.extraMessages);
        // ── Step 16: abort after tools ───────────────────────────────────────────
        if (signal.aborted) {
            if (signal.reason !== 'interrupt') {
                append(makeInterruptionMessage(true));
            }
            return done('aborted_tools');
        }
        // ── Step 18: max turns check ─────────────────────────────────────────────
        state = { ...state, turnCount: state.turnCount + 1 };
        if (state.turnCount >= maxTurns) {
            return done('max_turns');
        }
        // ── Budget check ─────────────────────────────────────────────────────────
        if (config.maxBudgetUsd !== undefined && totalCost >= config.maxBudgetUsd) {
            return done('max_budget_usd');
        }
        // ── Step 19: continue ────────────────────────────────────────────────────
    }
}
//# sourceMappingURL=KernelLoop.js.map