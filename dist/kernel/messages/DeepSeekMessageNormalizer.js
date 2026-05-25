// ── Normalizer ────────────────────────────────────────────────────────────────
/**
 * Convert KernelMessages + optional systemPrompt to DeepSeek / OpenAI format.
 *
 * Conversion rules:
 *   assistant.thinking   → reasoning_content (always echoed)
 *   assistant.text       → content
 *   assistant.tool_use   → tool_calls: [{ id, type, function }]
 *   user.text            → { role: 'user', content: text }
 *   user.tool_result     → { role: 'tool', tool_call_id, content }
 *   user.image           → skipped (no text equivalent)
 *   compact_boundary     → skipped
 */
export function normalizeMessagesForDeepSeek(messages, systemPrompt) {
    const result = [];
    if (systemPrompt) {
        result.push({ role: 'system', content: systemPrompt });
    }
    for (const msg of messages) {
        if (msg.isCompactBoundary || msg.content.length === 0)
            continue;
        if (msg.role === 'user') {
            const pendingText = [];
            for (const block of msg.content) {
                if (block.type === 'tool_result') {
                    // Flush any pending text as a user message before tool results
                    if (pendingText.length > 0) {
                        result.push({ role: 'user', content: pendingText.join('') });
                        pendingText.length = 0;
                    }
                    // Each tool_result becomes its own 'tool' message
                    const content = toolResultContent(block.content);
                    result.push({
                        role: 'tool',
                        tool_call_id: block.tool_use_id,
                        content,
                    });
                }
                else if (block.type === 'text') {
                    pendingText.push(block.text);
                }
                // Silently skip image blocks — no text mapping available
            }
            if (pendingText.length > 0) {
                result.push({ role: 'user', content: pendingText.join('') });
            }
        }
        else {
            // assistant message
            let reasoning = '';
            let text = '';
            const toolCalls = [];
            for (const block of msg.content) {
                switch (block.type) {
                    case 'thinking':
                        reasoning += block.thinking;
                        break;
                    case 'text':
                        text += block.text;
                        break;
                    case 'tool_use':
                        toolCalls.push({
                            id: block.id,
                            type: 'function',
                            function: {
                                name: block.name,
                                arguments: JSON.stringify(block.input ?? {}),
                            },
                        });
                        break;
                    // redacted_thinking → skip (no DeepSeek equivalent)
                }
            }
            const assistantMsg = {
                role: 'assistant',
                content: text || null,
            };
            if (reasoning) {
                assistantMsg.reasoning_content = reasoning;
            }
            if (toolCalls.length > 0) {
                assistantMsg.tool_calls = toolCalls;
            }
            result.push(assistantMsg);
        }
    }
    // OpenAI API requires the first message to be 'system' or 'user', not 'tool'
    const firstNonSystem = result.find(m => m.role !== 'system');
    if (firstNonSystem && firstNonSystem.role === 'tool') {
        const sysIdx = result.findIndex(m => m.role === 'system');
        result.splice(sysIdx + 1, 0, { role: 'user', content: '' });
    }
    return result;
}
function toolResultContent(raw) {
    if (typeof raw === 'string')
        return raw;
    if (Array.isArray(raw)) {
        return raw
            .filter(c => c.type === 'text' && typeof c.text === 'string')
            .map(c => c.text)
            .join('');
    }
    return '';
}
//# sourceMappingURL=DeepSeekMessageNormalizer.js.map