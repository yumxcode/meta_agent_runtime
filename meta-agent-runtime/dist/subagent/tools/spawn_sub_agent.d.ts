/**
 * spawn_sub_agent — tool for the main agent to delegate a sub-task
 *
 * Returns immediately with a taskId.  The sub-agent runs asynchronously.
 * The main agent will be notified on completion via the D-SubAgent
 * dynamic prompt section (event-driven) or by polling get_sub_agent_status.
 */
import type { MetaAgentTool } from '../../core/types.js';
import type { SubAgentBridge } from '../SubAgentBridge.js';
export declare function makeSpawnSubAgentTool(bridge: SubAgentBridge): MetaAgentTool;
//# sourceMappingURL=spawn_sub_agent.d.ts.map