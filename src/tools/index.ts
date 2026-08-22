/**
 * Tool registry barrel.
 */

export { createEchoTool } from './echo/index.js'
export { loadToolPrompt } from './util.js'

// Provenance query tools
export {
  createProvenanceTools,
  createGetProvenanceTool,
  createListRecentTool,
  createFindDuplicateTool,
  createGetLineageTool,
} from './provenance/index.js'

// Engineering tool registry
export {
  EngineeringToolRegistry,
  defaultRegistry as defaultToolRegistry,
  FIDELITY_LABELS,
  createToolSearchTool,
  ToolVisibilityRegistry, toolVisibility, resetToolVisibility, visibleToolsForApi,
  searchTools, namespaceOf, isDeferred, eagerToolsForced, DEFAULT_NAMESPACE,
} from './registry/index.js'
export type {
  FidelityLevel, RegistryEntry,
  ToolSearchOptions, VisibilityTool, NamespaceSummary, ToolSearchHit,
} from './registry/index.js'

// ── File system tools ─────────────────────────────────────────────────────────
export {
  createReadFileTool, createWriteFileTool, createAppendFileTool, createEditFileTool,
  createApplyPatchTool, createTurnDiffTool,
  createGlobTool, createGrepTool, createNotebookEditTool,
  createFsTools,
} from './fs/index.js'
export type { FsToolsOptions } from './fs/index.js'

// ── Shell tools ───────────────────────────────────────────────────────────────
export {
  createBashTool, createPowerShellTool, createShellTools,
  createExecSessionTool, createWriteStdinTool, createCloseSessionTool,
} from './shell/index.js'
export type { ShellToolsOptions, ShellSessionToolOptions } from './shell/index.js'

// ── Network tools ─────────────────────────────────────────────────────────────
export { createWebFetchTool, createWebSearchTool, createNetworkTools } from './network/index.js'
export type { NetworkToolsOptions, WebSearchToolOptions } from './network/index.js'

// ── MCP tools ─────────────────────────────────────────────────────────────────
export {
  registerMcpClient, unregisterMcpClient, getRegisteredMcpServers,
  setMcpAppPresenter, getMcpAppPresenter, getMcpAppResourceUri, isMcpToolVisibleTo,
  MCP_APPS_EXTENSION_ID, MCP_APP_HTML_MIME_TYPE,
  createMcpCallTool, createListMcpResourcesTool, createReadMcpResourceTool,
  createMcpTools,
} from './mcp/index.js'
export type {
  McpClient, McpContentBlock, McpToolDefinition, McpToolResult,
  McpResource, McpResourceContent, McpReadResourceResult,
  McpAppPresenter, McpAppPresentation,
} from './mcp/index.js'

// ── UI / conversation tools ───────────────────────────────────────────────────
export {
  createAskUserTool, createTodoWriteTool, getTodosForSession, deleteTodosForSession,
  createSendMessageTool, createProgressNoteTool, getProgressNoteForSession, deleteProgressNoteForSession,
  createArtifactsRegisterTool, getArtifactsForSession, deleteArtifactsForSession,
  createUiTools, createAutoUiTools,
} from './ui/index.js'
export type { TodoItem } from './ui/index.js'

// ── System tools ──────────────────────────────────────────────────────────────
export {
  createSleepTool,
  createCronCreateTool, createCronDeleteTool, createCronListTool,
  createEnterPlanModeTool, createExitPlanModeTool,
  createSkillTool, createConfigTool,
  createSystemTools,
  listCronJobs, deleteCronJob, createCronJob, deleteJobsForSession,
} from './system/index.js'
export type { CronJob, SystemToolsOptions } from './system/index.js'

// ── Agent tools ───────────────────────────────────────────────────────────────
export { createRunAgentTool, createAgentTools } from './agent/index.js'

// ── Convenience factory: all standard tools ───────────────────────────────────
import type { MetaAgentTool } from '../core/types.js'
import type { ISubAgentDispatcher } from '../subagent/ISubAgentDispatcher.js'
import { createFsTools } from './fs/index.js'
import { createShellTools } from './shell/index.js'
import { createNetworkTools } from './network/index.js'
import { createMcpTools } from './mcp/index.js'
import { createUiTools, createAutoUiTools } from './ui/index.js'
import { createSystemTools } from './system/index.js'
import type { SystemToolsOptions } from './system/index.js'
import { createAgentTools } from './agent/index.js'
import { createToolSearchTool } from './registry/tool_search/index.js'
import { AUTO_DENIED_TOOL_NAMES, isAutonomousMode, type SessionMode } from '../core/modes.js'

export type ToolCategory = 'fs' | 'shell' | 'network' | 'mcp' | 'ui' | 'system' | 'agent'

