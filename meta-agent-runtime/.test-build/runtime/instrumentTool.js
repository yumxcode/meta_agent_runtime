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
import { requiresAbort, failures } from '../validation/types.js';
// ─────────────────────────────────────────────────────────────────────────────
// Core wrapper
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Wrap `tool` with V&V + provenance tracking.
 *
 * The returned tool has the same `name`, `description`, and `inputSchema`.
 * Its `call()` runs the full five-step pipeline described above.
 */
export function instrumentTool(tool, rtx, opts = {}) {
    const systemPrompt = opts.systemPrompt ?? '';
    const fidelityLevel = opts.fidelityLevel ?? 0;
    const toolVersion = opts.toolVersion ?? '';
    async function call(input, ctx) {
        // ── ① Pre-call V&V ─────────────────────────────────────────────────────
        const preCtx = {
            phase: 'pre_call',
            toolName: tool.name,
            input: input,
            sessionId: ctx.sessionId,
            agentId: ctx.agentId,
        };
        const preResults = await rtx.vvChain.run(preCtx);
        if (requiresAbort(preResults)) {
            const msgs = failures(preResults).map(r => `• [${r.hookName}] ${r.message}`).join('\n');
            // Still record provenance so the agent knows this call was rejected
            const provId = await rtx.provenanceTracker.record({
                sessionId: ctx.sessionId,
                agentId: ctx.agentId,
                toolName: tool.name,
                toolVersion,
                fidelityLevel,
                input: input,
                modelName: '',
                systemPrompt,
                output: {},
                validationResults: preResults,
                artifacts: [],
            });
            return {
                content: `[V&V PRE-CALL ABORT] Tool "${tool.name}" was blocked before execution.\n\n` +
                    msgs +
                    `\n\n[NEXT STEPS]\n` +
                    `• The tool was NOT executed — no computation was performed.\n` +
                    `• Fix the inputs that triggered the violation above, then retry the call.\n` +
                    `• If you believe the input is correct, inspect the provenance record below for the full validation detail before deciding whether to escalate or skip this tool call.\n` +
                    `\n[provenance: ${provId}]`,
                isError: true,
            };
        }
        // ── ② Tool execution ────────────────────────────────────────────────────
        // Inject runtime services into the context so the tool itself can use them
        const enrichedCtx = {
            ...ctx,
            jobManager: rtx.jobManager,
            vvChain: rtx.vvChain,
            provenanceTracker: rtx.provenanceTracker,
        };
        let result;
        try {
            result = await tool.call(input, enrichedCtx);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            result = { content: `Tool error: ${message}`, isError: true };
        }
        // ── ③ Post-call V&V ────────────────────────────────────────────────────
        // Attempt to parse the output as JSON for structured V&V checks.
        // If the output is plain text, we still run the hook chain with {}
        let output = {};
        if (!result.isError) {
            try {
                const parsed = JSON.parse(result.content);
                if (typeof parsed === 'object' && parsed !== null) {
                    output = parsed;
                }
            }
            catch { /* plain-text output — that's fine */ }
        }
        const postCtx = {
            phase: 'post_call',
            toolName: tool.name,
            input: input,
            output,
            sessionId: ctx.sessionId,
            agentId: ctx.agentId,
        };
        const postResults = await rtx.vvChain.run(postCtx);
        // ── ④ Provenance record ─────────────────────────────────────────────────
        const allVVResults = [...preResults, ...postResults];
        const provId = await rtx.provenanceTracker.record({
            sessionId: ctx.sessionId,
            agentId: ctx.agentId,
            toolName: tool.name,
            toolVersion,
            fidelityLevel,
            input: input,
            modelName: '',
            systemPrompt,
            output,
            validationResults: allVVResults,
            artifacts: [],
        });
        // ── ⑤ Result annotation ─────────────────────────────────────────────────
        const provSuffix = `\n\n[provenance: ${provId}]`;
        if (requiresAbort(postResults)) {
            const msgs = failures(postResults).map(r => `• [${r.hookName}] ${r.message}`).join('\n');
            return {
                content: `[V&V POST-CALL ABORT] Output of "${tool.name}" failed validation.\n\n` +
                    msgs +
                    `\n\n[NEXT STEPS]\n` +
                    `• The tool DID execute — the raw output is stored in the provenance record below.\n` +
                    `• Query the provenance record to inspect the full output before deciding how to proceed.\n` +
                    `• Do NOT retry with the same inputs — the tool would produce the same invalid output.\n` +
                    `• Either adjust your approach (different inputs, different tool) or escalate if the output is unexpectedly invalid.\n` +
                    provSuffix,
                isError: true,
            };
        }
        // Warn messages: prepend to result if there are non-fatal failures
        const warnMsgs = failures(postResults);
        const warnPrefix = warnMsgs.length > 0
            ? `[V&V WARNING] Tool "${tool.name}" completed but output raised non-fatal concerns.\n` +
                `${warnMsgs.map(r => `• [${r.hookName}] ${r.message}`).join('\n')}\n` +
                `Proceed with caution — treat this result as lower-confidence and consider verifying with an independent check.\n\n`
            : '';
        return {
            content: warnPrefix + result.content + provSuffix,
            isError: result.isError,
        };
    }
    // Return a new MetaAgentTool that delegates everything but call()
    return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        call,
    };
}
//# sourceMappingURL=instrumentTool.js.map