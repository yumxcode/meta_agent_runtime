/**
 * Convert a KernelMessage's content to Anthropic API content format.
 * Thinking/redacted_thinking blocks are passed through as-is (the SDK accepts them).
 */
function toAPIContent(content) {
    return content;
}
/**
 * Convert KernelMessages to Anthropic API MessageParams.
 *
 * Rules:
 * - Skip compact boundary markers (isCompactBoundary) — they're metadata only
 * - Skip empty-content messages
 * - Merge consecutive same-role messages (required by Anthropic API)
 */
export function normalizeMessagesForAPI(messages) {
    const filtered = messages.filter(m => !m.isCompactBoundary && m.content.length > 0);
    if (filtered.length === 0)
        return [];
    // Merge consecutive same-role messages.
    // IMPORTANT: always create new content arrays — never push into the existing
    // array in-place. The same KernelMessage objects persist in mutableMessages
    // across turns; mutating msg.content would cause duplicate tool_result blocks
    // on subsequent normalizeMessagesForAPI calls.
    const merged = [];
    for (const msg of filtered) {
        const last = merged[merged.length - 1];
        if (last && last.role === msg.role) {
            const prev = last.content;
            const next = toAPIContent(msg.content);
            merged[merged.length - 1] = {
                role: last.role,
                content: Array.isArray(prev)
                    ? [...prev, ...next]
                    : [{ type: 'text', text: prev }, ...next],
            };
        }
        else {
            // Shallow-copy so later merges don't mutate the original KernelMessage
            merged.push({ role: msg.role, content: [...toAPIContent(msg.content)] });
        }
    }
    // API requires first message to be user
    if (merged.length > 0 && merged[0].role !== 'user') {
        merged.unshift({ role: 'user', content: [{ type: 'text', text: '' }] });
    }
    return merged;
}
/** Remove provider/model-bound thinking blocks before cross-model fallback. */
export function stripThinkingBlocksFromMessages(messages) {
    return messages.map(msg => ({
        ...msg,
        content: msg.content.filter(block => block.type !== 'thinking' && block.type !== 'redacted_thinking'),
    }));
}
/**
 * Get the slice of messages after the most recent compact boundary.
 * This is what gets sent to the API — the model only sees summary + recent context.
 */
export function getMessagesAfterCompactBoundary(messages) {
    let boundaryIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].isCompactBoundary) {
            boundaryIdx = i;
            break;
        }
    }
    if (boundaryIdx === -1)
        return messages;
    return messages.slice(boundaryIdx); // include the boundary itself for slicing context
}
/**
 * Strip image and document content from messages before sending them to the
 * compact summarisation agent. Large blobs would cause PTL in the compact request.
 */
export function stripImagesFromMessages(messages) {
    return messages.map(msg => {
        const strippedContent = msg.content.map(block => {
            if (block.type === 'image') {
                return { type: 'text', text: '[image]' };
            }
            // tool_result can contain images inside its content array
            if (block.type === 'tool_result' && Array.isArray(block.content)) {
                return {
                    ...block,
                    content: block.content.map(inner => inner.type === 'image' ? { type: 'text', text: '[image]' } : inner),
                };
            }
            return block;
        });
        return { ...msg, content: strippedContent };
    });
}
//# sourceMappingURL=MessageNormalizer.js.map