import type { MetaAgentTool } from '../../../core/types.js';
export interface WebSearchToolOptions {
    apiKey?: string;
    model?: string;
}
export declare function createWebSearchTool(options?: WebSearchToolOptions): Promise<MetaAgentTool>;
//# sourceMappingURL=index.d.ts.map