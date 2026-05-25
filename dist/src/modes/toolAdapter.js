// ── JSON Schema → Zod-compatible safeParse ────────────────────────────────────
//
// The kernel only needs safeParse() to decide concurrency safety.
// We implement a simple object-level check rather than full JSON Schema eval.
function buildZodCompatSchema(jsonSchema) {
    return {
        safeParse(input) {
            if (typeof input !== 'object' || input === null) {
                return { success: false, error: 'Not an object' };
            }
            return { success: true, data: input };
        },
    };
}
// ── Context bridge: KernelToolContext → ToolCallContext ───────────────────────
function toToolCallContext(ctx, extraExtensions) {
    const ext = { ...ctx.extensions, ...extraExtensions };
    return {
        sessionId: ctx.sessionId,
        agentId: ctx.agentId ?? ctx.sessionId,
        abortSignal: ctx.abortSignal,
        workspaceRoot: ctx.workspaceRoot,
        jobManager: ext['jobManager'],
        vvChain: ext['vvChain'],
        provenanceTracker: ext['provenanceTracker'],
        askUser: ctx.askUser,
        onMessage: ext['onMessage'],
        planMode: ctx.planMode,
    };
}
// ── The main adapter ──────────────────────────────────────────────────────────
export function toKernelTool(tool, extraExtensions) {
    // Resolve description: if it's a function we return a plain string wrapper
    const description = typeof tool.description === 'string'
        ? tool.description
        : `[${tool.name}]`; // fallback — dynamic descriptions resolved at session level
    return {
        name: tool.name,
        description,
        inputSchema: buildZodCompatSchema(tool.inputSchema),
        inputJSONSchema: tool.inputSchema,
        permission: tool.permission,
        async call(input, ctx) {
            const callCtx = toToolCallContext(ctx, extraExtensions);
            const result = await tool.call(input, callCtx);
            return {
                data: result.content,
                isError: result.isError,
            };
        },
        isConcurrencySafe(_parsedInput) {
            return tool.isConcurrencySafe ?? false;
        },
        // MetaAgentTool has no maxResultSizeChars — no truncation
        maxResultSizeChars: undefined,
    };
}
/**
 * Convert an array of MetaAgentTools, preserving registration order.
 */
export function toKernelTools(tools, extraExtensions) {
    return tools.map(t => toKernelTool(t, extraExtensions));
}
//# sourceMappingURL=toolAdapter.js.map