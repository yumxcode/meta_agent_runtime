/**
 * ExperiencePatternChecker — pre-call principle-based experience matching.
 *
 * Surfaces relevant historical experiences before a tool executes, giving the
 * agent a chance to apply known principles in the same domain before acting.
 *
 * Key design shift vs. keyword/semantic similarity matching:
 *   The LLM judges whether a stored ABSTRACT PRINCIPLE applies to the current
 *   operation within the same robotics domain, not whether the surface
 *   description looks similar.
 *
 * Two-phase operation:
 *   Phase 1 — listExperiences(): domain-filtered list (both successes + failures)
 *   Phase 2 — FlashModel judgment: "which principles apply to this operation?"
 *              Falls back to all candidates if flash call fails.
 *
  * Design principles:
 *   • passed=true always — this hook never blocks execution (no abort)
 *   • severity='warning' — surfaces findings without interrupting workflow
 *   • Short notice in tool result + full details in ContextPager (next turn)
 *
 * Applies to: experiment_dispatch
 * Phase: pre_call
 */
import type { VVHook, VVResult, VVContext, VVPhase } from '../types.js';
import type { IKnowledgeSource } from '../../context/sources/IKnowledgeSource.js';
import type { FlashClient } from '../../core/flash/FlashClient.js';
import type { ContextPager } from '../../context/ContextPager.js';
export declare class ExperiencePatternChecker implements VVHook {
    private readonly source;
    private readonly flash;
    private readonly pager?;
    readonly name = "ExperiencePatternChecker";
    readonly phase: VVPhase[];
    readonly appliesTo: string[];
    constructor(source: IKnowledgeSource, flash: FlashClient, pager?: ContextPager | undefined);
    run(ctx: VVContext): Promise<VVResult>;
    private _pass;
}
export { ExperiencePatternChecker as FailurePatternChecker };
//# sourceMappingURL=FailurePatternChecker.d.ts.map