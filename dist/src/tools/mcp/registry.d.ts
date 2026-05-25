export interface McpClient {
    callTool(toolName: string, toolInput: Record<string, unknown>): Promise<{
        content: Array<{
            type: string;
            text?: string;
        }>;
    }>;
    listTools(): Promise<Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
    }>>;
    listResources?(): Promise<Array<{
        uri: string;
        name?: string;
        description?: string;
        mimeType?: string;
    }>>;
    readResource?(uri: string): Promise<{
        contents: Array<{
            uri: string;
            text?: string;
            blob?: string;
        }>;
    }>;
}
export declare const mcpClients: Map<string, McpClient>;
export declare function registerMcpClient(serverName: string, client: McpClient): void;
export declare function unregisterMcpClient(serverName: string): void;
export declare function getRegisteredMcpServers(): string[];
//# sourceMappingURL=registry.d.ts.map