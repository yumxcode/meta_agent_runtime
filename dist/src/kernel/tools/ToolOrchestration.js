import { executeToolCall } from './ToolExecution.js';
const MAX_CONCURRENT_TOOLS = parseInt(process.env['CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY'] ?? '10', 10);
// ── partitionToolCalls — mirrors CC's exact algorithm ────────────────────────
/**
 * Partition tool call requests into serial/parallel batches.
 *
 * IMPORTANT — must match CC's algorithm exactly:
 * - safeParse failure → non-safe (no throw)
 * - isConcurrencySafe() throw → non-safe (try/catch)
 * - consecutive safe tools → merged into one batch
 */
export function partitionToolCalls(requests, tools) {
    return requests.reduce((acc, request) => {
        const tool = tools.find(t => t.name === request.toolName || (t.aliases ?? []).includes(request.toolName));
        const parseResult = tool?.inputSchema.safeParse(request.input);
        const isConcurrencySafe = parseResult?.success
            ? (() => {
                try {
                    return Boolean(tool.isConcurrencySafe(parseResult.data));
                }
                catch {
                    return false;
                }
            })()
            : false;
        const last = acc[acc.length - 1];
        if (isConcurrencySafe && last?.isConcurrencySafe) {
            last.requests.push(request);
        }
        else {
            acc.push({ isConcurrencySafe, requests: [request] });
        }
        return acc;
    }, []);
}
/**
 * Execute all tool calls in the provided requests, respecting serial/parallel ordering.
 * Returns tool result messages in the same order as the original requests.
 */
export async function runTools(requests, tools, context, canUseTool) {
    if (requests.length === 0) {
        return { toolResultMessages: [], extraMessages: [], permissionDenials: [], finalContext: context };
    }
    const batches = partitionToolCalls(requests, tools);
    // Maintain ordered results keyed by toolUseId
    const orderedResults = new Map();
    const permissionDenials = [];
    let currentContext = context;
    for (const batch of batches) {
        if (batch.isConcurrencySafe) {
            // ── Parallel batch ─────────────────────────────────────────────────────
            // Limit concurrency
            const chunks = [];
            for (let i = 0; i < batch.requests.length; i += MAX_CONCURRENT_TOOLS) {
                chunks.push(batch.requests.slice(i, i + MAX_CONCURRENT_TOOLS));
            }
            for (const chunk of chunks) {
                const results = await Promise.all(chunk.map(req => {
                    const tool = findTool(tools, req.toolName);
                    return executeToolCall(req, tool, currentContext, canUseTool);
                }));
                for (const result of results) {
                    orderedResults.set(result.toolUseId, result);
                    if (result.permissionDenial)
                        permissionDenials.push(result.permissionDenial);
                }
                // Apply context modifiers in original request order
                for (const req of chunk) {
                    const result = orderedResults.get(req.toolUseId);
                    if (result.contextModifier) {
                        currentContext = result.contextModifier(currentContext);
                    }
                }
            }
        }
        else {
            // ── Serial batch ──────────────────────────────────────────────────────
            for (const req of batch.requests) {
                const tool = findTool(tools, req.toolName);
                const result = await executeToolCall(req, tool, currentContext, canUseTool);
                orderedResults.set(result.toolUseId, result);
                if (result.permissionDenial)
                    permissionDenials.push(result.permissionDenial);
                // Apply context modifier immediately after each serial tool
                if (result.contextModifier) {
                    currentContext = result.contextModifier(currentContext);
                }
            }
        }
    }
    // Reconstruct results in original request order
    const toolResultMessages = [];
    const extraMessages = [];
    for (const req of requests) {
        const result = orderedResults.get(req.toolUseId);
        if (result) {
            toolResultMessages.push(result.resultMessage);
            extraMessages.push(...result.extraMessages);
        }
    }
    return { toolResultMessages, extraMessages, permissionDenials, finalContext: currentContext };
}
// ── yieldMissingToolResultBlocks ─────────────────────────────────────────────
/**
 * When streaming is interrupted before tool execution, generate error
 * tool_result messages for any tool_use blocks that never got results.
 * Mirrors CC's yieldMissingToolResultBlocks.
 */
import { makeToolResultMessage } from '../messages/MessageFactory.js';
export function buildMissingToolResultMessages(assistantMessages, errorMessage) {
    const results = [];
    for (const msg of assistantMessages) {
        for (const block of msg.content) {
            if (block.type === 'tool_use') {
                results.push(makeToolResultMessage(block.id, errorMessage, true, msg.uuid));
            }
        }
    }
    return results;
}
// ── helpers ───────────────────────────────────────────────────────────────────
function findTool(tools, name) {
    return tools.find(t => t.name === name || (t.aliases ?? []).includes(name));
}
//# sourceMappingURL=ToolOrchestration.js.map