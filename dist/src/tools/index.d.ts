/**
 * Tool registry barrel.
 */
export { createEchoTool } from './echo/index.js';
export { loadToolPrompt } from './util.js';
export { createProvenanceTools, createGetProvenanceTool, createListRecentTool, createFindDuplicateTool, createGetLineageTool, } from './provenance/index.js';
export { EngineeringToolRegistry, defaultRegistry as defaultToolRegistry, FIDELITY_LABELS, } from './registry/index.js';
export type { FidelityLevel, RegistryEntry } from './registry/index.js';
export { createReadFileTool, createWriteFileTool, createEditFileTool, createGlobTool, createGrepTool, createNotebookEditTool, createFsTools, } from './fs/index.js';
export { createBashTool, createPowerShellTool, createShellTools } from './shell/index.js';
export { createWebFetchTool, createWebSearchTool, createNetworkTools } from './network/index.js';
export type { NetworkToolsOptions, WebSearchToolOptions } from './network/index.js';
export { registerMcpClient, unregisterMcpClient, getRegisteredMcpServers, createMcpCallTool, createListMcpResourcesTool, createReadMcpResourceTool, createMcpTools, } from './mcp/index.js';
export type { McpClient } from './mcp/index.js';
export { createAskUserTool, createTodoWriteTool, getTodosForSession, deleteTodosForSession, createSendMessageTool, createUiTools, } from './ui/index.js';
export type { TodoItem } from './ui/index.js';
export { createSleepTool, createCronCreateTool, createCronDeleteTool, createCronListTool, createEnterPlanModeTool, createExitPlanModeTool, createSkillTool, createConfigTool, createSystemTools, listCronJobs, deleteCronJob, createCronJob, deleteJobsForSession, } from './system/index.js';
export type { CronJob, SystemToolsOptions } from './system/index.js';
export { createRunAgentTool, createAgentTools } from './agent/index.js';
import type { MetaAgentTool } from '../core/types.js';
import type { ISubAgentDispatcher } from '../subagent/ISubAgentDispatcher.js';
import type { SystemToolsOptions } from './system/index.js';
export interface StandardToolsOptions {
    network?: {
        webSearch?: {
            apiKey?: string;
            model?: string;
        };
    };
    /** Pass any ISubAgentDispatcher implementation — typically a SubAgentBridge instance. */
    agent?: {
        bridge: ISubAgentDispatcher;
    };
    /** Options forwarded to createSystemTools (cwd, planModeRef). */
    system?: SystemToolsOptions;
    include?: ('fs' | 'shell' | 'network' | 'mcp' | 'ui' | 'system' | 'agent')[];
}
/**
 * Create the full standard toolset. Pass options to configure network and agent tools.
 * Use `include` to select a subset of tool categories.
 *
 * To wire plan-mode into a MetaAgentSession pass `system: { planModeRef: session._planModeRef }`.
 */
export declare function createStandardTools(options?: StandardToolsOptions): Promise<MetaAgentTool[]>;
//# sourceMappingURL=index.d.ts.map