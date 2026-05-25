/**
 * CompactConversation — summarise the conversation history via a fork agent.
 * Mirrors CC's compact.ts / compactConversation.
 *
 * Flow:
 *  1. Build compact prompt (9-section + custom instructions)
 *  2. Strip images from messages to avoid PTL in the compact request
 *  3. Call the compact model (fork agent, querySource='compact')
 *     - PTL retry loop: up to 3 attempts, each time dropping oldest messages
 *  4. Format the summary
 *  5. Build post-compact messages (boundary + summary + re-attach files)
 *  6. Return CompactionResult
 */
import Anthropic from '@anthropic-ai/sdk';
import { stripImagesFromMessages, normalizeMessagesForAPI } from '../messages/MessageNormalizer.js';
import { buildCompactPrompt, formatCompactSummary, extractCompactInstructions } from './CompactPrompt.js';
import { buildPostCompactMessages } from './PostCompact.js';
const COMPACT_MAX_PTL_RETRIES = 3;
const COMPACT_MODEL_DEFAULT = 'claude-haiku-4-5-20251001';
const COMPACT_MAX_TOKENS = 8_096;
/**
 * Run the compact summarisation.
 * Returns the CompactionResult (boundary + summary messages), or throws on failure.
 */
export async function compactConversation(messages, fileCache, options = {}) {
    const compactModel = options.model ?? COMPACT_MODEL_DEFAULT;
    // Extract custom instructions from system prompt if not explicitly provided
    const customInstructions = options.customInstructions ??
        (options.systemPrompt ? extractCompactInstructions(options.systemPrompt) : undefined);
    const compactSystemPrompt = buildCompactPrompt(customInstructions);
    // Strip images to avoid PTL in the compact request
    const stripped = stripImagesFromMessages(messages);
    // PTL retry loop: drop oldest messages on each failure
    let messagesToSummarise = [...stripped];
    let lastError;
    for (let attempt = 0; attempt < COMPACT_MAX_PTL_RETRIES; attempt++) {
        try {
            const summary = await callCompactModel(messagesToSummarise, compactSystemPrompt, compactModel, options);
            const formatted = formatCompactSummary(summary);
            return buildPostCompactMessages(formatted, fileCache);
        }
        catch (error) {
            if (isPromptTooLong(error) && messagesToSummarise.length > 2) {
                // Drop the oldest 20% of messages and retry
                const dropCount = Math.max(1, Math.floor(messagesToSummarise.length * 0.2));
                messagesToSummarise = messagesToSummarise.slice(dropCount);
                lastError = error;
                continue;
            }
            throw error;
        }
    }
    throw lastError ?? new Error('Compact failed: could not summarise conversation');
}
// ── Internal helpers ──────────────────────────────────────────────────────────
async function callCompactModel(messages, systemPrompt, model, options) {
    const client = new Anthropic({
        apiKey: options.apiKey ?? process.env['ANTHROPIC_API_KEY'],
        baseURL: options.baseURL,
        maxRetries: options.maxRetries ?? 2,
    });
    const apiMessages = normalizeMessagesForAPI(messages);
    const response = await client.messages.create({
        model,
        max_tokens: COMPACT_MAX_TOKENS,
        system: systemPrompt,
        messages: apiMessages,
        // No tools — the prompt explicitly forbids tool use
    }, {
        signal: options.abortSignal,
    });
    // Extract text content from the response
    const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
    if (!text.trim()) {
        throw new Error('Compact model returned empty response');
    }
    return text;
}
function isPromptTooLong(error) {
    if (!error || typeof error !== 'object')
        return false;
    const e = error;
    if (e['status'] === 400 && typeof e['message'] === 'string') {
        const msg = e['message'].toLowerCase();
        if (msg.includes('prompt is too long') || msg.includes('prompt_too_long'))
            return true;
    }
    if (typeof e['error'] === 'object' && e['error'] !== null) {
        const inner = e['error'];
        if (inner['type'] === 'prompt_too_long')
            return true;
    }
    return false;
}
//# sourceMappingURL=CompactConversation.js.map