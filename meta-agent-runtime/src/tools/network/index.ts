export { createWebFetchTool } from './web_fetch/index.js'
export { createWebSearchTool } from './web_search/index.js'
export type { WebSearchToolOptions } from './web_search/index.js'
import type { MetaAgentTool } from '../../core/types.js'
import { createWebFetchTool } from './web_fetch/index.js'
import { createWebSearchTool } from './web_search/index.js'
export interface NetworkToolsOptions { webSearch?: { apiKey?: string; model?: string } }
export async function createNetworkTools(options: NetworkToolsOptions = {}): Promise<MetaAgentTool[]> {
  return Promise.all([createWebFetchTool(), createWebSearchTool(options.webSearch)])
}
