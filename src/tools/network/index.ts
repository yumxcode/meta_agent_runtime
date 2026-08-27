export { createWebFetchTool } from './web_fetch/index.js'
export { createWebSearchTool, SEARCH_PROVIDER_ORDER, DEFAULT_WEB_SEARCH_MODEL } from './web_search/index.js'
export type { WebSearchToolOptions, SearchProviderId } from './web_search/index.js'
import type { MetaAgentTool } from '../../core/types.js'
import { createWebFetchTool } from './web_fetch/index.js'
import { createWebSearchTool } from './web_search/index.js'
import type { WebFetchToolOptions } from './web_fetch/index.js'
import type { WebSearchToolOptions } from './web_search/index.js'

export interface NetworkToolsOptions {
  /** Options for web_search (provider keys / model override). */
  webSearch?: WebSearchToolOptions
  /** Options for the main-session web_fetch (e.g. per-result budget). */
  webFetch?: WebFetchToolOptions
}

/**
 * The network category: web_fetch (read a URL) and web_search (discover URLs).
 *
 * Both ship by default. web_search used to be withheld here — "registered
 * separately when available" — and in practice the only place that registered
 * it was RoboticsSession. So every other surface (agentic, auto, graph, the CLI
 * REPL and single-turn paths) had web_fetch and no way to find anything to
 * fetch, while `GraphCatalog` listed `web_search` as an available capability
 * and the PaperSearchAgent prompt instructed the model to "use the web_search
 * tool — do NOT guess search-page URLs". The model was told to use a tool that
 * was not there, and guessing URLs is exactly what it fell back to.
 *
 * There is nothing to withhold: web_search needs no constructor credentials. It
 * resolves its provider chain at CALL time and, when nothing is configured,
 * returns a message naming what to set — strictly more useful than the tool
 * being absent.
 */
export async function createNetworkTools(options: NetworkToolsOptions = {}): Promise<MetaAgentTool[]> {
  return Promise.all([
    createWebFetchTool(options.webFetch),
    createWebSearchTool(options.webSearch),
  ])
}
