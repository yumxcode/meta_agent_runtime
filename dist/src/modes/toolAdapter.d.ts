/**
 * toolAdapter — MetaAgentTool → KernelTool bridge.
 *
 * This is the only place that knows about both type worlds.
 * All other modes/ files import from here.
 */
import type { MetaAgentTool } from '../core/types.js';
import type { KernelTool } from '../kernel/index.js';
export declare function toKernelTool(tool: MetaAgentTool, extraExtensions?: Record<string, unknown>): KernelTool;
/**
 * Convert an array of MetaAgentTools, preserving registration order.
 */
export declare function toKernelTools(tools: MetaAgentTool[], extraExtensions?: Record<string, unknown>): KernelTool[];
//# sourceMappingURL=toolAdapter.d.ts.map