export interface McpClient {
  callTool(toolName: string, toolInput: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }> }>
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>
  listResources?(): Promise<Array<{ uri: string; name?: string; description?: string; mimeType?: string }>>
  readResource?(uri: string): Promise<{ contents: Array<{ uri: string; text?: string; blob?: string }> }>
}

export const mcpClients = new Map<string, McpClient>()

export function registerMcpClient(serverName: string, client: McpClient): void {
  mcpClients.set(serverName, client)
}

export function unregisterMcpClient(serverName: string): void {
  mcpClients.delete(serverName)
}

export function getRegisteredMcpServers(): string[] {
  return [...mcpClients.keys()]
}
