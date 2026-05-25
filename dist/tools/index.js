/**
 * Tool registry barrel.
 */
export { createEchoTool } from './echo/index.js';
export { loadToolPrompt } from './util.js';
// Provenance query tools
export { createProvenanceTools, createGetProvenanceTool, createListRecentTool, createFindDuplicateTool, createGetLineageTool, } from './provenance/index.js';
// Engineering tool registry
export { EngineeringToolRegistry, defaultRegistry as defaultToolRegistry, FIDELITY_LABELS, } from './registry/index.js';
// ── File system tools ─────────────────────────────────────────────────────────
export { createReadFileTool, createWriteFileTool, createEditFileTool, createGlobTool, createGrepTool, createNotebookEditTool, createFsTools, } from './fs/index.js';
// ── Shell tools ───────────────────────────────────────────────────────────────
export { createBashTool, createPowerShellTool, createShellTools } from './shell/index.js';
// ── Network tools ─────────────────────────────────────────────────────────────
export { createWebFetchTool, createWebSearchTool, createNetworkTools } from './network/index.js';
// ── MCP tools ─────────────────────────────────────────────────────────────────
export { registerMcpClient, unregisterMcpClient, getRegisteredMcpServers, createMcpCallTool, createListMcpResourcesTool, createReadMcpResourceTool, createMcpTools, } from './mcp/index.js';
// ── UI / conversation tools ───────────────────────────────────────────────────
export { createAskUserTool, createTodoWriteTool, getTodosForSession, deleteTodosForSession, createSendMessageTool, createUiTools, } from './ui/index.js';
// ── System tools ──────────────────────────────────────────────────────────────
export { createSleepTool, createCronCreateTool, createCronDeleteTool, createCronListTool, createEnterPlanModeTool, createExitPlanModeTool, createSkillTool, createConfigTool, createSystemTools, listCronJobs, deleteCronJob, createCronJob, deleteJobsForSession, } from './system/index.js';
// ── Agent tools ───────────────────────────────────────────────────────────────
export { createRunAgentTool, createAgentTools } from './agent/index.js';
import { createFsTools } from './fs/index.js';
import { createShellTools } from './shell/index.js';
import { createNetworkTools } from './network/index.js';
import { createMcpTools } from './mcp/index.js';
import { createUiTools } from './ui/index.js';
import { createSystemTools } from './system/index.js';
import { createAgentTools } from './agent/index.js';
/**
 * Create the full standard toolset. Pass options to configure network and agent tools.
 * Use `include` to select a subset of tool categories.
 *
 * To wire plan-mode into a MetaAgentSession pass `system: { planModeRef: session._planModeRef }`.
 */
export async function createStandardTools(options = {}) {
    const include = options.include ?? ['fs', 'shell', 'network', 'mcp', 'ui', 'system'];
    const groups = [];
    if (include.includes('fs'))
        groups.push(createFsTools());
    if (include.includes('shell'))
        groups.push(createShellTools());
    if (include.includes('network'))
        groups.push(createNetworkTools(options.network));
    if (include.includes('mcp'))
        groups.push(createMcpTools());
    if (include.includes('ui'))
        groups.push(createUiTools());
    if (include.includes('system'))
        groups.push(createSystemTools(options.system));
    if (include.includes('agent') && options.agent)
        groups.push(createAgentTools(options.agent.bridge));
    const arrays = await Promise.all(groups);
    return arrays.flat();
}
//# sourceMappingURL=index.js.map