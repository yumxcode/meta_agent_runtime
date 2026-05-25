import type { MetaAgentTool } from '../../../core/types.js';
/**
 * EnterPlanMode — activate plan mode on the parent MetaAgentSession.
 *
 * The session exposes _planModeRef as a mutable { active: boolean } object.
 * We retrieve it via ctx.sessionId lookup from the global session registry,
 * or alternatively the tool is constructed with a direct ref injection.
 */
export declare function createEnterPlanModeTool(planModeRef: {
    active: boolean;
}): Promise<MetaAgentTool>;
//# sourceMappingURL=index.d.ts.map