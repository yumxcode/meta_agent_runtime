/**
 * instrumentTool — wraps a MetaAgentTool with the full Phase 1 pipeline:
 *
 *   ① Pre-call V&V      — validate tool INPUT before execution
 *   ② Tool execution    — run the original tool
 *   ③ Post-call V&V     — validate tool OUTPUT after execution
 *   ④ Provenance record — persist full audit trail to disk
 *   ⑤ Result annotation — append [provenance: {id}] to the tool result
 *
 * If any V&V hook with suggestedAction='abort' fires, the tool call is
 * halted at that point (post-call abort still records provenance).
 * The provenanceId is always appended so the agent can query the record.
 *
 * The instrumented tool is a drop-in replacement — same name, description,
 * inputSchema.  Only the call() implementation changes.
 *
 * Usage:
 *   const raw = await createBatteryCapacityTool()
 *   const instrumented = instrumentTool(raw, rtx, {
 *     systemPrompt: mySystemPrompt,
 *     fidelityLevel: 0,
 *   })
 *   session.registerTool(instrumented)
 */

import type { MetaAgentTool, ToolCallContext, ToolResult } from '../core/types.js'
import type { RuntimeContext } from './RuntimeContext.js'
import type { DimensionalRecord } from '../jobs/types.js'
import type { VVContext } from '../validation/types.js'
import { requiresAbort, failures } from '../validation/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface InstrumentOptions {
  /**
   * Raw system prompt text.  Hashed and stored in the provenance record so
   * prompt drift across runs is detectable.  If omitted, empty string is used.
   */
  systemPrompt?: string
  /**
   * Fidelity level for provenance records.  Default: 0 (analytical).
   */
  fidelityLevel?: number
  /**
   * Tool version (semver or git SHA).  Default: '' (unknown).
   */
  toolVersion?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Core wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap `tool` with V&V + provenance tracking.
 *
 * The returned tool has the same `name`, `description`, and `inputSchema`.
 * Its `call()` runs the full five-step pipeline described above.
 */
export function instrumentTool(
  tool: MetaAgentTool,
  rtx: RuntimeContext,
  opts: InstrumentOptions = {},
): MetaAgentTool {
  const systemPrompt = opts.systemPrompt ?? ''
  const fidelityLevel = opts.fidelityLevel ?? 0
  const toolVersion = opts.toolVersion ?? ''

  async function call(
    input: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolResult> {
    // ── ① Pre-call V&V ─────────────────────────────────────────────────────
    const preCtx: VVContext = {
      phase: 'pre_call',
      toolName: tool.name,
      input: input as DimensionalRecord,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
    }
    const preResults = await rtx.vvChain.run(preCtx)

    if (requiresAbort(preResults)) {
      const msgs = failures(preResults).map(r => `• [${r.hookName}] ${r.message}`).join('\n')
      // Still record provenance so the agent knows this call was rejected
      const provId = await rtx.provenanceTracker.record({
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        toolName: tool.name,
        toolVersion,
        fidelityLevel,
        input: input as DimensionalRecord,
        modelName: '',
        systemPrompt,
        output: {},
        validationResults: preResults,
        artifacts: [],
      })
      const preAbortProvSuffix = provId ? `\n[provenance: ${provId}]` : ''
      return {
        content:
          `[V&V PRE-CALL ABORT] Tool "${tool.name}" was blocked before execution.\n\n` +
          msgs +
          `\n\n[NEXT STEPS]\n` +
          `• The tool was NOT executed — no computation was performed.\n` +
          `• Fix the inputs that triggered the violation above, then retry the call.\n` +
          `• If you believe the input is correct, inspect the provenance record below for the full validation detail before deciding whether to escalate or skip this tool call.\n` +
          preAbortProvSuffix,
        isError: true,
      }
    }

    // ── ② Tool execution ────────────────────────────────────────────────────
    // Inject runtime services into the context so the tool itself can use them
    const enrichedCtx: ToolCallContext = {
      ...ctx,
      jobManager: rtx.jobManager,
      vvChain: rtx.vvChain,
      provenanceTracker: rtx.provenanceTracker,
    }

    let result: ToolResult
    try {
      result = await tool.call(input, enrichedCtx)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result = { content: `Tool error: ${message}`, isError: true }
    }

    // ── ③ Post-call V&V ────────────────────────────────────────────────────
    // Attempt to parse the output as JSON for structured V&V checks.
    // If the output is plain text, we still run the hook chain with {}
    let output: DimensionalRecord = {}
    if (!result.isError) {
      try {
        const parsed = JSON.parse(result.content)
        if (typeof parsed === 'object' && parsed !== null) {
          output = parsed as DimensionalRecord
        }
      } catch { /* plain-text output — that's fine */ }
    }

    const postCtx: VVContext = {
      phase: 'post_call',
      toolName: tool.name,
      input: input as DimensionalRecord,
      output,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
    }
    const postResults = await rtx.vvChain.run(postCtx)

    // ── ④ Provenance record ─────────────────────────────────────────────────
    const allVVResults = [...preResults, ...postResults]
    const provId = await rtx.provenanceTracker.record({
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      toolName: tool.name,
      toolVersion,
      fidelityLevel,
      input: input as DimensionalRecord,
      modelName: '',
      systemPrompt,
      output,
      validationResults: allVVResults,
      artifacts: [],
    })

    // ── ⑤ Result annotation ─────────────────────────────────────────────────
    // provId is '' when a NoopProvenanceTracker is in use (e.g. robotics mode).
    // Skip annotation entirely in that case to keep tool results clean.
    const provSuffix = provId ? `\n\n[provenance: ${provId}]` : ''

    if (requiresAbort(postResults)) {
      const msgs = failures(postResults).map(r => `• [${r.hookName}] ${r.message}`).join('\n')
      return {
        content:
          `[V&V POST-CALL ABORT] Output of "${tool.name}" failed validation.\n\n` +
          msgs +
          `\n\n[NEXT STEPS]\n` +
          `• The tool DID execute — the raw output is stored in the provenance record below.\n` +
          `• Query the provenance record to inspect the full output before deciding how to proceed.\n` +
          `• Do NOT retry with the same inputs — the tool would produce the same invalid output.\n` +
          `• Either adjust your approach (different inputs, different tool) or escalate if the output is unexpectedly invalid.\n` +
          provSuffix,
        isError: true,
      }
    }

    // Warn messages: prepend to result if there are non-fatal failures
    const warnMsgs = failures(postResults)
    const warnPrefix = warnMsgs.length > 0
      ? `[V&V WARNING] Tool "${tool.name}" completed but output raised non-fatal concerns.\n` +
        `${warnMsgs.map(r => `• [${r.hookName}] ${r.message}`).join('\n')}\n` +
        `Proceed with caution — treat this result as lower-confidence and consider verifying with an independent check.\n\n`
      : ''

    return {
      content: warnPrefix + result.content + provSuffix,
      isError: result.isError,
    }
  }

  // Return a new MetaAgentTool that preserves metadata such as timeoutMs and
  // maxResultSizeChars, while replacing only the call implementation.
  return {
    ...tool,
    call,
  }
}
