/**
 * ToolResultBudget — truncate oversized tool results to prevent context overflow.
 *
 * Mirrors CC's applyToolResultBudget (query.ts ~line 369-394).
 *
 * For each tool_result content block, if the content string exceeds the tool's
 * maxResultSizeChars, truncate it and append a note.
 */
import type { KernelMessage } from '../types/KernelMessage.js';
import type { KernelTool } from '../types/KernelTool.js';
/**
 * Apply tool result budget to a message array.
 * Returns a new message array with oversized tool results truncated.
 */
export declare function applyToolResultBudget(messages: readonly KernelMessage[], tools: readonly KernelTool[]): KernelMessage[];
//# sourceMappingURL=ToolResultBudget.d.ts.map