/**
 * Categories whose schemas are withheld until `tool_search` asks for them.
 *
 * The default is deliberately narrow. Deferral trades one extra round-trip on
 * first use for schema tokens on every turn, so it only pays for tools that are
 * usually NOT needed — and it is actively harmful for anything the model needs
 * to make basic progress (fs, shell, ui), because a model that cannot see how
 * to read a file does not search for a reader; it gives up or guesses.
 *
 * `provenance` is not in `include` at all (those tools are registered
 * separately by the runtime context), so the shipped default defers nothing.
 * Hosts with many connected tools opt in per category.
 */
const DEFAULT_DEFERRED_CATEGORIES: readonly ToolCategory[] = []

export interface StandardToolsOptions {
  network?: import('./network/index.js').NetworkToolsOptions
  /** Pass any ISubAgentDispatcher implementation — typically a SubAgentBridge instance. */
  agent?: { bridge: ISubAgentDispatcher }
  /** Options forwarded to createSystemTools (cwd, planModeRef). */
  system?: SystemToolsOptions
  include?: ToolCategory[]
  /** Session mode for mode-specific tool selection (e.g., autonomous modes exclude ask_user/send_message). */
  mode?: SessionMode
  /**
   * Categories whose tool schemas are deferred behind `tool_search`.
   *
   * When this is non-empty (or any tool arrives already marked deferred),
   * `tool_search` is registered automatically — a deferred tool with no way to
   * find it is simply an unavailable tool.
   */
  defer?: ToolCategory[]
}

/** Assign a namespace, and optionally defer, over a whole category. */
function labelCategory(
  tools: MetaAgentTool[],
  namespace: string,
  defer: boolean,
): MetaAgentTool[] {
  return tools.map(tool => ({
    ...tool,
    namespace: tool.namespace ?? namespace,
    // An explicit per-tool declaration wins: a category-level default must not
    // silently un-defer a tool that asked to be deferred.
    deferLoading: tool.deferLoading ?? (defer || undefined),
  }))
}

/**
 * Create the full standard toolset. Pass options to configure network and agent tools.
 * Use `include` to select a subset of tool categories.
 *
 * To wire plan-mode into a MetaAgentSession pass `system: { planModeRef: session._planModeRef }`.
 */
export async function createStandardTools(options: StandardToolsOptions = {}): Promise<MetaAgentTool[]> {
  const include = options.include ?? ['fs', 'shell', 'network', 'mcp', 'ui', 'system']
  const deferred = new Set<ToolCategory>(options.defer ?? DEFAULT_DEFERRED_CATEGORIES)
  const groups: Promise<MetaAgentTool[]>[] = []
  const label = (
    category: ToolCategory,
    promise: Promise<MetaAgentTool[]>,
  ): Promise<MetaAgentTool[]> =>
    promise.then(tools => labelCategory(tools, category, deferred.has(category)))

  if (include.includes('fs'))      groups.push(label('fs', createFsTools()))
  if (include.includes('shell'))   groups.push(label('shell', createShellTools()))
  if (include.includes('network')) groups.push(label('network', createNetworkTools(options.network)))
  if (include.includes('mcp'))     groups.push(label('mcp', createMcpTools()))
  if (include.includes('ui')) {
    // Autonomous modes use createAutoUiTools (excludes ask_user/send_message for unattended runs)
    groups.push(label('ui', isAutonomousMode(options.mode) ? createAutoUiTools() : createUiTools()))
  }
  if (include.includes('system')) {
    groups.push(label('system', createSystemTools({
      ...options.system,
      // A top-level concrete mode is authoritative for mode-specific tool
      // selection. This keeps direct createStandardTools({ mode: 'auto' })
      // callers safe even when they omit system.mode.
      mode: options.mode ?? options.system?.mode,
    })))
  }
  if (include.includes('agent') && options.agent) {
    groups.push(label('agent', createAgentTools(options.agent.bridge)))
  }
  const arrays = await Promise.all(groups)
  let tools = arrays.flat()

  // Register tool_search iff something is actually hidden. A deferred tool the
  // model has no way to find is just an unavailable tool; conversely, shipping
  // a search tool when nothing is deferred spends a schema to describe an empty
  // inventory.
  if (tools.some(t => t.deferLoading === true)) {
    const snapshot = tools
    tools = [...tools, await createToolSearchTool({ allTools: () => snapshot })]
  }

  if (!isAutonomousMode(options.mode)) return tools

  // Defense in depth for the standard registry. PermissionPolicy enforces the
  // same list at execution time, but removing these tools also prevents the
  // model from seeing or attempting capabilities that auto can never use.
  const denied = new Set<string>(AUTO_DENIED_TOOL_NAMES)
  return tools.filter(tool => !denied.has(tool.name))
}
