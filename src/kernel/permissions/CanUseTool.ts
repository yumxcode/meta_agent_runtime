/**
 * CanUseTool — permission gate called before each tool execution.
 *
 * CC has a full PermissionMode system (default/plan/auto/bypass) with hooks.
 * We expose a simple async function interface; the default implementation
 * always allows. Mode layers (plan mode, etc.) inject their own implementation
 * via KernelConfig.canUseTool.
 */
import type { KernelTool } from '../types/KernelTool.js'
import type { CanUseToolFn, CanUseToolResult } from '../types/KernelConfig.js'

export { type CanUseToolFn, type CanUseToolResult }

/** Default permission gate — always allows all tool calls */
export const defaultCanUseTool: CanUseToolFn = async (
  _tool: KernelTool,
  _input: unknown,
  _assistantMessageUuid: string,
  _toolUseId: string,
  _context,
): Promise<CanUseToolResult> => {
  return { behavior: 'allow' }
}
