/**
 * AnthropicClient — streaming API wrapper.
 * Mirrors CC's claude.ts / queryModelWithStreaming.
 *
 * Key responsibilities:
 * - Build the request parameters (model, tokens, thinking, tools, system)
 * - Stream events from the SDK
 * - Emit api_retry events on retries
 * - Convert stop_reason to our domain types
 */
import Anthropic from '@anthropic-ai/sdk';
import { buildThinkingParam } from '../utils/ThinkingConfig.js';
import { DebugWriter } from './DebugWriter.js';
import { isRetryableError, isPromptTooLongError, isFallbackTriggeredError, PromptTooLongError, FallbackTriggeredError, } from './Errors.js';
const DEFAULT_MAX_TOKENS = 32_768;
const DEFAULT_MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
async function buildToolsParam(tools, model, sessionId = '') {
    return Promise.all(tools.map(async (t) => ({
        name: t.name,
        description: typeof t.description === 'string'
            ? t.description
            : await t.description({ sessionId, model }),
        input_schema: t.inputJSONSchema,
    })));
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function getErrorStatus(e) {
    if (e && typeof e === 'object' && 'status' in e) {
        const s = e.status;
        if (typeof s === 'number')
            return s;
    }
    return null;
}
// Default beta flags sent on every request
const DEFAULT_BETAS = ['interleaved-thinking-2025-05-14'];
/**
 * Stream messages from the Anthropic API.
 * Yields raw SDK stream events; the caller is responsible for reconstructing
 * assistant messages from these events.
 *
 * Retries automatically on 429/5xx.
 * Propagates PromptTooLongError on 400 PTL.
 * Propagates FallbackTriggeredError when the model cannot handle the request.
 */
export async function* streamMessages(params, config, onRetry) {
    // Merge default betas with any caller-supplied extras (dedup by Set)
    const allBetas = [...new Set([...(params.includeDefaultBetas === false ? [] : DEFAULT_BETAS), ...(params.betas ?? [])])];
    const betaHeader = allBetas.join(',');
    const client = new Anthropic({
        apiKey: config.apiKey ?? process.env['ANTHROPIC_API_KEY'],
        baseURL: config.baseURL,
        maxRetries: 0, // We handle retries ourselves
        ...(betaHeader ? { defaultHeaders: { 'anthropic-beta': betaHeader } } : {}),
    });
    const thinkingParam = buildThinkingParam(params.thinkingConfig);
    const toolsParam = await buildToolsParam(params.tools, params.model, params.sessionId);
    const requestParams = {
        model: params.model,
        max_tokens: params.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
        messages: params.messages,
        ...(params.systemPrompt ? { system: params.systemPrompt } : {}),
        ...(toolsParam.length > 0 ? { tools: toolsParam } : {}),
        ...(thinkingParam ? { thinking: thinkingParam } : {}),
    };
    // Open debug file once (outside retry loop — one file per logical call)
    const writer = await DebugWriter.open(params.sessionId, params.model, config.debug);
    if (writer) {
        await writer.writeRequest(requestParams);
    }
    let attempt = 0;
    while (true) {
        try {
            const stream = await client.messages.create(requestParams, {
                signal: params.abortSignal,
            });
            for await (const event of stream) {
                yield event;
            }
            if (writer)
                await writer.close();
            return;
        }
        catch (error) {
            if (isPromptTooLongError(error)) {
                throw new PromptTooLongError();
            }
            // Detect model-capability errors → let KernelLoop switch to fallbackModel
            if (isFallbackTriggeredError(error)) {
                throw new FallbackTriggeredError(error instanceof Error ? error.message : 'Fallback triggered');
            }
            if (!isRetryableError(error) ||
                attempt >= (config.maxRetries ?? DEFAULT_MAX_RETRIES) ||
                params.abortSignal.aborted) {
                if (writer)
                    await writer.close().catch(() => { });
                throw error;
            }
            attempt++;
            const base = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
            const jitter = Math.random() * 0.25 * base;
            const delayMs = Math.floor(base + jitter);
            onRetry?.(attempt, config.maxRetries ?? DEFAULT_MAX_RETRIES, delayMs, getErrorStatus(error));
            await sleep(delayMs);
        }
    }
}
//# sourceMappingURL=AnthropicClient.js.map