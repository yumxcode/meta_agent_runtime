export { createRunAgentTool } from './run_agent/index.js';
import { createRunAgentTool } from './run_agent/index.js';
export async function createAgentTools(bridge) {
    return Promise.all([createRunAgentTool(bridge)]);
}
//# sourceMappingURL=index.js.map