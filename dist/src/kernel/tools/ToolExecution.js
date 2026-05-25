import { makeToolResultMessage } from '../messages/MessageFactory.js';
/**
 * Execute a single tool call.
 * Handles permission checks, input parsing, execution, error wrapping.
 */
export async function executeToolCall(request, tool, context, canUseTool) {
    const { toolUseId, toolName, input, assistantMessageUuid } = request;
    // ── Tool not found ────────────────────────────────────────────────────────
    if (!tool) {
        const errorMsg = `Tool "${toolName}" not found.`;
        return {
            toolUseId,
            toolName,
            resultMessage: makeToolResultMessage(toolUseId, errorMsg, true, assistantMessageUuid),
            extraMessages: [],
        };
    }
    // ── Permission check ─────────────────────────────────────────────────────
    const permResult = await canUseTool(tool, input, assistantMessageUuid, toolUseId, context);
    if (permResult.behavior === 'deny') {
        const denial = {
            toolName,
            toolUseId,
            reason: permResult.reason,
            timestamp: Date.now(),
        };
        const denyMsg = `Permission denied: ${permResult.reason}`;
        return {
            toolUseId,
            toolName,
            resultMessage: makeToolResultMessage(toolUseId, denyMsg, true, assistantMessageUuid),
            extraMessages: [],
            permissionDenial: denial,
        };
    }
    if (permResult.behavior === 'redirect') {
        return {
            toolUseId,
            toolName,
            resultMessage: makeToolResultMessage(toolUseId, permResult.message, false, assistantMessageUuid),
            extraMessages: [],
        };
    }
    // ── Input parsing ─────────────────────────────────────────────────────────
    const parseResult = tool.inputSchema.safeParse(input);
    const parsedInput = parseResult.success ? parseResult.data : input;
    // ── Execute ───────────────────────────────────────────────────────────────
    try {
        const result = await tool.call(parsedInput, context);
        const contentStr = typeof result.data === 'string'
            ? result.data
            : JSON.stringify(result.data);
        const resultMessage = makeToolResultMessage(toolUseId, contentStr, result.isError ?? false, assistantMessageUuid);
        return {
            toolUseId,
            toolName,
            resultMessage,
            extraMessages: result.newMessages ?? [],
            contextModifier: result.contextModifier,
        };
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
            toolUseId,
            toolName,
            resultMessage: makeToolResultMessage(toolUseId, `Tool execution error: ${errorMsg}`, true, assistantMessageUuid),
            extraMessages: [],
        };
    }
}
//# sourceMappingURL=ToolExecution.js.map