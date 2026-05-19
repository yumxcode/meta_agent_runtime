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
import type { MetaAgentTool } from '../core/types.js';
import type { RuntimeContext } from './RuntimeContext.js';
export interface InstrumentOptions {
    /**
     * Raw system prompt text.  Hashed and stored in the provenance record so
     * prompt drift across runs is detectable.  If omitted, empty string is used.
     */
    systemPrompt?: string;
    /**
     * Fidelity level for provenance records.  Default: 0 (analytical).
     */
    fidelityLevel?: number;
    /**
     * Tool version (semver or git SHA).  Default: '' (unknown).
     */
    toolVersion?: string;
}
/**
 * Wrap `tool` with V&V + provenance tracking.
 *
 * The returned tool has the same `name`, `description`, and `inputSchema`.
 * Its `call()` runs the full five-step pipeline described above.
 */
export declare function instrumentTool(tool: MetaAgentTool, rtx: RuntimeContext, opts?: InstrumentOptions): MetaAgentTool;
//# sourceMappingURL=instrumentTool.d.ts.map