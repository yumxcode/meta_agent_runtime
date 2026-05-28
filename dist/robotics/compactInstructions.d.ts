/**
 * buildRoboticsCompactInstructions
 *
 * Generates a ## Compact Instructions block for Robotics mode that tells the
 * auto-compact agent what to preserve when the context window fills.
 *
 * Campaign mode has an analogous block (buildCompactInstructions in compactPrompt.ts)
 * that preserves provenance IDs and campaign state.  Robotics needs its own variant
 * because the critical state is different:
 *
 *   • Active sub-agent task IDs — required for get_sub_agent_status calls
 *   • Hardware safety limits — must not be silently lost after compaction
 *   • Current development phase — orientation anchor for long sessions
 *   • Any experience IDs referenced — avoid duplicate lookups next turn
 *
 * Injected every turn as part of the volatile user-message prefix, just like the
 * campaign compact block.  The KernelSession auto-compact runs against whatever is
 * in the current context, so these instructions are always visible to the compact
 * agent when it fires.
 *
 * Returns null when there is no state that warrants special preservation guidance
 * (e.g. a brand-new session with no tasks and no phase set).
 */
import type { RoboticsProjectState } from './types.js';
export interface RoboticsCompactContext {
    /** Current project state — used for active tasks and phase. */
    state: RoboticsProjectState | null;
    /**
     * Hardware profile summary string (the first ~400 chars of formatForPrompt()).
     * Optional — omitted for sessions without a hardware profile.
     */
    hardwareSummary?: string | null;
}
/**
 * Build the robotics compact instructions block.
 *
 * @returns Markdown string to inject into the user-message prefix, or null if
 *          there is nothing worth preserving (empty session, no tasks, no phase).
 */
export declare function buildRoboticsCompactInstructions(ctx: RoboticsCompactContext): string | null;
//# sourceMappingURL=compactInstructions.d.ts.map