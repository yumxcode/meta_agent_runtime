import { loadToolPrompt } from '../../util.js';
import { mcpClients } from '../registry.js';
export async function createReadMcpResourceTool() {
    const description = await loadToolPrompt(import.meta.url);
    return {
        name: 'read_mcp_resource',
        description,
        isConcurrencySafe: true,
        inputSchema: {
            type: 'object',
            properties: {
                server_name: { type: 'string', description: 'MCP server name' },
                uri: { type: 'string', description: 'Resource URI' },
            },
            required: ['server_name', 'uri'],
        },
        async call(input, _ctx) {
            const serverName = input['server_name'];
            const uri = input['uri'];
            const client = mcpClients.get(serverName);
            if (!client)
                return { content: `MCP server "${serverName}" not found`, isError: true };
            if (!client.readResource)
                return { content: `Server "${serverName}" does not support reading resources`, isError: true };
            try {
                const result = await client.readResource(uri);
                const text = result.contents.filter(c => c.text).map(c => c.text).join('\n');
                return { content: text || '(empty resource)', isError: false };
            }
            catch (err) {
                return { content: `Error reading resource: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map