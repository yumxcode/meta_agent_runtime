/**
 * Auto-compact for MetaAgentSession
 *
 * Monitors input token usage after each API response.  When the context
 * approaches the model's limit, compacts the conversation history into a
 * structured summary and replaces mutableMessages with a single user message
 * containing that summary.
 *
 * Compact trigger: input_tokens > contextWindow * 0.80 - maxOutputTokens
 *
 * After compaction:
 *   - mutableMessages is replaced with a single user message (the compact summary)
 *   - The session's SectionRegistry is invalidated so dynamic sections regenerate
 *   - The agentic loop continues normally on the next iteration
 */
import { getMetaAgentCompactPrompt, formatCompactSummary, } from './compactPrompt.js';
// ─────────────────────────────────────────────────────────────────────────────
// Context window sizes by model
// ─────────────────────────────────────────────────────────────────────────────
const CONTEXT_WINDOWS = {
    // Anthropic
    'claude-opus-4-6': 200_000,
    'claude-sonnet-4-6': 200_000,
    'claude-haiku-4-5-20251001': 200_000,
    // DeepSeek — 1M context window (api.deepseek.com/anthropic)
    'deepseek-v4-flash': 1_000_000, // DeepSeek-V3
    'deepseek-v4-pro': 1_000_000, // DeepSeek-R1
    'deepseek-v3': 1_000_000,
    'deepseek-r1': 1_000_000,
    // Qwen
    'qwen-max': 32_000,
    'qwen-plus': 131_072,
    'qwen-turbo': 131_072,
    // GLM
    'glm-4': 128_000,
    'glm-4-flash': 128_000,
};
const DEFAULT_CONTEXT_WINDOW = 100_000;
/** Reserve this many tokens for the compact summary output itself. */
const COMPACT_MAX_OUTPUT = 20_000;
/** Trigger compaction this many tokens before the hard limit. */
const COMPACT_BUFFER = 10_000;
// ─────────────────────────────────────────────────────────────────────────────
// Threshold calculation
// ─────────────────────────────────────────────────────────────────────────────
export function getCompactThreshold(model) {
    const window = CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
    return window - COMPACT_MAX_OUTPUT - COMPACT_BUFFER;
}
/**
 * Returns true if the current input token count exceeds the compact threshold
 * for the given model.
 */
export function shouldCompact(model, inputTokens) {
    return inputTokens >= getCompactThreshold(model);
}
/**
 * Run a compact pass over the current conversation history.
 *
 * Calls the API synchronously (no streaming needed — we just want the text).
 * Returns new messages that replace the full conversation history.
 *
 * On failure (API error, malformed output) throws — callers should catch and
 * decide whether to continue without compacting or abort.
 */
export async function runCompact(client, model, currentMessages, sessionId, abortSignal) {
    const compactPrompt = getMetaAgentCompactPrompt();
    // Convert internal message format to Anthropic API format
    const apiMessages = buildApiMessages(currentMessages);
    const response = await client.messages.create({
        model,
        max_tokens: COMPACT_MAX_OUTPUT,
        // System prompt is the compact task — no tools allowed
        system: compactPrompt,
        messages: apiMessages,
    }, { signal: abortSignal });
    const rawText = response.content
        .filter((b) => b.type === 'text')
        .map(b => b.text)
        .join('');
    if (!rawText.trim()) {
        throw new Error('Compact call returned empty response');
    }
    const formatted = formatCompactSummary(rawText);
    const summaryMessage = `This session was compacted to manage context length. ` +
        `The summary below covers the earlier portion of the conversation.\n\n` +
        formatted + '\n\n' +
        `Continue the conversation from where it left off. ` +
        `Do not acknowledge the compaction or recap what happened — resume directly.`;
    const newMessages = [
        { role: 'user', content: summaryMessage },
    ];
    return { newMessages, summaryText: formatted };
}
// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────
function buildApiMessages(messages) {
    const result = [];
    for (const msg of messages) {
        if (msg.role === 'user') {
            if (typeof msg.content === 'string') {
                result.push({ role: 'user', content: msg.content });
            }
            else {
                const blocks = msg.content
                    .filter((b) => b.type === 'tool_result')
                    .map(b => ({
                    type: 'tool_result',
                    tool_use_id: b.tool_use_id,
                    content: b.content,
                    ...(b.is_error ? { is_error: true } : {}),
                }));
                if (blocks.length > 0) {
                    result.push({ role: 'user', content: blocks });
                }
            }
        }
        else {
            const blocks = msg.content.map(b => {
                if (b.type === 'text')
                    return { type: 'text', text: b.text };
                if (b.type === 'tool_use')
                    return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
                return { type: 'text', text: JSON.stringify(b) };
            });
            result.push({ role: 'assistant', content: blocks });
        }
    }
    return result;
}
//# sourceMappingURL=autoCompact.js.map