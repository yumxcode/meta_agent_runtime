/**
 * get_sub_agent_status — query the terminal (or current) status of a sub-agent task
 *
 * Returns only the final result by default.  Intermediate state is available
 * via get_sub_agent_intermediate.
 *
 * Human-approval gate:
 *   When pending_human_approval=true the main agent MUST present the result
 *   to the user before taking any further action.  This is enforced by the
 *   tool description and by a warning injected into the response.
 */
import type { MetaAgentTool } from '../../core/types.js';
import type { SubAgentBridge } from '../SubAgentBridge.js';
export declare function makeGetSubAgentStatusTool(bridge: SubAgentBridge): MetaAgentTool;
//# sourceMappingURL=get_sub_agent_status.d.ts.map