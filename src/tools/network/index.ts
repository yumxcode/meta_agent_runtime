export { createWebFetchTool } from './web_fetch/index.js'
export { createWebSearchTool } from './web_search/index.js'
export type { WebSearchToolOptions } from './web_search/index.js'
import type { MetaAgentTool } from '../../core/types.js'
import { createWebFetchTool } from './web_fetch/index.js'
import { createWebSearchTool } from './web_search/index.js'
import type { WebFetchToolOptions } from './web_fetch/index.js'
export interface NetworkToolsOptions {
  webSearch?: { apiKey?: string; model?: string }
  /** Options for the main-session web_fetch (e.g. per-result budget). */
  webFetch?: WebFetchToolOptions
}
export async function createNetworkTools(options: NetworkToolsOptions = {}): Promise<MetaAgentTool[]> {
  // web_search requires Anthropic API and is registered separately when available.
  // Only web_fetch is registered by default.
  return Promise.all([createWebFetchTool(options.webFetch)])
}
