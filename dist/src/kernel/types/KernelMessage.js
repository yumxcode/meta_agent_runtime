/** Create a minimal user message */
export function makeUserMessage(content, meta) {
    return {
        uuid: crypto.randomUUID(),
        role: 'user',
        content,
        ...meta,
    };
}
/** Create a minimal assistant message */
export function makeAssistantMessage(content, meta) {
    return {
        uuid: crypto.randomUUID(),
        role: 'assistant',
        content,
        ...meta,
    };
}
/** Compact boundary sentinel – treated as a system message in the loop */
export function makeCompactBoundaryMessage() {
    return {
        uuid: crypto.randomUUID(),
        role: 'user', // must have a role; we use user so API ignores it when sliced off
        content: [],
        isCompactBoundary: true,
        systemSubtype: 'compact_boundary',
    };
}
//# sourceMappingURL=KernelMessage.js.map