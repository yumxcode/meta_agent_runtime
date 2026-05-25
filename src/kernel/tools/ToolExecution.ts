/**
 * ToolExecution — execute a single tool call and produce a tool_result message.
 * Mirrors CC's toolExecution.ts.
 */
import type { KernelTool, KernelToolContext } from '../types/KernelTool.js'
import type { KernelMessage } from '../types/KernelMessage.js'
import type { CanUseToolFn } from '../types/KernelConfig.js'
import type { PermissionDenial } from '../types/KernelEvent.js'
import { makeToolResultMessage } from '../messages/MessageFactory.js'

const TRUNCATION_NOTICE =
  '\n\n[Content truncated: result exceeded maximum allowed size. ' +
  'Use a more targeted request to retrieve specific information.]'

function truncateString(value: string, maxChars: number | undefined): string {
  if (maxChars === undefined || !Number.isFinite(maxChars) || value.length <= maxChars) return value
  return value.slice(0, maxChars) + TRUNCATION_NOTICE
}

export interface ToolCallRequest {
  toolUseId: string
  toolName: string
  input: unknown
  assistantMessageUuid: string
}

export interface ToolCallResult {
  toolUseId: string
  toolName: string
  resultMessage: KernelMessage
  extraMessages: KernelMessage[]
  permissionDenial?: PermissionDenial
  contextModifier?: (ctx: KernelToolContext) => KernelToolContext
}

/**
 * Execute a single tool call.
 * Handles permission checks, input parsing, execution, error wrapping.
 */
export async function executeToolCall(
  request: ToolCallRequest,
  tool: KernelTool | undefined,
  context: KernelToolContext,
  canUseTool: CanUseToolFn,
): Promise<ToolCallResult> {
  const { toolUseId, toolName, input, assistantMessageUuid } = request

  // ── Tool not found ────────────────────────────────────────────────────────
  if (!tool) {
    const errorMsg = `Tool "${toolName}" not found.`
    return {
      toolUseId,
      toolName,
      resultMessage: makeToolResultMessage(toolUseId, errorMsg, true, assistantMessageUuid),
      extraMessages: [],
    }
  }

  // ── Permission check ─────────────────────────────────────────────────────
  const permResult = await canUseTool(tool, input, assistantMessageUuid, toolUseId, context)
  if (permResult.behavior === 'deny') {
    const denial: PermissionDenial = {
      toolName,
      toolUseId,
      reason: permResult.reason,
      timestamp: Date.now(),
    }
    const denyMsg = `Permission denied: ${permResult.reason}`
    return {
      toolUseId,
      toolName,
      resultMessage: makeToolResultMessage(toolUseId, denyMsg, true, assistantMessageUuid),
      extraMessages: [],
      permissionDenial: denial,
    }
  }
  if (permResult.behavior === 'redirect') {
    return {
      toolUseId,
      toolName,
      resultMessage: makeToolResultMessage(toolUseId, permResult.message, false, assistantMessageUuid),
      extraMessages: [],
    }
  }

  // ── Input parsing ─────────────────────────────────────────────────────────
  const parseResult = tool.inputSchema.safeParse(input)
  if (!parseResult.success) {
    const errorMsg = typeof parseResult.error === 'string'
      ? parseResult.error
      : JSON.stringify(parseResult.error)
    return {
      toolUseId,
      toolName,
      resultMessage: makeToolResultMessage(
        toolUseId,
        `Invalid tool input for "${toolName}": ${errorMsg}`,
        true,
        assistantMessageUuid,
      ),
      extraMessages: [],
    }
  }
  const parsedInput = parseResult.data

  // ── Execute ───────────────────────────────────────────────────────────────
  try {
    const result = await tool.call(parsedInput, context)

    const rawContentStr =
      typeof result.data === 'string'
        ? result.data
        : JSON.stringify(result.data)
    const contentStr = truncateString(rawContentStr, tool.maxResultSizeChars)

    const resultMessage = makeToolResultMessage(
      toolUseId,
      contentStr,
      result.isError ?? false,
      assistantMessageUuid,
    )

    return {
      toolUseId,
      toolName,
      resultMessage,
      extraMessages: result.newMessages ?? [],
      contextModifier: result.contextModifier,
    }
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : String(error)
    return {
      toolUseId,
      toolName,
      resultMessage: makeToolResultMessage(
        toolUseId,
        `Tool execution error: ${errorMsg}`,
        true,
        assistantMessageUuid,
      ),
      extraMessages: [],
    }
  }
}
