/**
 * cancel_sub_agent — abort a running sub-agent task
 *
 * Immediately marks the task as cancelled and signals the runner's
 * AbortController.  The runner's MetaAgentSession will stop at the next
 * API response boundary.
 */
import type { MetaAgentTool } from '../../core/types.js';
import type { SubAgentBridge } from '../SubAgentBridge.js';
export declare function makeCancelSubAgentTool(bridge: SubAgentBridge): MetaAgentTool;
//# sourceMappingURL=cancel_sub_agent.d.ts.map