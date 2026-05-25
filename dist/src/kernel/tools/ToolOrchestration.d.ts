/**
 * ToolOrchestration — parallel/serial batch scheduling for tool calls.
 * Mirrors CC's toolOrchestration.ts / partitionToolCalls.
 *
 * Key algorithm:
 *   - Consecutive concurrency-safe tools → one batch, run with Promise.all
 *   - Non-safe tools → individual batches, run serially
 *   - contextModifiers applied: serially after each tool; concurrently after batch
 */
import type { KernelTool, KernelToolContext } from '../types/KernelTool.js';
import type { KernelMessage } from '../types/KernelMessage.js';
import type { CanUseToolFn } from '../types/KernelConfig.js';
import type { PermissionDenial } from '../types/KernelEvent.js';
import { type ToolCallRequest } from './ToolExecution.js';
interface Batch {
    isConcurrencySafe: boolean;
    requests: ToolCallRequest[];
}
/**
 * Partition tool call requests into serial/parallel batches.
 *
 * IMPORTANT — must match CC's algorithm exactly:
 * - safeParse failure → non-safe (no throw)
 * - isConcurrencySafe() throw → non-safe (try/catch)
 * - consecutive safe tools → merged into one batch
 */
export declare function partitionToolCalls(requests: ToolCallRequest[], tools: readonly KernelTool[]): Batch[];
export interface RunToolsResult {
    toolResultMessages: KernelMessage[];
    extraMessages: KernelMessage[];
    permissionDenials: PermissionDenial[];
    finalContext: KernelToolContext;
}
/**
 * Execute all tool calls in the provided requests, respecting serial/parallel ordering.
 * Returns tool result messages in the same order as the original requests.
 */
export declare function runTools(requests: ToolCallRequest[], tools: readonly KernelTool[], context: KernelToolContext, canUseTool: CanUseToolFn): Promise<RunToolsResult>;
export declare function buildMissingToolResultMessages(assistantMessages: KernelMessage[], errorMessage: string): KernelMessage[];
export {};
//# sourceMappingURL=ToolOrchestration.d.ts.map