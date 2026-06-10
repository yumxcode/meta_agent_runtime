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

/** Default per-tool execution timeout — 3 minutes. */
const DEFAULT_TOOL_TIMEOUT_MS = 180_000

/**
 * Read META_AGENT_TOOL_TIMEOUT_MS lazily (mirrors getConcurrencyLimit pattern)
 * so tests / startup overrides both work. Returns the default 3 min when unset
 * or invalid. 0 disables the global timeout.
 *
 * This default lives in the kernel, so it applies to every KernelLoop —
 * including the ones sub-agents run — which is how the timeout mechanism
 * propagates into sub-agent tool calls.
 */
function getToolTimeoutMs(): number {
  const raw = process.env['META_AGENT_TOOL_TIMEOUT_MS']
  if (raw === undefined) return DEFAULT_TOOL_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_TOOL_TIMEOUT_MS
  return Math.max(0, parsed)
}

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

  // ── Execute (with per-tool timeout) ─────────────────────────────────────────
  // Per-tool timeout: tool.timeoutMs overrides; undefined → kernel default.
  // 0 / non-finite → no timeout (e.g. sub-agent-dispatch tools that await
  // completion, bounded by the sub-agent's own wall-clock cap instead).
  const effectiveTimeoutMs = tool.timeoutMs ?? getToolTimeoutMs()
  const useTimeout = Number.isFinite(effectiveTimeoutMs) && effectiveTimeoutMs > 0

  let timer: ReturnType<typeof setTimeout> | undefined
  let callContext = context
  let onParentAbort: (() => void) | undefined
  let timeoutController: AbortController | undefined

  if (useTimeout) {
    // Combine the parent abort signal with a timeout-driven controller so the
    // tool sees a single abortSignal that fires on either condition. This lets
    // abortSignal-aware tools (web_fetch, bash, sub-agent waits) actually stop.
    timeoutController = new AbortController()
    if (context.abortSignal.aborted) {
      timeoutController.abort()
    } else {
      onParentAbort = () => timeoutController!.abort()
      context.abortSignal.addEventListener('abort', onParentAbort, { once: true })
    }
    callContext = { ...context, abortSignal: timeoutController.signal }
  }

  try {
    const callPromise = tool.call(parsedInput, callContext)
    // Observe the race loser: when the timeout wins, callPromise keeps running
    // in the background (non-abort-aware tools ignore the signal). If it later
    // rejects, that would surface as an unhandledRejection — which long-running
    // hosts (the CLI registers process.on('unhandledRejection') → exit) treat
    // as fatal. A no-op catch keeps the rejection observed without affecting
    // the awaited race below.
    if (useTimeout) void callPromise.catch(() => {})
    const result = useTimeout
      ? await Promise.race([
          callPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timeoutController!.abort()
              reject(
                new Error(
                  `Tool "${toolName}" timed out after ${effectiveTimeoutMs}ms ` +
                  `(set tool.timeoutMs / META_AGENT_TOOL_TIMEOUT_MS to adjust).`,
                ),
              )
            }, effectiveTimeoutMs)
          }),
        ])
      : await callPromise

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
  } finally {
    if (timer) clearTimeout(timer)
    if (onParentAbort) context.abortSignal.removeEventListener('abort', onParentAbort)
  }
}
