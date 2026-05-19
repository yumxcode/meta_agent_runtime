/**
 * VVHookChain — registers VVHooks and runs them in order for a given phase.
 *
 * Design decisions:
 *
 * 1. Hooks are run sequentially (not in parallel) so that a critical failure
 *    in an early hook can short-circuit the rest.  This avoids wasting compute
 *    on checks downstream of a known abort condition.
 *
 * 2. A hook is "applicable" if:
 *    - Its `phase` matches (or includes) the requested phase, AND
 *    - Its `appliesTo` is '*' or includes the tool name.
 *
 * 3. Each hook is wrapped in try/catch — a buggy hook must never crash the
 *    tool call it's protecting.  Hook errors are returned as VVResult with
 *    passed=true so they don't block execution (but they log a warning).
 *
 * 4. Short-circuit on 'abort': once any hook returns a critical failure, the
 *    remaining hooks for that phase are skipped.
 *
 * Usage:
 *
 *   const chain = new VVHookChain()
 *   chain.register(new OOMChecker(myReferenceDB))
 *   chain.register(new PhysicsConstraintChecker())
 *
 *   const results = await chain.run({
 *     phase: 'post_call',
 *     toolName: 'fem_stress',
 *     input:  { force: 1000, area: 0.01 },
 *     output: { stress: 1e8 },
 *     sessionId: '...',
 *     agentId: '...',
 *   })
 *
 *   if (requiresAbort(results)) { ... }
 */
import type { VVHook, VVResult, VVContext } from './types.js';
export declare class VVHookChain {
    private readonly hooks;
    register(hook: VVHook): void;
    unregister(hookName: string): void;
    /** Replace an existing hook (same name) with a new implementation */
    replace(hook: VVHook): void;
    /** All registered hook names */
    get names(): string[];
    /**
     * Run all applicable hooks for the given context.
     *
     * Hooks are executed in registration order.
     * Short-circuits on 'abort' severity.
     *
     * Never throws — errors inside hooks become passing VVResults with a note.
     */
    run(context: VVContext): Promise<VVResult[]>;
    /** Run all pre_call hooks for a tool */
    runPreCall(toolName: string, input: unknown, sessionId: string, agentId: string): Promise<VVResult[]>;
    /** Run all post_call hooks for a tool */
    runPostCall(toolName: string, input: unknown, output: unknown, sessionId: string, agentId: string, jobId?: string, fidelityLevel?: number): Promise<VVResult[]>;
    private _applicable;
}
//# sourceMappingURL=VVHookChain.d.ts.map