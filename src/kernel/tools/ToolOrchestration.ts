/**
 * ToolOrchestration — parallel/serial batch scheduling for tool calls.
 * Mirrors CC's toolOrchestration.ts / partitionToolCalls.
 *
 * Key algorithm:
 *   - Consecutive concurrency-safe tools → one batch, run with Promise.all
 *   - Non-safe tools → individual batches, run serially
 *   - contextModifiers applied: serially after each tool; concurrently after batch
 */
import type { KernelTool, KernelToolContext, KernelToolControl } from '../types/KernelTool.js'
import type { KernelMessage } from '../types/KernelMessage.js'
import type { CanUseToolFn } from '../types/KernelConfig.js'
import type { PermissionDenial } from '../types/KernelEvent.js'
import { executeToolCall, type ToolCallRequest, type ToolCallResult, type ToolExecutionOutcome } from './ToolExecution.js'
import { RuntimeEnv } from '../../infra/env/RuntimeEnv.js'

/**
 * Read the concurrency limit lazily on each call so that:
 *   1. Tests can set process.env after importing this module and see the change.
 *   2. Production code that sets the env var at startup still works (reads on first use).
 *
 * Clamped to [1, 64] to match CC's behaviour.
 */
function getConcurrencyLimit(): number {
  return RuntimeEnv.toolUseConcurrency(10)
}

// ── Batch types ───────────────────────────────────────────────────────────────

interface Batch {
  isConcurrencySafe: boolean
  requests: ToolCallRequest[]
}

// ── partitionToolCalls — mirrors CC's exact algorithm ────────────────────────

/**
 * Partition tool call requests into serial/parallel batches.
 *
 * IMPORTANT — must match CC's algorithm exactly:
 * - safeParse failure → non-safe (no throw)
 * - isConcurrencySafe() throw → non-safe (try/catch)
 * - consecutive safe tools → merged into one batch
 */
export function partitionToolCalls(
  requests: ToolCallRequest[],
  tools: readonly KernelTool[],
): Batch[] {
  return requests.reduce((acc: Batch[], request) => {
    const tool = tools.find(t =>
      t.name === request.toolName || (t.aliases ?? []).includes(request.toolName),
    )

    const parseResult = tool?.inputSchema.safeParse(request.input)
    const isConcurrencySafe: boolean = parseResult?.success
      ? (() => {
          try {
            return Boolean(tool!.isConcurrencySafe(parseResult.data))
          } catch {
            return false
          }
        })()
      : false

    const last = acc[acc.length - 1]
    if (isConcurrencySafe && last?.isConcurrencySafe) {
      last.requests.push(request)
    } else {
      acc.push({ isConcurrencySafe, requests: [request] })
    }
    return acc
  }, [])
}

// ── runTools — execute all batches and collect results ────────────────────────

export interface RunToolsResult {
  toolResultMessages: KernelMessage[]
  extraMessages: KernelMessage[]
  permissionDenials: PermissionDenial[]
  outcomes: ToolExecutionOutcome[]
  finalContext: KernelToolContext
  control?: KernelToolControl
}

/**
 * Execute all tool calls in the provided requests, respecting serial/parallel ordering.
 * Returns tool result messages in the same order as the original requests.
 */
