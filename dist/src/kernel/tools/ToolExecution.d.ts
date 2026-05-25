/**
 * ToolExecution — execute a single tool call and produce a tool_result message.
 * Mirrors CC's toolExecution.ts.
 */
import type { KernelTool, KernelToolContext } from '../types/KernelTool.js';
import type { KernelMessage } from '../types/KernelMessage.js';
import type { CanUseToolFn } from '../types/KernelConfig.js';
import type { PermissionDenial } from '../types/KernelEvent.js';
export interface ToolCallRequest {
    toolUseId: string;
    toolName: string;
    input: unknown;
    assistantMessageUuid: string;
}
export interface ToolCallResult {
    toolUseId: string;
    toolName: string;
    resultMessage: KernelMessage;
    extraMessages: KernelMessage[];
    permissionDenial?: PermissionDenial;
    contextModifier?: (ctx: KernelToolContext) => KernelToolContext;
}
/**
 * Execute a single tool call.
 * Handles permission checks, input parsing, execution, error wrapping.
 */
export declare function executeToolCall(request: ToolCallRequest, tool: KernelTool | undefined, context: KernelToolContext, canUseTool: CanUseToolFn): Promise<ToolCallResult>;
//# sourceMappingURL=ToolExecution.d.ts.map