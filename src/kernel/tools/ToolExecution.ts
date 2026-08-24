/**
 * ToolExecution — execute a single tool call and produce a tool_result message.
 * Mirrors CC's toolExecution.ts.
 */
import type { KernelTool, KernelToolContext, KernelToolControl, KernelToolExecutionMetadata } from '../types/KernelTool.js'
import type { KernelMessage } from '../types/KernelMessage.js'
import type { CanUseToolFn, PermissionDecisionSource } from '../types/KernelConfig.js'
import type { PermissionDenial } from '../types/KernelEvent.js'
import { makeToolResultMessage } from '../messages/MessageFactory.js'
import { RuntimeEnv } from '../../infra/env/RuntimeEnv.js'
import { timeout } from '../../core/timeouts.js'

const TRUNCATION_NOTICE =
  '\n\n[Content truncated: result exceeded maximum allowed size. ' +
  'Use a more targeted request to retrieve specific information.]'

/** Default per-tool execution timeout — 3 minutes. */
const DEFAULT_TOOL_TIMEOUT_MS = 180_000
const DEFAULT_MAX_TIMED_OUT_RUNNING_TOOLS = 3

const timedOutRunningBySession = new Map<string, number>()

function getMaxTimedOutRunningTools(): number {
  return RuntimeEnv.maxTimedOutRunningTools(DEFAULT_MAX_TIMED_OUT_RUNNING_TOOLS)
}

function incrementTimedOutRunning(sessionId: string): void {
  timedOutRunningBySession.set(
    sessionId,
    (timedOutRunningBySession.get(sessionId) ?? 0) + 1,
  )
}

function decrementTimedOutRunning(sessionId: string): void {
  const next = (timedOutRunningBySession.get(sessionId) ?? 1) - 1
  if (next <= 0) timedOutRunningBySession.delete(sessionId)
  else timedOutRunningBySession.set(sessionId, next)
}

/** Test/observability hook for the auto-mode timeout circuit. */
export function getTimedOutRunningToolCount(sessionId: string): number {
  return timedOutRunningBySession.get(sessionId) ?? 0
}

/** Drop a session's counter during teardown; late promises may safely decrement from zero. */
export function clearTimedOutRunningTools(sessionId: string): void {
  timedOutRunningBySession.delete(sessionId)
}

/**
 * Resolve the per-tool timeout lazily so config-file / env / startup overrides
 * all take effect. Precedence is config file (`timeouts.toolMs`) > env
 * (META_AGENT_TOOL_TIMEOUT_MS) > 3 min. `0` disables the global timeout.
 *
 * This lives in the kernel, so it applies to every KernelLoop — including the
 * ones sub-agents run — which is how the mechanism propagates into sub-agent
 * tool calls.
 */
function getToolTimeoutMs(): number {
  return timeout('toolMs')
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
  control?: KernelToolControl
  outcome: ToolExecutionOutcome
}

export interface ToolExecutionOutcome {
  toolUseId: string
  toolName: string
  input: unknown
  durationMs: number
  isError: boolean
  permissionDecision?: {
    decision: 'allow' | 'deny' | 'redirect'
    decidedBy: PermissionDecisionSource
    reason?: string
  }
  execution?: KernelToolExecutionMetadata
  trajectoryItems?: import('../../trajectory/types.js').TrajectoryItem[]
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
  const startedAt = Date.now()
  const outcome = (
    isError: boolean,
    extra: Partial<Omit<ToolExecutionOutcome, 'toolUseId' | 'toolName' | 'input' | 'durationMs' | 'isError'>> = {},
  ): ToolExecutionOutcome => ({
    toolUseId,
    toolName,
    input,
    durationMs: Math.max(0, Date.now() - startedAt),
    isError,
    ...extra,
  })

