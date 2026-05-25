export { createWebFetchTool } from './web_fetch/index.js';
export { createWebSearchTool } from './web_search/index.js';
import { createWebFetchTool } from './web_fetch/index.js';
import { createWebSearchTool } from './web_search/index.js';
export async function createNetworkTools(options = {}) {
    return Promise.all([createWebFetchTool(), createWebSearchTool(options.webSearch)]);
}
//# sourceMappingURL=index.js.map