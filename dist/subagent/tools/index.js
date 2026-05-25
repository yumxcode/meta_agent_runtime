/**
 * Sub-agent tool factory — exports all 5 sub-agent tools.
 *
 * Usage:
 *   const bridge = new SubAgentBridge(sessionId)
 *   const tools = makeSubAgentTools(bridge)
 *   // Register tools with the main agent session
 *   tools.forEach(tool => session.registerTool(tool))
 */
import { makeSpawnSubAgentTool } from './spawn_sub_agent.js';
import { makeGetSubAgentStatusTool } from './get_sub_agent_status.js';
import { makeGetSubAgentIntermediateTool } from './get_sub_agent_intermediate.js';
import { makeCancelSubAgentTool } from './cancel_sub_agent.js';
import { makeListSubAgentsTool } from './list_sub_agents.js';
export { makeSpawnSubAgentTool, makeGetSubAgentStatusTool, makeGetSubAgentIntermediateTool, makeCancelSubAgentTool, makeListSubAgentsTool, };
/**
 * Create all sub-agent tools bound to a single SubAgentBridge instance.
 *
 * @param bridge  The SubAgentBridge for this main-agent session.
 * @returns       Array of MetaAgentTool instances ready to register.
 */
export function makeSubAgentTools(bridge) {
    return [
        makeSpawnSubAgentTool(bridge),
        makeGetSubAgentStatusTool(bridge),
        makeGetSubAgentIntermediateTool(bridge),
        makeCancelSubAgentTool(bridge),
        makeListSubAgentsTool(bridge),
    ];
}
//# sourceMappingURL=index.js.map