  // ── Tool not found ────────────────────────────────────────────────────────
  if (!tool) {
    const errorMsg = `Tool "${toolName}" not found.`
    return {
      toolUseId,
      toolName,
      resultMessage: makeToolResultMessage(toolUseId, errorMsg, true, assistantMessageUuid),
      extraMessages: [],
      outcome: outcome(true),
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
      outcome: outcome(true, {
        permissionDecision: {
          decision: 'deny',
          decidedBy: permResult.decidedBy ?? 'policy',
          reason: permResult.reason,
        },
      }),
    }
  }
  if (permResult.behavior === 'redirect') {
    return {
      toolUseId,
      toolName,
      resultMessage: makeToolResultMessage(toolUseId, permResult.message, false, assistantMessageUuid),
      extraMessages: [],
      outcome: outcome(false, {
        permissionDecision: {
          decision: 'redirect',
          decidedBy: permResult.decidedBy ?? 'policy',
          reason: permResult.message,
        },
      }),
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
      outcome: outcome(true),
    }
  }
  const parsedInput = parseResult.data

  if (
    context.autonomousMode &&
    (!tool.abortSupport || tool.abortSupport === 'non_cooperative')
  ) {
    return {
      toolUseId,
      toolName,
      resultMessage: makeToolResultMessage(
        toolUseId,
        `Tool "${toolName}" does not have an auto-safe abortSupport contract ` +
        `(${tool.abortSupport ?? 'undeclared'}) and is disabled in auto mode.`,
        true,
        assistantMessageUuid,
      ),
      extraMessages: [],
      outcome: outcome(true),
    }
  }

  const maxTimedOutRunning = getMaxTimedOutRunningTools()
  const timedOutRunning = getTimedOutRunningToolCount(context.sessionId)
  if (context.autonomousMode && timedOutRunning >= maxTimedOutRunning) {
    return {
      toolUseId,
      toolName,
      resultMessage: makeToolResultMessage(
        toolUseId,
        `Auto tool circuit open: ${timedOutRunning} timed-out tool call(s) are still running ` +
        `(limit ${maxTimedOutRunning}). Wait for them to settle or resume in a fresh process.`,
        true,
        assistantMessageUuid,
      ),
      extraMessages: [],
      outcome: outcome(true),
    }
  }

  // ── Execute (with per-tool timeout) ─────────────────────────────────────────
  // Per-tool timeout: tool.timeoutMs overrides; undefined → kernel default.
  // 0 / non-finite → no timeout (e.g. sub-agent-dispatch tools that await
  // completion, bounded by the sub-agent's own wall-clock cap instead).
  const effectiveTimeoutMs = tool.timeoutMs ?? getToolTimeoutMs()
  const useTimeout = Number.isFinite(effectiveTimeoutMs) && effectiveTimeoutMs > 0

  let timer: ReturnType<typeof setTimeout> | undefined
  let callContext: KernelToolContext = { ...context, toolUseId }
  let onParentAbort: (() => void) | undefined
  let timeoutController: AbortController | undefined
  let registeredAsTimedOutRunning = false
  let callSettled = false

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
    callContext = { ...context, toolUseId, abortSignal: timeoutController.signal }
  }

  try {
    const callPromise = tool.call(parsedInput, callContext)
    void callPromise.then(
      () => {
        callSettled = true
        if (registeredAsTimedOutRunning) decrementTimedOutRunning(context.sessionId)
      },
      () => {
        callSettled = true
        if (registeredAsTimedOutRunning) decrementTimedOutRunning(context.sessionId)
      },
    )
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
              if (!callSettled) {
                registeredAsTimedOutRunning = true
                incrementTimedOutRunning(context.sessionId)
              }
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
      control: result.control,
      outcome: outcome(result.isError ?? false, {
        permissionDecision: { decision: 'allow', decidedBy: permResult.decidedBy ?? 'policy' },
        execution: result.execution,
        trajectoryItems: result.trajectoryItems,
      }),
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
      outcome: outcome(true, {
        permissionDecision: { decision: 'allow', decidedBy: permResult.decidedBy ?? 'policy' },
        execution: {
          command: typeof input === 'object' && input !== null && typeof (input as Record<string, unknown>)['command'] === 'string'
            ? (input as Record<string, unknown>)['command'] as string
            : undefined,
          cwd: typeof input === 'object' && input !== null && typeof (input as Record<string, unknown>)['cwd'] === 'string'
            ? (input as Record<string, unknown>)['cwd'] as string
            : undefined,
          timedOut: errorMsg.includes('timed out'),
          aborted: context.abortSignal.aborted,
        },
      }),
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (onParentAbort) context.abortSignal.removeEventListener('abort', onParentAbort)
  }
}
