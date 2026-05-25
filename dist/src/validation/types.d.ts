/**
 * V&V (Validation & Verification) — core types
 *
 * Engineering simulations don't "error out" when they're wrong — they just
 * produce incorrect numbers. The V&V hook system provides a structured way
 * to catch those incorrect numbers before they propagate into decisions.
 *
 * Hook lifecycle phases:
 *
 *   pre_call        — runs before a tool is called; can block bad inputs
 *   post_call       — runs after a tool returns; validates the output
 *   pre_compact     — runs before CC context compaction; ensures numbers
 *                     are preserved in the summary
 *   post_session    — runs at session end; cross-simulation consistency
 *
 * Severity / suggested action matrix:
 *
 *   info            → continue (log only)
 *   warning         → warn_user (surface to user, continue)
 *   error           → pause_and_ask (agent pauses and explains the issue)
 *   critical        → abort (halt the tool call / session)
 */
import type { DimensionalRecord } from '../jobs/types.js';
export type VVPhase = 'pre_call' | 'post_call' | 'pre_compact' | 'post_session';
export type VVSeverity = 'info' | 'warning' | 'error' | 'critical';
export type VVSuggestedAction = 'continue' | 'warn_user' | 'pause_and_ask' | 'abort';
export interface VVResult {
    /** Name of the hook that produced this result */
    hookName: string;
    /** Did the check pass? */
    passed: boolean;
    severity: VVSeverity;
    /** Human-readable explanation (shown to agent / user when not passed) */
    message: string;
    suggestedAction: VVSuggestedAction;
    /** Optional: key within input/output that triggered the finding */
    field?: string;
    /** Optional: the offending value */
    offendingValue?: unknown;
}
export interface VVContext {
    phase: VVPhase;
    toolName: string;
    /** Present in pre_call / post_call */
    input?: DimensionalRecord;
    /** Present in post_call */
    output?: DimensionalRecord;
    sessionId: string;
    agentId: string;
    /** Present if the tool ran as a job */
    jobId?: string;
    /** Fidelity level of the tool (0–4) */
    fidelityLevel?: number;
}
export interface VVHook {
    /** Unique name — used for registration lookup and result attribution */
    readonly name: string;
    /**
     * Which phase(s) this hook runs in.
     * Can be a single phase or an array.
     */
    readonly phase: VVPhase | VVPhase[];
    /**
     * Which tool names this hook applies to.
     * Use '*' (the string) to apply to every tool.
     */
    readonly appliesTo: string[] | '*';
    /**
     * Run the validation check.
     * Must never throw — return a VVResult with passed=false instead.
     */
    run(context: VVContext): Promise<VVResult>;
}
/** Derive a suggestedAction from severity when the hook doesn't specify */
export declare function defaultAction(severity: VVSeverity): VVSuggestedAction;
/** Check whether any result in a set requires stopping */
export declare function requiresAbort(results: VVResult[]): boolean;
/** Check whether any result requires pausing */
export declare function requiresPause(results: VVResult[]): boolean;
/** Filter to only failed results */
export declare function failures(results: VVResult[]): VVResult[];
/** Highest severity in a result set */
export declare function maxSeverity(results: VVResult[]): VVSeverity | null;
//# sourceMappingURL=types.d.ts.map