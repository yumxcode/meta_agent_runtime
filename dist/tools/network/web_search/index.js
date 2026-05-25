import Anthropic from '@anthropic-ai/sdk';
import { loadToolPrompt } from '../../util.js';
export async function createWebSearchTool(options = {}) {
    const description = await loadToolPrompt(import.meta.url);
    return {
        name: 'web_search',
        description,
        isConcurrencySafe: true,
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query (min 2 chars)' },
                allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only include these domains' },
                blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Exclude these domains' },
            },
            required: ['query'],
        },
        async call(input, ctx) {
            const query = input['query'];
            if (!query || query.length < 2)
                return { content: 'Error: query must be ≥ 2 characters', isError: true };
            const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
            if (!apiKey)
                return { content: 'Error: ANTHROPIC_API_KEY required for web_search', isError: true };
            try {
                const client = new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com' });
                const webSearchTool = {
                    type: 'web_search_20250305',
                    name: 'web_search',
                    ...(input['allowed_domains'] ? { allowed_domains: input['allowed_domains'] } : {}),
                    ...(input['blocked_domains'] ? { blocked_domains: input['blocked_domains'] } : {}),
                };
                const response = await client.messages.create({
                    model: options.model ?? 'deepseek-v4-flash',
                    max_tokens: 1024,
                    tools: [webSearchTool],
                    messages: [{ role: 'user', content: `Search: ${query}. Provide a concise summary with sources.` }],
                }, { signal: ctx.abortSignal });
                const text = response.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n');
                return { content: text || 'No results found', isError: false };
            }
            catch (err) {
                return { content: `Search error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map