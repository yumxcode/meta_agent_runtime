/**
 * get_sub_agent_intermediate — retrieve the latest checkpoint of a running sub-agent
 *
 * By default the main agent only sees the final result.  This tool provides
 * explicit access to the most-recent checkpoint (saved every N turns by the
 * SubAgentRunner).
 *
 * Use sparingly — the sub-agent's intermediate reasoning is intentionally
 * opaque to keep the main agent's context clean.  Reach for this tool only
 * when you need to diagnose a stalled sub-task or make a mid-flight decision.
 */
import type { MetaAgentTool } from '../../core/types.js';
import type { SubAgentBridge } from '../SubAgentBridge.js';
export declare function makeGetSubAgentIntermediateTool(bridge: SubAgentBridge): MetaAgentTool;
//# sourceMappingURL=get_sub_agent_intermediate.d.ts.map