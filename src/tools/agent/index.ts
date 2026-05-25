export { createRunAgentTool } from './run_agent/index.js'
import type { MetaAgentTool } from '../../core/types.js'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import { createRunAgentTool } from './run_agent/index.js'
export async function createAgentTools(bridge: ISubAgentDispatcher): Promise<MetaAgentTool[]> {
  return Promise.all([createRunAgentTool(bridge)])
}
