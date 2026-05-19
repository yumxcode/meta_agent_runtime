export { createWebFetchTool } from './web_fetch/index.js';
export { createWebSearchTool } from './web_search/index.js';
export type { WebSearchToolOptions } from './web_search/index.js';
import type { MetaAgentTool } from '../../core/types.js';
export interface NetworkToolsOptions {
    webSearch?: {
        apiKey?: string;
        model?: string;
    };
}
export declare function createNetworkTools(options?: NetworkToolsOptions): Promise<MetaAgentTool[]>;
//# sourceMappingURL=index.d.ts.map