export async function runTools(
  requests: ToolCallRequest[],
  tools: readonly KernelTool[],
  context: KernelToolContext,
  canUseTool: CanUseToolFn,
): Promise<RunToolsResult> {
  if (requests.length === 0) {
    return { toolResultMessages: [], extraMessages: [], permissionDenials: [], outcomes: [], finalContext: context }
  }

  const batches = partitionToolCalls(requests, tools)

  // Maintain ordered results keyed by toolUseId
  const orderedResults = new Map<string, ToolCallResult>()
  const permissionDenials: PermissionDenial[] = []
  let currentContext = context

  let control: KernelToolControl | undefined
  /** Name of the tool whose result carried `control` — used in the skip notice. */
  let controlToolName: string | undefined

  batchLoop: for (const batch of batches) {
    if (batch.isConcurrencySafe) {
      // ── Parallel batch ─────────────────────────────────────────────────────
      // Limit concurrency.
      //
      // Snapshot the limit once. It used to be read twice per iteration (once
      // for the step, once for the slice end); the getter is lazy by design, so
      // a config change landing between those two reads would produce chunks
      // that overlap or skip requests outright. Laziness is still honoured — the
      // value is re-read for the next batch.
      const limit = getConcurrencyLimit()
      const chunks: ToolCallRequest[][] = []
      for (let i = 0; i < batch.requests.length; i += limit) {
        chunks.push(batch.requests.slice(i, i + limit))
      }

      for (const chunk of chunks) {
        const results = await Promise.all(
          chunk.map(req => {
            const tool = findTool(tools, req.toolName)
            return executeToolCall(req, tool, currentContext, canUseTool)
          }),
        )

        for (const result of results) {
          orderedResults.set(result.toolUseId, result)
          if (result.permissionDenial) permissionDenials.push(result.permissionDenial)
          if (!control && result.control) {
            control = result.control
            controlToolName = result.toolName
          }
        }

        // Apply context modifiers in original request order
        for (const req of chunk) {
          const result = orderedResults.get(req.toolUseId)!
          if (result.contextModifier) {
            currentContext = result.contextModifier(currentContext)
          }
        }
        if (control) break batchLoop
      }
    } else {
      // ── Serial batch ──────────────────────────────────────────────────────
      for (const req of batch.requests) {
        const tool = findTool(tools, req.toolName)
        const result = await executeToolCall(req, tool, currentContext, canUseTool)
        orderedResults.set(result.toolUseId, result)
        if (result.permissionDenial) permissionDenials.push(result.permissionDenial)
        // Apply context modifier immediately after each serial tool
        if (result.contextModifier) {
          currentContext = result.contextModifier(currentContext)
        }
        if (result.control) {
          control = result.control
          controlToolName = result.toolName
          break batchLoop
        }
      }
    }
  }

  // Preserve the provider's tool_use/tool_result pairing invariant even though
  // a control-flow tool stopped execution part-way through the model's batch.
  // Skipped calls are explicit errors in history; they were never executed.
  if (control) {
    // L1-fix: name the tool that actually stopped the batch. The message used
    // to hard-code "an earlier self_timer call" for every control kind, so any
    // other control-flow tool made the model read a confident, wrong causal
    // explanation for why its remaining calls never ran.
    const skipReason = describeSkippedByControl(control, controlToolName)
    for (const req of requests) {
      if (orderedResults.has(req.toolUseId)) continue
      orderedResults.set(req.toolUseId, {
        toolUseId: req.toolUseId,
        toolName: req.toolName,
        resultMessage: makeToolResultMessage(
          req.toolUseId,
          skipReason,
          true,
          req.assistantMessageUuid,
        ),
        extraMessages: [],
        outcome: {
          toolUseId: req.toolUseId,
          toolName: req.toolName,
          input: req.input,
          durationMs: 0,
          isError: true,
        },
      })
    }
  }

  // Reconstruct results in original request order
  const toolResultMessages: KernelMessage[] = []
  const extraMessages: KernelMessage[] = []
  const outcomes: ToolExecutionOutcome[] = []

  for (const req of requests) {
    const result = orderedResults.get(req.toolUseId)
    if (result) {
      toolResultMessages.push(result.resultMessage)
      extraMessages.push(...result.extraMessages)
      outcomes.push(result.outcome)
    }
  }

  return {
    toolResultMessages,
    extraMessages,
    permissionDenials,
    outcomes,
    finalContext: currentContext,
    ...(control ? { control } : {}),
  }
}

// ── yieldMissingToolResultBlocks ─────────────────────────────────────────────

/**
 * When streaming is interrupted before tool execution, generate error
 * tool_result messages for any tool_use blocks that never got results.
 * Mirrors CC's yieldMissingToolResultBlocks.
 */
import { makeToolResultMessage } from '../messages/MessageFactory.js'

export function buildMissingToolResultMessages(
  assistantMessages: KernelMessage[],
  errorMessage: string,
): KernelMessage[] {
  const results: KernelMessage[] = []
  for (const msg of assistantMessages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        results.push(
          makeToolResultMessage(block.id, errorMessage, true, msg.uuid),
        )
      }
    }
  }
  return results
}

// ── helpers ───────────────────────────────────────────────────────────────────

function findTool(tools: readonly KernelTool[], name: string): KernelTool | undefined {
  return tools.find(t => t.name === name || (t.aliases ?? []).includes(name))
}

/**
 * Explain to the model why a tool call in its batch was never executed.
 *
 * Attributes the stop to the tool that actually produced the control signal and
 * describes the control kind, rather than asserting one specific tool. New
 * control kinds land in the `default` arm with an honest generic message
 * instead of inheriting a stale, confidently-wrong one.
 */
function describeSkippedByControl(
  control: KernelToolControl,
  controlToolName: string | undefined,
): string {
  const by = controlToolName ? `\`${controlToolName}\`` : 'an earlier tool'
  switch (control.kind) {
    case 'park':
      return `Skipped: not executed — ${by} parked the session earlier in this batch.`
    default:
      return `Skipped: not executed — ${by} stopped this tool batch earlier.`
  }
}
