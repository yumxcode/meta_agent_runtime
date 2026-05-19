/**
 * list_sub_agents — list all sub-agent tasks for the current session
 *
 * Useful for getting an overview of running / completed / failed sub-tasks
 * without reading each record individually.
 */
import type { MetaAgentTool } from '../../core/types.js';
import type { SubAgentBridge } from '../SubAgentBridge.js';
export declare function makeListSubAgentsTool(bridge: SubAgentBridge): MetaAgentTool;
//# sourceMappingURL=list_sub_agents.d.ts.map